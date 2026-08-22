import type { ObservationEnvelope } from '../../domain';
import type { NormalizedModemObservation } from '../../observations';
import { normalizeZteObservation } from '../../observations/sources/zte';
import type {
	CapabilityReader,
	ProviderDefinition,
	ProviderExecutionContext,
	ProviderMatchRequest,
	ProviderOperationsSurface,
} from '../contracts';
import { parseZteRecord, ZteSessionRuntime } from './session';
import type { ZteTransport } from './transport';

export const ZTE_PATHS = {
	get: '/goform/goform_get_cmd_process',
	set: '/goform/goform_set_cmd_process',
} as const;
export const ZTE_EVIDENCE_CMD = 'LD,psw_fail_num_str,login_lock_time,wa_inner_version,cr_version';

export type ZteProfile = {
	readonly id: 'mf79u-legacy' | 'mf79u-ld-salted' | 'mf266-salted';
	readonly firmware: 'MF79U' | 'MF266';
	readonly algorithm: 'legacy-base64' | 'login-salted-sha256' | 'multi-user-salted-sha256';
};

export const ZTE_PROFILES = [
	{ id: 'mf79u-legacy', firmware: 'MF79U', algorithm: 'legacy-base64' },
	{ id: 'mf79u-ld-salted', firmware: 'MF79U', algorithm: 'login-salted-sha256' },
	{ id: 'mf266-salted', firmware: 'MF266', algorithm: 'multi-user-salted-sha256' },
] as const satisfies readonly ZteProfile[];
export const ZTE_UNKNOWN_PROFILE = 'zte-unknown-read-only';

export type ZteCredentials = { readonly username: string; readonly password: string };
export type ZteOptions = {
	readonly interfaceName: string;
	readonly adminUrl: string;
	readonly transport: ZteTransport;
	readonly credentials: ZteCredentials;
	readonly now?: () => number;
};

type ZteOperations = ProviderOperationsSurface;

export function zteProfilesForFirmware(firmware: string | undefined): readonly ZteProfile[] {
	return ZTE_PROFILES.filter((profile) => profile.firmware === firmware);
}

export function zteProfileById(profileId: string): ZteProfile | undefined {
	return ZTE_PROFILES.find((profile) => profile.id === profileId);
}

export class ZteGoformProvider extends ZteSessionRuntime {
	async fingerprint(request: ProviderMatchRequest) {
		const evidence = await this.probeEvidence(request);
		const matches = evidence !== undefined;
		return {
			signal: matches ? ('match' as const) : ('unknown' as const),
			strength: 'strong' as const,
			profiles: matches ? [evidence.profile?.id ?? ZTE_UNKNOWN_PROFILE] : [],
			detail: matches ? 'zte-goform-shape' : 'zte-goform-not-proven',
		};
	}

	capability(): CapabilityReader {
		return {
			id: 'zte-telemetry',
			read: async () => {
				const response = await this.get('network_type,signalbar,rssi,lte_rsrp,lte_rsrq,lte_snr');
				const supported = response.status === 200 && parseZteRecord(response.body) !== undefined;
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
		const response = await this.get(
			'network_type,signalbar,rssi,lte_rsrp,lte_rsrq,lte_snr,network_provider,cell_id',
			this.sessionCookie(context),
		);
		if (response.status !== 200) return [];
		return [
			normalizeZteObservation(
				{ body: response.body },
				{
					stableKey: `modem:${this.options.interfaceName}` as never,
					generation: context.generation,
					sourceEpoch: 1 as never,
					observedAt: (this.options.now?.() ?? Date.now()) as never,
				},
			),
		];
	}

	operations(_profile: string): ZteOperations {
		return { access: 'read-only' };
	}
}

export function createZteGoformDefinition(
	options: ZteOptions,
): ProviderDefinition<NormalizedModemObservation, ZteOperations> {
	const runtime = new ZteGoformProvider(options);
	return {
		id: 'zte-goform',
		profileVersion: '2',
		eligibleTransports: ['network'],
		passiveMatchers: ['MF79U', 'MF266'].map((firmware) => ({
			id: `firmware-${firmware}`,
			fact: 'firmware' as const,
			expected: [firmware],
			profiles: zteProfilesForFirmware(firmware).map((profile) => profile.id),
			strength: 'strong',
			required: true,
		})),
		unauthenticatedProbes: [
			{ id: 'zte-goform-shape', run: (request) => runtime.fingerprint(request) },
		],
		authenticatedProfile: {
			algorithm: 'evidence-selected-zte-goform',
			attemptLimit: 1,
			authenticate: (request, candidates) => runtime.authenticateProfile(request, candidates),
		},
		capabilityReaders: [runtime.capability()],
		observe: (context) => runtime.observe(context),
		operations: (profile) => runtime.operations(profile),
		contractFixtures: ZTE_PROFILES.map((profile) => ({
			profile: profile.id,
			request: {
				method: 'POST',
				path: ZTE_PATHS.set,
				goformId: profile.algorithm === 'multi-user-salted-sha256' ? 'LOGIN_MULTI_USER' : 'LOGIN',
				interfaceBound: true,
				redirects: 'disabled',
			},
			response:
				profile.algorithm === 'multi-user-salted-sha256'
					? { status: 'matched', sessionMaterial: '[redacted]', ad: '[redacted]' }
					: { status: 'matched', sessionMaterial: '[redacted]' },
		})),
	};
}
