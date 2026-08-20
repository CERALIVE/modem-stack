// Qualcomm UFI / HIMI — a READ-ONLY provider, by construction rather than by policy.
//
// This provider normalizes the telemetry the pure parsers already own
// (`hardware/router-parsers.ts` → `observations/sources/ufi.ts`, migrated in todo 17).
// It adds a session and a transport around them and nothing else: there is no write
// descriptor, no write command in the transport vocabulary, and no operation id outside
// the closed read set that resolves to anything but a typed refusal.
//
// The Qualcomm safety model it encodes lives in two neighbouring modules —
// `qualcomm-evidence.ts` (what a USB id proves) and `prohibitions.ts` (what may never be
// attempted). Both are inert data; neither can act.

import type { ObservationEnvelope } from '../../domain';
import { epochMillis, sourceEpoch, stableKeyFromPhysicalModemId } from '../../domain';
import { parseUfiDetails, parseUfiSignal } from '../../hardware/router-parsers';
import type { NormalizedModemObservation } from '../../observations';
import { normalizeUfiObservation } from '../../observations/sources/ufi';
import type {
	CapabilityReader,
	ProviderDefinition,
	ProviderExecutionContext,
	ProviderMatchRequest,
	ProviderOperationsSurface,
} from '../contracts';
import {
	planUfiOperation,
	UFI_PROFILE,
	type UfiOperationPlan,
	type UfiReadOperation,
	type UfiReadValue,
	ufiReadDescriptor,
	ufiReadResult,
	ufiRefusedResult,
} from './operations';
import { UFI_PROHIBITED_OPERATION_IDS, type UfiProhibitedOperationId } from './prohibitions';
import { UFI_DIAG_PRODUCTION_ACCESS, UFI_MATCHED_USB_IDS } from './qualcomm-evidence';
import { parseUfiReply, UFI_SESSION_REFUSAL, type UfiOptions, UfiSessionRuntime } from './session';
import { UFI_API_PATH, type UfiReadCommand } from './transport';

export type { UfiOptions } from './session';

/** One read cycle's bodies, keyed by the command that produced them. */
type UfiBodies = Partial<Record<UfiReadCommand, string>>;

export type UfiOperationsSurface = ProviderOperationsSurface & {
	readonly access: 'read-only';
	readonly reads: readonly UfiReadOperation[];
	readonly prohibited: readonly UfiProhibitedOperationId[];
	readonly diagAccess: typeof UFI_DIAG_PRODUCTION_ACCESS;
	readonly plan: (operationId: string) => UfiOperationPlan;
};

export class UfiHimiProvider extends UfiSessionRuntime {
	async fingerprint(request: ProviderMatchRequest) {
		// The HIMI fingerprint needs a SESSION to read anything, so this probe is the one
		// place a "harmless unauthenticated probe" would spend the provider's single
		// bounded login. On a device that enumerated a USB id and it is not a HIMI id,
		// that login would be aimed at somebody else's dongle — a credential attempt
		// against hardware this provider has positive evidence it does not own. An
		// ABSENT usb fact is still probed (nobody enumerated one; that is not a denial).
		if (!this.usbEvidencePermitsProbe(request)) {
			return {
				signal: 'unknown' as const,
				strength: 'strong' as const,
				profiles: [] as readonly string[],
				detail: 'usb-id-is-not-himi',
			};
		}
		const bodies = await this.fetch(request, ['getallstatus']);
		const reply = parseUfiReply(bodies?.getallstatus ?? '');
		const matched = reply?.reply === 'ok' && reply.params !== undefined;
		return {
			signal: matched ? ('match' as const) : ('unknown' as const),
			strength: 'strong' as const,
			profiles: matched ? [UFI_PROFILE] : [],
			detail: matched ? 'himi-json-shape' : 'himi-json-not-proven',
		};
	}

	capability(): CapabilityReader {
		return {
			id: 'ufi-himi-telemetry',
			read: async (context) => {
				const bodies = await this.fetch(context, ['getsysinfo']);
				const reply = parseUfiReply(bodies?.getsysinfo ?? '');
				const supported = reply?.reply === 'ok' && reply.params !== undefined;
				return {
					signal: supported ? 'match' : 'mismatch',
					strength: 'strong',
					detail: supported ? 'telemetry-reported' : 'telemetry-refused',
				};
			},
		};
	}

	async observe(
		context: ProviderExecutionContext,
	): Promise<readonly ObservationEnvelope<NormalizedModemObservation>[]> {
		const bodies = await this.fetch(context, [
			'getsysinfo',
			'getoverview',
			'getallstatus',
			'getproduceinfo',
		]);
		if (bodies === undefined) return [];
		const produceInfo = bodies.getproduceinfo;
		return [
			normalizeUfiObservation(
				{
					sysinfo: bodies.getsysinfo ?? '',
					overview: bodies.getoverview ?? '',
					status: bodies.getallstatus ?? '',
					...(produceInfo === undefined ? {} : { produceInfo }),
				},
				{
					stableKey: stableKeyFromPhysicalModemId(context.physicalModemId),
					generation: context.generation,
					sourceEpoch: sourceEpoch(1),
					observedAt: epochMillis(this.observedAt()),
				},
			),
		];
	}

	operations(_profile: string): UfiOperationsSurface {
		return {
			access: 'read-only',
			reads: [
				{
					descriptor: ufiReadDescriptor('ufi.signal.read'),
					read: (context) => this.readSignal(context),
				},
				{
					descriptor: ufiReadDescriptor('ufi.details.read'),
					read: (context) => this.readDetails(context),
				},
			],
			prohibited: UFI_PROHIBITED_OPERATION_IDS,
			diagAccess: UFI_DIAG_PRODUCTION_ACCESS,
			plan: planUfiOperation,
		};
	}

	private async readSignal(context: ProviderExecutionContext) {
		const bodies = await this.fetch(context, ['getsysinfo', 'getoverview', 'getallstatus']);
		if (bodies === undefined) return ufiRefusedResult(context.generation, 'session-unavailable');
		const value: UfiReadValue = parseUfiSignal({
			sysinfo: bodies.getsysinfo ?? '',
			overview: bodies.getoverview ?? '',
			status: bodies.getallstatus ?? '',
		});
		return ufiReadResult(context.generation, value);
	}

	private async readDetails(context: ProviderExecutionContext) {
		const bodies = await this.fetch(context, ['getoverview', 'getsysinfo', 'getproduceinfo']);
		if (bodies === undefined) return ufiRefusedResult(context.generation, 'session-unavailable');
		const details = parseUfiDetails({
			overview: bodies.getoverview ?? '',
			sysinfo: bodies.getsysinfo ?? '',
			produceInfo: bodies.getproduceinfo ?? '',
		});
		return details === undefined
			? ufiRefusedResult(context.generation, 'not-reported')
			: ufiReadResult(context.generation, details);
	}

	private usbEvidencePermitsProbe(request: ProviderMatchRequest): boolean {
		const enumerated = request.passiveFacts.filter((fact) => fact.kind === 'usb');
		return (
			enumerated.length === 0 ||
			enumerated.some((fact) => UFI_MATCHED_USB_IDS.some((id) => id === fact.value))
		);
	}

	/**
	 * Reads are issued sequentially on ONE session. A `SessionOut` in any body drops the
	 * cached session so the NEXT generation may spend its own single login; it never
	 * re-authenticates inside this cycle.
	 */
	private async fetch(
		request: ProviderMatchRequest,
		commands: readonly UfiReadCommand[],
	): Promise<UfiBodies | undefined> {
		const session = await this.session(request);
		if (session === undefined) return undefined;
		const bodies: UfiBodies = {};
		for (const command of commands) {
			const response = await this.read(command, session);
			bodies[command] = response.status === 200 ? response.body : '';
		}
		const refused = Object.values(bodies).some(
			(body) => parseUfiReply(body)?.reply === UFI_SESSION_REFUSAL,
		);
		if (refused) this.forgetSession(request);
		return bodies;
	}
}

export function createUfiHimiDefinition(
	options: UfiOptions,
): ProviderDefinition<NormalizedModemObservation, UfiOperationsSurface> {
	const runtime = new UfiHimiProvider(options);
	return {
		id: 'ufi-himi',
		profileVersion: '1',
		eligibleTransports: ['network'],
		passiveMatchers: [
			{
				// ONE matcher over both ids. `9024` is the RNDIS+ADB composition and `9091` is
				// a firmware-chosen product id; both identify a HIMI stick, and NEITHER is
				// evidence of a DIAG channel (see qualcomm-evidence.ts).
				id: 'usb-qualcomm-himi',
				fact: 'usb',
				expected: UFI_MATCHED_USB_IDS,
				profiles: [UFI_PROFILE],
				strength: 'strong',
				required: true,
			},
		],
		unauthenticatedProbes: [
			{ id: 'ufi-himi-shape', run: (request) => runtime.fingerprint(request) },
		],
		capabilityReaders: [runtime.capability()],
		observe: (context) => runtime.observe(context),
		operations: (profile) => runtime.operations(profile),
		contractFixtures: [
			{
				profile: UFI_PROFILE,
				request: {
					method: 'POST',
					path: UFI_API_PATH,
					cmdid: 'login',
					credentials: '[redacted]',
					interfaceBound: true,
					redirects: 'disabled',
				},
				response: { reply: 'ok', session: '[redacted]' },
			},
			{
				profile: UFI_PROFILE,
				request: {
					method: 'POST',
					path: UFI_API_PATH,
					cmdid: 'getsysinfo',
					authorization: '[redacted]',
					interfaceBound: true,
					redirects: 'disabled',
				},
				response: { reply: 'ok', params: '[verbatim-diagnostics]' },
			},
		],
	};
}
