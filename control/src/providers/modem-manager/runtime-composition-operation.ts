import {
	AtCommandLease,
	type AtCommandSender,
	computeAtAllowlist,
	type UsbModeTransitionOutcome,
} from '../../backend';
import {
	classifyOperationCompletion,
	defineOperationDescriptor,
	type OperationDescriptor,
	type OperationResult,
} from '../../domain';
import {
	isRuntimeCompositionVendor,
	RUNTIME_COMPOSITION_QUERY_REGISTRY,
	type RuntimeCompositionCapability,
	type RuntimeCompositionMode,
	resolveRuntimeCompositionCapability,
} from '../../usb-mode';
import type { ProviderExecutionContext } from '../contracts';
import type { ContextWriteOperation } from './types';

export const RUNTIME_COMPOSITION_SUPPRESSIONS = [
	'unknown-vendor',
	'no-return-path',
	'blocked-by-state',
	'provisioning-disabled',
] as const;
export type RuntimeCompositionSuppression = (typeof RUNTIME_COMPOSITION_SUPPRESSIONS)[number];

export type RuntimeCompositionState =
	| {
			readonly status: 'available';
			readonly current: RuntimeCompositionMode;
			readonly enumerated: readonly RuntimeCompositionMode[];
			readonly offerable: readonly RuntimeCompositionMode[];
	  }
	| {
			readonly status: 'suppressed';
			readonly reason: RuntimeCompositionSuppression;
			readonly detail: string;
			readonly current: RuntimeCompositionMode | null;
			readonly enumerated: readonly RuntimeCompositionMode[];
			readonly offerable: readonly [];
	  };

export type RuntimeCompositionOperationDeps = {
	readonly vendor: (context: ProviderExecutionContext) => string | Promise<string>;
	readonly provisioningEnabled: (context: ProviderExecutionContext) => boolean | Promise<boolean>;
	readonly blockedReason: (
		context: ProviderExecutionContext,
	) => string | undefined | Promise<string | undefined>;
	readonly atSender: AtCommandSender;
	readonly transition: (
		context: ProviderExecutionContext,
		capability: Extract<RuntimeCompositionCapability, { readonly status: 'available' }>,
		target: RuntimeCompositionMode,
	) => Promise<UsbModeTransitionOutcome>;
};

export interface RuntimeCompositionOperation
	extends ContextWriteOperation<RuntimeCompositionMode, RuntimeCompositionState> {
	capability(context: ProviderExecutionContext): Promise<RuntimeCompositionState>;
}

const OPERATION_ID = 'modemmanager.usb-composition';

function suppressed(
	reason: RuntimeCompositionSuppression,
	detail: string,
	capability?: RuntimeCompositionCapability,
): RuntimeCompositionState {
	return {
		status: 'suppressed',
		reason,
		detail,
		current: capability?.current ?? null,
		enumerated: capability?.enumerated ?? [],
		offerable: [],
	};
}

function descriptorFor(
	state: RuntimeCompositionState,
): OperationDescriptor<RuntimeCompositionMode, RuntimeCompositionState> {
	const available = state.status === 'available';
	return defineOperationDescriptor({
		id: OPERATION_ID,
		support: {
			read: { supported: true },
			write: available ? { supported: true } : { supported: false, reason: state.reason },
		},
		authority: 'provider',
		provider: 'modemmanager',
		constraints: {
			kind: 'allowed-values',
			values: available ? state.offerable : [],
		},
		livePreconditions: [
			'modem-present',
			'runtime-interface-present',
			'identity-confident',
			'streaming-interlock-open',
		],
		availability: available ? { state: 'available' } : { state: 'refused', reason: state.reason },
		mutationImpact: 'disruptive',
		retryClass: 'never',
		readback: {
			required: true,
			reason: 'device-reported-composition',
			matches: (input, value) => value.status === 'available' && Object.is(input, value.current),
		},
		rollback: { required: true, reason: 'restore-previous-composition' },
		journal: { required: true, reason: 'composition-reenumeration' },
		admission: { required: true, reason: 'provider-mutation' },
		evidence: { profiles: ['generic-mm'], firmware: [] },
		confidence: available ? 'high' : 'unknown',
	});
}

function result<O>(
	context: ProviderExecutionContext,
	completion:
		| { readonly status: 'applied'; readonly value: O }
		| { readonly status: 'refused' | 'failed'; readonly reason: string },
): OperationResult<O> {
	return classifyOperationCompletion({
		operation: 'write',
		completionGeneration: context.generation,
		currentGeneration: context.generation,
		completion,
	});
}

function disabledOperation(): RuntimeCompositionOperation {
	const state: Extract<RuntimeCompositionState, { status: 'suppressed' }> = {
		status: 'suppressed',
		reason: 'provisioning-disabled',
		detail: 'USB composition provisioning is not configured',
		current: null,
		enumerated: [],
		offerable: [],
	};
	const descriptor = descriptorFor(state);
	return {
		descriptor,
		describe: () => Promise.resolve(descriptor),
		capability: () => Promise.resolve(state),
		read: (context) => Promise.resolve(result(context, { status: 'applied', value: state })),
		write: (context) =>
			Promise.resolve(
				result<RuntimeCompositionState>(context, { status: 'refused', reason: state.reason }),
			),
	};
}

export function createRuntimeCompositionOperation(
	deps: RuntimeCompositionOperationDeps | undefined,
): RuntimeCompositionOperation {
	if (deps === undefined) return disabledOperation();

	const capability = async (
		context: ProviderExecutionContext,
	): Promise<RuntimeCompositionState> => {
		const vendor = (await deps.vendor(context)).trim().toLowerCase();
		if (!isRuntimeCompositionVendor(vendor))
			return suppressed('unknown-vendor', `No reviewed composition query exists for ${vendor}`);
		if (!(await deps.provisioningEnabled(context)))
			return suppressed('provisioning-disabled', 'USB composition provisioning is disabled');
		const blocked = await deps.blockedReason(context);
		if (blocked !== undefined) return suppressed('blocked-by-state', blocked);

		const queries = RUNTIME_COMPOSITION_QUERY_REGISTRY[vendor];
		const lease = new AtCommandLease({
			sender: deps.atSender,
			allowlist: computeAtAllowlist([]),
		});
		const current = await lease.run(queries.current);
		const enumeration = await lease.run(queries.enumerate);
		const resolved = resolveRuntimeCompositionCapability({
			vendor,
			currentResponse: current.raw,
			enumerationResponse: enumeration.raw,
		});
		if (resolved.status === 'unknown')
			return suppressed('no-return-path', resolved.reason, resolved);
		if (!resolved.returnPathProven)
			return suppressed(
				'no-return-path',
				'The current mode is absent from the device catalog',
				resolved,
			);
		return {
			status: 'available',
			current: resolved.current,
			enumerated: resolved.enumerated,
			offerable: resolved.offerable.filter((mode) => !Object.is(mode, resolved.current)),
		};
	};

	return {
		descriptor: descriptorFor(
			suppressed('provisioning-disabled', 'Capability has not been read for this device'),
		),
		describe: async (context) => descriptorFor(await capability(context)),
		capability,
		read: async (context) =>
			result(context, { status: 'applied', value: await capability(context) }),
		write: async (context, target) => {
			const state = await capability(context);
			if (state.status === 'suppressed')
				return result(context, { status: 'refused', reason: state.reason });
			if (!state.offerable.some((candidate) => Object.is(candidate, target)))
				return result(context, { status: 'refused', reason: 'no-return-path' });
			const fullCapability: Extract<RuntimeCompositionCapability, { status: 'available' }> = {
				status: 'available',
				current: state.current,
				enumerated: state.enumerated,
				returnPathProven: true,
				offerable: [state.current, ...state.offerable],
			};
			const outcome = await deps.transition(context, fullCapability, target);
			if (outcome.status === 'refused')
				return result(context, { status: 'refused', reason: 'blocked-by-state' });
			if (outcome.status === 'failed')
				return result(context, { status: 'failed', reason: outcome.reason });
			return result(context, {
				status: 'applied',
				value: {
					status: 'available',
					current: target,
					enumerated: state.enumerated,
					offerable: state.enumerated.filter((mode) => !Object.is(mode, target)),
				},
			});
		},
	};
}
