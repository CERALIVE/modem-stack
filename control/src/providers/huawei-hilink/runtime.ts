import type { ObservationEnvelope, OperationResult } from '../../domain';
import {
	parseHilinkCapabilities,
	parseHilinkDataCapability,
	parseHilinkSession,
	parseHilinkXmlValue,
} from '../../hardware/router-parsers';
import type { HilinkObservationInput } from '../../observations/sources/hilink';
import { normalizeHilinkObservation } from '../../observations/sources/hilink';
import type {
	AuthenticatedProfileResult,
	CapabilityReader,
	ProviderExecutionContext,
	ProviderMatchRequest,
} from '../contracts';
import {
	applied,
	capabilityPath,
	operationDescriptor,
	type ReadOperation,
	type ReadValue,
	readbackMatches,
	refused,
	requestSucceeded,
	type WriteOperation,
	writeDocument,
} from './operations';
import {
	HILINK_PATHS,
	HILINK_PROFILES,
	type HilinkObservation,
	type HilinkProfile,
	type HuaweiOperations,
	hilinkProfile,
} from './provider';
import { type HilinkSession, HilinkSessionRuntime } from './session';

export type { ReadOperation, WriteOperation } from './operations';

export class HuaweiProvider extends HilinkSessionRuntime {
	async sessionProbe(request: ProviderMatchRequest) {
		const profile = HILINK_PROFILES.find((candidate) => candidate.firmware === request.firmware);
		const response = await this.request('GET', HILINK_PATHS.session);
		const matches = response.status === 200 && parseHilinkSession(response.body) !== undefined;
		return {
			signal: matches && profile !== undefined ? ('match' as const) : ('unknown' as const),
			strength: 'strong' as const,
			profiles: profile === undefined ? [] : [profile.id],
			detail: matches ? 'session-token-evidence' : 'session-token-not-proven',
		};
	}

	async authenticateProfile(
		request: ProviderMatchRequest,
		candidates: readonly string[],
	): Promise<AuthenticatedProfileResult> {
		const candidate = candidates.length === 1 ? hilinkProfile(candidates[0] ?? '') : undefined;
		if (candidate === undefined) return { status: 'refused', detail: 'profile-mismatch' };
		const result = await this.authenticate(request, candidate, true);
		if (result.status === 'ready')
			return { status: 'matched', profile: candidate.id, detail: 'login-ok' };
		return {
			status: result.reason === 'unreachable' ? 'unavailable' : 'refused',
			detail: result.reason,
		};
	}

	async observe(
		context: ProviderExecutionContext,
	): Promise<readonly ObservationEnvelope<HilinkObservation>[]> {
		const ready = await this.sessionFor(context);
		if (ready === undefined) return [];
		const [status, signal, modeList, mode] = await Promise.all([
			this.getResponse(HILINK_PATHS.status, ready),
			this.getResponse(HILINK_PATHS.signal, ready),
			this.getResponse(HILINK_PATHS.modeList, ready),
			this.getResponse(HILINK_PATHS.mode, ready),
		]);
		const input: HilinkObservationInput = {
			status: status.body,
			signal: signal.body,
			netModeList: modeList.body,
			netMode: mode.body,
		};
		return [
			normalizeHilinkObservation(input, {
				stableKey: `modem:${this.options.interfaceName}` as never,
				generation: context.generation,
				sourceEpoch: 1 as never,
				observedAt: (this.options.now?.() ?? Date.now()) as never,
			}),
		];
	}

	capability(kind: 'status' | 'signal' | 'mode' | 'data'): CapabilityReader {
		return {
			id: `hilink-${kind}`,
			read: async (context) => {
				const session = await this.sessionFor(context);
				if (session === undefined)
					return { signal: 'unknown', strength: 'strong', detail: 'session-unavailable' };
				const path = capabilityPath(kind);
				const response = await this.getResponse(path, session);
				const supported =
					this.capabilitySupported(kind, response.body) && !this.authExpired(response);
				return {
					signal: supported ? 'match' : 'mismatch',
					strength: 'strong',
					detail: supported ? 'capability-reported' : 'capability-refused',
				};
			},
		};
	}

	operations(profileId: string): HuaweiOperations {
		const profile = hilinkProfile(profileId);
		if (profile === undefined) return unsupportedOperations(profileId);
		return {
			access: 'read-write',
			status: this.readOperation('status', HILINK_PATHS.status, profile),
			signal: this.readOperation('signal', HILINK_PATHS.signal, profile),
			mode: this.writeOperation('mode', HILINK_PATHS.mode, profile),
			data: this.writeOperation('data', HILINK_PATHS.data, profile),
		};
	}

	private async sessionFor(context: ProviderExecutionContext): Promise<HilinkSession | undefined> {
		const cached = this.cachedSession(context);
		if (cached !== undefined) return cached;
		const profile = hilinkProfile(context.profile);
		if (profile === undefined) return undefined;
		const result = await this.authenticate(context, profile, true);
		return result.status === 'ready' ? result.session : undefined;
	}

	private capabilitySupported(kind: string, body: string): boolean {
		if (kind === 'mode')
			return parseHilinkCapabilities({ netModeList: body }).net_mode.state === 'reported';
		if (kind === 'data') return parseHilinkDataCapability(body).state === 'reported';
		return parseHilinkXmlValue(body, 'code') === undefined && /<response>/i.test(body);
	}

	private readOperation(id: string, path: string, profile: HilinkProfile): ReadOperation {
		return {
			descriptor: operationDescriptor<never>(id, false, profile),
			read: async (context) => {
				const result = await this.authenticate(context, profile, false);
				if (result.status === 'refused') return refused(context.generation, result.reason);
				const response = await this.getResponse(path, result.session);
				if (this.authExpired(response)) return refused(context.generation, 'auth-expired');
				if (response.status < 200 || response.status >= 300)
					return refused(context.generation, 'http-failure');
				return applied(context.generation, { body: response.body });
			},
		};
	}

	private writeOperation(
		id: 'mode' | 'data',
		path: string,
		profile: HilinkProfile,
	): WriteOperation {
		return {
			descriptor: operationDescriptor<string | boolean>(id, true, profile),
			read: this.readOperation(`${id}-read`, path, profile).read,
			write: (context, value) => this.write(context, profile, id, path, value),
		};
	}

	private async write(
		context: ProviderExecutionContext,
		profile: HilinkProfile,
		kind: 'mode' | 'data',
		path: string,
		value: string | boolean,
	): Promise<OperationResult<ReadValue>> {
		return this.withDevice(context, async () => {
			const ownership = await this.options.ownership.acquire({ resource: 'router-session' });
			if (ownership.status === 'refused') return refused(context.generation, 'busy');
			try {
				const ready = await this.authenticate(context, profile, false);
				if (ready.status === 'refused') return refused(context.generation, ready.reason);
				const capabilityPath = kind === 'mode' ? HILINK_PATHS.modeList : HILINK_PATHS.data;
				const capability = await this.getResponse(capabilityPath, ready.session);
				if (this.authExpired(capability)) return refused(context.generation, 'auth-expired');
				if (!this.capabilitySupported(kind, capability.body))
					return refused(context.generation, 'capability-unavailable');
				if (kind === 'mode') {
					const offered = parseHilinkCapabilities({ netModeList: capability.body }).net_mode;
					if (
						offered.state !== 'reported' ||
						!offered.modes.some((mode) => mode.id === String(value))
					)
						return refused(context.generation, 'capability-unavailable');
				}
				const body = writeDocument(kind, value);
				const posted = await this.postResponse(path, body, ready.session);
				if (this.authExpired(posted)) return refused(context.generation, 'auth-expired');
				if (!requestSucceeded(posted.status, posted.body))
					return refused(context.generation, 'http-failure');
				const fresh = await this.authenticate(context, profile, false);
				if (fresh.status === 'refused') return refused(context.generation, fresh.reason);
				const readback = await this.getResponse(path, fresh.session);
				if (this.authExpired(readback)) return refused(context.generation, 'auth-expired');
				const matches = readbackMatches(kind, readback.body, value);
				return matches
					? applied(context.generation, { body: readback.body })
					: refused(context.generation, 'not-applied');
			} finally {
				await ownership.lease.release();
			}
		});
	}
}

function unsupportedOperations(_profileId: string): HuaweiOperations {
	throw new Error('unsupported-hilink-profile');
}
