import type { NormalizedModemObservation } from '../../observations';
import type { ResourceOwnershipPort } from '../../ports/resource-ownership';
import type { ProviderDefinition, ProviderOperationsSurface } from '../contracts';
import { HuaweiProvider, type ReadOperation, type WriteOperation } from './runtime';
import type { HilinkTransport } from './transport';

export const HILINK_PATHS = {
	session: '/api/webserver/SesTokInfo',
	loginState: '/api/user/state-login',
	login: '/api/user/login',
	status: '/api/monitoring/status',
	signal: '/api/device/signal',
	modeList: '/api/net/net-mode-list',
	mode: '/api/net/net-mode',
	data: '/api/dialup/mobile-dataswitch',
} as const;

export type HilinkProfile = {
	readonly id: string;
	readonly firmware: string;
	readonly passwordType: 3 | 4;
};

export const HILINK_PROFILES = [
	{
		id: 'e3372h-22.200-password-type-3',
		firmware: '22.200.05.00.1080',
		passwordType: 3,
	},
	{
		id: 'e3372h-22.333-password-type-4',
		firmware: '22.333.01.00.00',
		passwordType: 4,
	},
] as const satisfies readonly HilinkProfile[];

export type HilinkCredentials = {
	readonly username: string;
	readonly password: string;
};
export type HilinkOptions = {
	readonly interfaceName: string;
	readonly adminUrl: string;
	readonly transport: HilinkTransport;
	readonly ownership: ResourceOwnershipPort;
	readonly credentials: HilinkCredentials;
	readonly now?: () => number;
};
export type HilinkObservation = NormalizedModemObservation;
export type HuaweiOperations = ProviderOperationsSurface & {
	readonly status: ReadOperation;
	readonly signal: ReadOperation;
	readonly mode: WriteOperation;
	readonly data: WriteOperation;
};

export function hilinkProfile(profileId: string): HilinkProfile | undefined {
	return HILINK_PROFILES.find((profile) => profile.id === profileId);
}

export function createHuaweiHiLinkProvider(options: HilinkOptions): HuaweiProvider {
	return new HuaweiProvider(options);
}

export function createHuaweiHiLinkDefinition(
	options: HilinkOptions,
): ProviderDefinition<HilinkObservation, HuaweiOperations> {
	const runtime = createHuaweiHiLinkProvider(options);
	return {
		id: 'huawei-hilink',
		profileVersion: '1',
		eligibleTransports: ['network'],
		passiveMatchers: HILINK_PROFILES.map((profile) => ({
			id: `firmware-${profile.firmware}`,
			fact: 'firmware',
			expected: [profile.firmware],
			profiles: [profile.id],
			strength: 'strong',
			required: true,
		})),
		unauthenticatedProbes: [
			{
				id: 'hilink-session-shape',
				run: (request) => runtime.sessionProbe(request),
			},
		],
		authenticatedProfile: {
			algorithm: 'firmware-selected-hilink-password',
			attemptLimit: 1,
			authenticate: (request, candidates) => runtime.authenticateProfile(request, candidates),
		},
		capabilityReaders: [
			runtime.capability('status'),
			runtime.capability('signal'),
			runtime.capability('mode'),
			runtime.capability('data'),
		],
		observe: (context) => runtime.observe(context),
		operations: (profile) => runtime.operations(profile),
		contractFixtures: HILINK_PROFILES.map((profile) => ({
			profile: profile.id,
			request: {
				method: 'POST',
				path: HILINK_PATHS.login,
				passwordType: profile.passwordType,
				interfaceBound: true,
				redirects: 'disabled',
			},
			response: { status: 'matched', sessionMaterial: '[redacted]' },
		})),
	};
}

export { HuaweiProvider as HuaweiHiLinkProvider };
