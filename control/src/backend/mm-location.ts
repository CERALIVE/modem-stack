// The `Modem.Location` adapter — GNSS status, enable/disable, and the current fix.
//
// Three decisions here are load-bearing and easy to undo by accident:
//
//   1. `Setup`'s `signal_location` argument is ALWAYS false. Passing true makes MM
//      broadcast the `Location` property over `PropertiesChanged`, which would put
//      the operator's coordinates on the system bus for every listener — including
//      this package's own observer, whose snapshots are logged. The fix is fetched
//      by an explicit `GetLocation` call instead, so a coordinate only ever exists
//      where someone asked for it.
//   2. GNSS runs through `actor.run`, NOT `actor.runQuiesced`. Quiescing exists to
//      stop NetworkManager racing a disruptive change, and it costs a bearer
//      deactivation — on a bonded device, dropping a link to switch a GPS receiver
//      on would be an absurd trade. `Modem.Location.Setup` touches no bearer, so
//      serialization per modem is all that is needed.
//   3. Disable CLEARS only the GNSS bits. `3gpp-lac-ci` is the cell-info module's
//      source; blanking the whole mask would silently switch off a neighbouring
//      feature the operator never touched.

import { epochMillis } from '../domain';
import { parseNmeaFix } from '../location/nmea';
import type {
	FixRead,
	GnssFix,
	GnssSource,
	LocationStatus,
	LocationStatusResult,
	LocationToggleResult,
	ModemLocationPort,
	ModemRef,
} from '../ports';
import { hasGnssSource } from '../ports';
import type { DbusTransport, DbusValue, DbusVariant } from '../transport';
import { MM_BUS_NAME, MODEM_LOCATION_IFACE } from './constants';
import {
	type DecodedProps,
	fetchManagedObjects,
	findInterface,
	propValue,
} from './managed-objects';
import type { ModemActor } from './modem-actor';

/** MMModemLocationSource bits, by decoded source name. */
const SOURCE_BIT: Record<string, number> = {
	'3gpp-lac-ci': 1 << 0,
	'gps-raw': 1 << 1,
	'gps-nmea': 1 << 2,
	'cdma-bs': 1 << 3,
	'gps-unmanaged': 1 << 4,
	'agps-msa': 1 << 5,
	'agps-msb': 1 << 6,
};

const GPS_RAW_BIT = SOURCE_BIT['gps-raw'] as number;
const GPS_NMEA_BIT = SOURCE_BIT['gps-nmea'] as number;

const GNSS_MASK =
	GPS_RAW_BIT |
	GPS_NMEA_BIT |
	(SOURCE_BIT['gps-unmanaged'] as number) |
	(SOURCE_BIT['agps-msa'] as number) |
	(SOURCE_BIT['agps-msb'] as number);

/** Decode an MMModemLocationSource bitmask into source names. */
export function decodeLocationSources(mask: number): ReadonlySet<string> {
	const sources = new Set<string>();
	for (const [name, bit] of Object.entries(SOURCE_BIT)) {
		if ((mask & bit) !== 0) {
			sources.add(name);
		}
	}
	return sources;
}

export function encodeLocationSources(sources: Iterable<string>): number {
	let mask = 0;
	for (const source of sources) {
		mask |= SOURCE_BIT[source] ?? 0;
	}
	return mask;
}

export interface MmLocationDeps {
	readonly transport: DbusTransport;
	readonly actor: ModemActor;
	readonly destination?: string;
	readonly resolveStableKey: (modem: ModemRef) => string;
	readonly now?: () => number;
}

export class MmLocation implements ModemLocationPort {
	readonly #transport: DbusTransport;
	readonly #actor: ModemActor;
	readonly #destination: string;
	readonly #resolveStableKey: (modem: ModemRef) => string;
	readonly #now: () => number;

	constructor(deps: MmLocationDeps) {
		this.#transport = deps.transport;
		this.#actor = deps.actor;
		this.#destination = deps.destination ?? MM_BUS_NAME;
		this.#resolveStableKey = deps.resolveStableKey;
		this.#now = deps.now ?? Date.now;
	}

	async getLocationStatus(modem: ModemRef): Promise<LocationStatusResult> {
		const props = await this.#readLocationProps(modem);
		if (props === undefined) {
			return { ok: false, reason: 'the modem does not expose a Location interface' };
		}
		return { ok: true, status: statusOf(props) };
	}

	enableGnss(modem: ModemRef, sources: readonly GnssSource[]): Promise<LocationToggleResult> {
		return this.#actor.run(this.#resolveStableKey(modem), async () => {
			const props = await this.#readLocationProps(modem);
			if (props === undefined) {
				return refused('the modem does not expose a Location interface');
			}
			const status = statusOf(props);
			if (!status.gnssCapable) {
				return refused('the modem advertises no GNSS source', status.enabledSources);
			}
			const requested = encodeLocationSources(sources) & maskOfNames(status.capabilities);
			if (requested === 0) {
				return refused(
					'none of the requested GNSS sources is advertised by this modem',
					status.enabledSources,
				);
			}
			const target = maskOfNames(status.enabledSources) | requested;
			return this.#setup(modem, target, 'GNSS enabled');
		});
	}

	disableGnss(modem: ModemRef): Promise<LocationToggleResult> {
		return this.#actor.run(this.#resolveStableKey(modem), async () => {
			const props = await this.#readLocationProps(modem);
			if (props === undefined) {
				return refused('the modem does not expose a Location interface');
			}
			const status = statusOf(props);
			const target = maskOfNames(status.enabledSources) & ~GNSS_MASK;
			return this.#setup(modem, target, 'GNSS disabled');
		});
	}

	async readFix(modem: ModemRef): Promise<FixRead> {
		const props = await this.#readLocationProps(modem);
		if (props === undefined) {
			return { outcome: 'unsupported', reason: 'the modem does not expose a Location interface' };
		}
		const status = statusOf(props);
		if (!status.gnssCapable) {
			return { outcome: 'unsupported', reason: 'the modem advertises no GNSS source' };
		}
		if (!status.gnssEnabled) {
			return { outcome: 'disabled', reason: 'GNSS is switched off on this modem' };
		}
		let reply: { readonly body: readonly DbusValue[] };
		try {
			reply = await this.#transport.callMethod({
				destination: this.#destination,
				path: modem,
				interface: MODEM_LOCATION_IFACE,
				member: 'GetLocation',
			});
		} catch (error) {
			return { outcome: 'error', reason: `GetLocation failed: ${describe(error)}` };
		}
		const fix = decodeFix(reply.body[0], epochMillis(this.#now()));
		return fix === undefined
			? { outcome: 'no-fix', reason: 'the receiver has not acquired a position' }
			: { outcome: 'fix', fix };
	}

	async #setup(
		modem: ModemRef,
		mask: number,
		appliedReason: string,
	): Promise<LocationToggleResult> {
		try {
			await this.#transport.callMethod({
				destination: this.#destination,
				path: modem,
				interface: MODEM_LOCATION_IFACE,
				member: 'Setup',
				signature: 'ub',
				args: [mask, false],
			});
		} catch (error) {
			return {
				outcome: 'failed',
				reason: `Location.Setup failed: ${describe(error)}`,
				enabledSources: new Set<string>(),
			};
		}
		return {
			outcome: 'applied',
			reason: appliedReason,
			enabledSources: decodeLocationSources(mask),
		};
	}

	async #readLocationProps(modem: ModemRef): Promise<DecodedProps | undefined> {
		try {
			const tree = await fetchManagedObjects(this.#transport, this.#destination);
			return findInterface(tree, modem, MODEM_LOCATION_IFACE);
		} catch {
			return undefined;
		}
	}
}

function maskOfNames(names: Iterable<string>): number {
	return encodeLocationSources(names);
}

function refused(reason: string, enabled: ReadonlySet<string> = new Set()): LocationToggleResult {
	return { outcome: 'unsupported', reason, enabledSources: enabled };
}

function statusOf(props: DecodedProps): LocationStatus {
	const capabilities = decodeLocationSources(maskProp(props, 'Capabilities'));
	const enabledSources = decodeLocationSources(maskProp(props, 'Enabled'));
	return {
		capabilities,
		enabledSources,
		gnssCapable: hasGnssSource(capabilities),
		gnssEnabled: hasGnssSource(enabledSources),
	};
}

function maskProp(props: DecodedProps, name: string): number {
	const value = propValue(props, name);
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** `a{uv}` decodes to `[sourceBit, variant][]`. */
type LocationEntries = ReadonlyArray<readonly [number, DbusVariant]>;

function entryValue(payload: DbusValue | undefined, bit: number): DbusValue | undefined {
	if (!Array.isArray(payload)) {
		return undefined;
	}
	for (const entry of payload as unknown as LocationEntries) {
		if (Number(entry[0]) === bit) {
			return entry[1]?.value;
		}
	}
	return undefined;
}

function numberField(props: DecodedProps, name: string): number | undefined {
	const value = propValue(props, name);
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Prefer MM's pre-decoded `gps-raw` dict; fall back to parsing the `gps-nmea`
 * sentences. A raw entry that is present but carries no usable coordinate pair is
 * NOT treated as a fix — MM populates the key as soon as the source is on.
 */
function decodeFix(
	payload: DbusValue | undefined,
	observedAt: GnssFix['observedAt'],
): GnssFix | undefined {
	const raw = entryValue(payload, GPS_RAW_BIT);
	if (Array.isArray(raw)) {
		const props = raw as unknown as DecodedProps;
		const latitude = numberField(props, 'latitude');
		const longitude = numberField(props, 'longitude');
		if (latitude !== undefined && longitude !== undefined) {
			const altitude = numberField(props, 'altitude');
			const utcTime = propValue(props, 'utc-time');
			return {
				latitude,
				longitude,
				...(altitude === undefined ? {} : { altitude }),
				...(typeof utcTime === 'string' ? { utcTime } : {}),
				observedAt,
			};
		}
	}
	const nmea = entryValue(payload, GPS_NMEA_BIT);
	if (typeof nmea !== 'string') {
		return undefined;
	}
	const parsed = parseNmeaFix(nmea);
	return parsed === undefined ? undefined : { ...parsed, observedAt };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
