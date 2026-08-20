// The GNSS location port — ModemManager's `Modem.Location` interface, scoped by a
// privacy fence that is a PRODUCT rule, not a phase limitation.
//
// THE FENCE: this port reads the CURRENT fix and nothing else. There is no history
// verb, no track verb, no export verb, and no upload verb, and none may ever be
// added — a fix is held in memory for a live display and is gone the moment GNSS is
// disabled or the fix goes stale. `location-fence.test.ts` fails the build if a
// member whose name implies history, tracking, persistence, or upload appears here.
//
// A fix also carries coordinates, which say where the operator physically is. That
// class is redacted by `../redact` (`latitude` / `longitude` / `altitude` / `nmea`),
// so a fix that reaches a log line or a receipt comes out as the redaction marker
// rather than a position.

import type { EpochMillis } from '../domain';
import type { ModemRef } from './modem-manager';

/**
 * The GNSS sources `Modem.Location.Capabilities` can advertise, as decoded source
 * names. `3gpp-lac-ci` is deliberately absent: coarse cell location is the cell-info
 * module's surface, and MM advertises it on devices with no GNSS receiver at all.
 */
export const GNSS_SOURCES = [
	'gps-raw',
	'gps-nmea',
	'gps-unmanaged',
	'agps-msa',
	'agps-msb',
] as const;
export type GnssSource = (typeof GNSS_SOURCES)[number];

/** What `Modem.Location` advertises and what is switched on right now. */
export interface LocationStatus {
	/** Every source name in `Capabilities`, GNSS or not (`3gpp-lac-ci` included). */
	readonly capabilities: ReadonlySet<string>;
	/** Every source name in `Enabled`. */
	readonly enabledSources: ReadonlySet<string>;
	/** True when at least one GNSS source is advertised. */
	readonly gnssCapable: boolean;
	/** True when at least one GNSS source is switched on. */
	readonly gnssEnabled: boolean;
}

export type LocationStatusResult =
	| { readonly ok: true; readonly status: LocationStatus }
	| { readonly ok: false; readonly reason: string };

/**
 * One GNSS fix. SENSITIVE: never persist it, never upload it, never put it in a log
 * line. `observedAt` is when this process READ the fix, which is what staleness is
 * measured against — a modem's own `utc-time` cannot be trusted to advance.
 */
export interface GnssFix {
	readonly latitude: number;
	readonly longitude: number;
	readonly altitude?: number;
	readonly utcTime?: string;
	readonly observedAt: EpochMillis;
}

/**
 * The outcome of ONE read attempt. `no-fix` is a first-class success: the modem
 * answered and has not acquired a position. It is never conflated with an error and
 * never answered with a previous fix — a stale coordinate rendered as current is the
 * one failure mode this module exists to prevent.
 */
export type FixRead =
	| { readonly outcome: 'fix'; readonly fix: GnssFix }
	| { readonly outcome: 'no-fix'; readonly reason: string }
	| { readonly outcome: 'disabled'; readonly reason: string }
	| { readonly outcome: 'unsupported'; readonly reason: string }
	| { readonly outcome: 'error'; readonly reason: string };

/**
 * The outcome of switching GNSS on or off. Modelled like `SimUnlockResult` rather
 * than as a reconcile `Receipt`: GNSS is an operator-invoked, gate-defaulted-off
 * action with no desired-state dimension, so it is not something the planner
 * converges.
 */
export interface LocationToggleResult {
	readonly outcome: 'applied' | 'unsupported' | 'failed';
	readonly reason: string;
	/** The GNSS sources enabled after the call — empty after a successful disable. */
	readonly enabledSources: ReadonlySet<string>;
}

/**
 * Read GNSS status, switch GNSS on/off, and read the current fix.
 *
 * Deliberately NOT part of `ModemManagerPort`: a consumer that only reconciles
 * radio and SIM state has no business holding a handle that can read a position.
 */
export interface ModemLocationPort {
	getLocationStatus(modem: ModemRef): Promise<LocationStatusResult>;
	enableGnss(modem: ModemRef, sources: readonly GnssSource[]): Promise<LocationToggleResult>;
	disableGnss(modem: ModemRef): Promise<LocationToggleResult>;
	readFix(modem: ModemRef): Promise<FixRead>;
}

export function isGnssSource(value: string): value is GnssSource {
	return (GNSS_SOURCES as readonly string[]).includes(value);
}

export function hasGnssSource(sources: Iterable<string>): boolean {
	for (const source of sources) {
		if (isGnssSource(source)) {
			return true;
		}
	}
	return false;
}
