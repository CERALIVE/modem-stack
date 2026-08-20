import type { MmDbusBackend } from '../../backend';
import type { BandName } from '../../band';
import {
	classifyOperationCompletion,
	type DesiredRadio,
	defineOperationDescriptor,
	type OperationDescriptor,
	type OperationResult,
	runtimePath,
} from '../../domain';
import type { ModemBands } from '../../ports';
import {
	bandWriteReadbackMatches,
	buildBandWriteDescriptor,
	buildModeWriteDescriptor,
	encodeModeSelection,
	type ModeSelection,
	matchAdvertisedCombination,
	type RadioModeTruth,
	sameSelection,
	selectionOf,
} from '../../radio';
import type { ProviderExecutionContext } from '../contracts';
import { mapModemManagerError } from './errors';
import type {
	ContextReadOperation,
	ContextWriteOperation,
	ModemManagerProviderOperations,
	ModemManagerProviderSnapshot,
	ModemManagerRadioState,
	ModemManagerSignalState,
	ModemManagerSimState,
	ModemManagerSnapshotResult,
} from './types';

const PROVIDER_ID = 'modemmanager';
const PROFILE = 'generic-mm';

export interface GenericOperationsDeps {
	readonly backend: MmDbusBackend;
	readSnapshot(context: ProviderExecutionContext): Promise<ModemManagerSnapshotResult>;
}

function readDescriptor<O>(id: string): OperationDescriptor<never, O> {
	return defineOperationDescriptor({
		id,
		support: { read: { supported: true }, write: { supported: false, reason: 'read-only' } },
		authority: 'provider',
		provider: PROVIDER_ID,
		constraints: { kind: 'unconstrained' },
		livePreconditions: ['modem-present', 'runtime-interface-present'],
		availability: { state: 'available' },
		mutationImpact: 'read',
		retryClass: 'idempotent-read',
		readback: { required: false },
		rollback: { required: false },
		journal: { required: false },
		admission: { required: false },
		evidence: { profiles: [PROFILE], firmware: [] },
		confidence: 'high',
	});
}

function writeDescriptor<I, O>(id: string): OperationDescriptor<I, O> {
	return defineOperationDescriptor({
		id,
		support: { read: { supported: true }, write: { supported: true } },
		authority: 'provider',
		provider: PROVIDER_ID,
		constraints: { kind: 'unconstrained' },
		livePreconditions: ['modem-present', 'runtime-interface-present'],
		availability: { state: 'available' },
		mutationImpact: 'disruptive',
		retryClass: 'never',
		readback: { required: false },
		rollback: { required: false },
		journal: { required: true, reason: 'disruptive-radio-write' },
		admission: { required: true, reason: 'provider-mutation' },
		evidence: { profiles: [PROFILE], firmware: [] },
		confidence: 'high',
	});
}

function applied<O>(context: ProviderExecutionContext, value: O): OperationResult<O> {
	return classifyOperationCompletion({
		operation: 'read',
		completionGeneration: context.generation,
		currentGeneration: context.generation,
		completion: { status: 'applied', value },
	});
}

function refused<O>(context: ProviderExecutionContext, reason: string): OperationResult<O> {
	return classifyOperationCompletion({
		operation: 'read',
		completionGeneration: context.generation,
		currentGeneration: context.generation,
		completion: { status: 'refused', reason },
	});
}

function receiptReason(reason: string): string {
	const mapped = mapModemManagerError(new Error(reason));
	return mapped.reason === 'failed' ? reason : mapped.reason;
}

export function createGenericOperations(
	deps: GenericOperationsDeps,
): Pick<ModemManagerProviderOperations, 'radio' | 'modes' | 'bands' | 'signal' | 'sim' | 'power'> {
	const readField = async <O>(
		context: ProviderExecutionContext,
		capability: 'modeRead' | 'signalRead' | 'simRead' | 'powerRead',
		select: (snapshot: ModemManagerProviderSnapshot) => O,
		reason: string,
	): Promise<OperationResult<O>> => {
		const snapshot = await deps.readSnapshot(context);
		if (!snapshot.ok) return refused(context, snapshot.reason);
		return snapshot.capabilities[capability]
			? applied(context, select(snapshot))
			: refused(context, reason);
	};

	const readBands = async (
		context: ProviderExecutionContext,
	): Promise<OperationResult<ModemBands>> => {
		const snapshot = await deps.readSnapshot(context);
		if (!snapshot.ok) return refused(context, snapshot.reason);
		if (!snapshot.capabilities.bandRead) return refused(context, 'band-read-unsupported');
		const result = await deps.backend.readBands(runtimePath(snapshot.modemPath));
		return result.ok
			? applied(context, result.bands)
			: refused(context, receiptReason(result.reason));
	};

	const radioDescriptor = writeDescriptor<DesiredRadio, ModemManagerRadioState>(
		'modemmanager.radio-modes',
	);
	const radio: ContextWriteOperation<DesiredRadio, ModemManagerRadioState> = {
		descriptor: radioDescriptor,
		describe: () => Promise.resolve(radioDescriptor),
		read: (context) =>
			readField(context, 'modeRead', (snapshot) => snapshot.radio, 'mode-read-unsupported'),
		write: async (context, input) => {
			const snapshot = await deps.readSnapshot(context);
			if (!snapshot.ok) return refused(context, snapshot.reason);
			if (!snapshot.capabilities.modeWrite) return refused(context, 'mode-write-unsupported');
			const receipt = await deps.backend.setRadioModes(runtimePath(snapshot.modemPath), input);
			if (receipt.status !== 'applied') return refused(context, receiptReason(receipt.reason));
			return readField(context, 'modeRead', (next) => next.radio, 'mode-read-unsupported');
		},
	};

	const readModeTruth = async (
		context: ProviderExecutionContext,
	): Promise<OperationResult<RadioModeTruth>> =>
		readField(context, 'modeRead', (snapshot) => snapshot.radio.truth, 'mode-read-unsupported');

	const modes: ContextWriteOperation<ModeSelection, RadioModeTruth> = {
		descriptor: buildModeWriteDescriptor({
			provider: PROVIDER_ID,
			profile: PROFILE,
			truth: {
				current: { state: 'not-reported' },
				supported: { combinations: [], undecodable: [] },
			},
			writeSupported: true,
		}),
		describe: async (context) => {
			const snapshot = await deps.readSnapshot(context);
			return buildModeWriteDescriptor({
				provider: PROVIDER_ID,
				profile: PROFILE,
				truth: snapshot.ok
					? snapshot.radio.truth
					: {
							current: { state: 'not-reported' },
							supported: { combinations: [], undecodable: [] },
						},
				writeSupported: snapshot.ok && snapshot.capabilities.modeWrite,
			});
		},
		read: readModeTruth,
		write: async (context, selection) => {
			const snapshot = await deps.readSnapshot(context);
			if (!snapshot.ok) return refused(context, snapshot.reason);
			if (!snapshot.capabilities.modeWrite) return refused(context, 'mode-write-unsupported');
			// A selection the modem never advertised is refused outright — never rounded to
			// the nearest advertised one. Substituting is how "prefer 4G" on a marginal cell
			// silently becomes 5G-first, which `five-g-preference.ts` refuses for the same reason.
			if (matchAdvertisedCombination(snapshot.radio.truth.supported, selection) === undefined) {
				return refused(context, 'mode-combination-not-advertised');
			}
			const encoded = encodeModeSelection(selection);
			if (!encoded.ok) return refused(context, 'mode-name-unknown');
			const receipt = await deps.backend.setModeCombination(
				runtimePath(snapshot.modemPath),
				encoded.allowedMask,
				encoded.preferredMask,
			);
			if (receipt.status !== 'applied') return refused(context, receiptReason(receipt.reason));
			const readback = await readModeTruth(context);
			if (readback.status !== 'applied') return readback;
			// An accepted-but-ignored `SetCurrentModes` is indistinguishable from success at
			// the call site, so the descriptor requires a readback and this enforces it.
			return readback.value.current.state === 'reported' &&
				sameSelection(selectionOf(readback.value.current.combination), selection)
				? readback
				: refused(context, 'mode-write-readback-mismatch');
		},
	};

	const bandDescriptorFor = (snapshot: ModemManagerSnapshotResult) =>
		buildBandWriteDescriptor({
			provider: PROVIDER_ID,
			profile: PROFILE,
			certification: snapshot.ok
				? snapshot.bandCertification
				: {
						required: true,
						satisfied: false,
						reason: 'band-certification-required',
						offerable: [],
					},
			readSupported: snapshot.ok && snapshot.capabilities.bandRead,
		});

	const bands: ContextWriteOperation<readonly BandName[], ModemBands> = {
		descriptor: bandDescriptorFor({ ok: false, reason: 'not-found' }),
		describe: async (context) => bandDescriptorFor(await deps.readSnapshot(context)),
		read: readBands,
		write: async (context, input) => {
			const snapshot = await deps.readSnapshot(context);
			if (!snapshot.ok) return refused(context, snapshot.reason);
			// The certification gate, second of two. `bandWrite` is already false without a
			// catalog entry, and the descriptor already reads `refused` — but a band lock can
			// take a working uplink off the air, so the call path refuses independently
			// rather than trusting a consumer to have read the descriptor.
			if (!snapshot.bandCertification.satisfied || !snapshot.capabilities.bandWrite)
				return refused(context, 'band-write-certification-required');
			const receipt = await deps.backend.setCurrentBands(runtimePath(snapshot.modemPath), input);
			if (receipt.status !== 'applied') return refused(context, receiptReason(receipt.reason));
			const readback = await readBands(context);
			if (readback.status !== 'applied') return readback;
			return bandWriteReadbackMatches(input, readback.value)
				? readback
				: refused(context, 'band-write-readback-mismatch');
		},
	};

	const signal: ContextReadOperation<ModemManagerSignalState> = {
		descriptor: readDescriptor('modemmanager.signal'),
		read: (context) =>
			readField(context, 'signalRead', (snapshot) => snapshot.signal, 'signal-read-unsupported'),
	};
	const sim: ContextReadOperation<ModemManagerSimState> = {
		descriptor: readDescriptor('modemmanager.sim'),
		read: (context) =>
			readField(context, 'simRead', (snapshot) => snapshot.sim, 'sim-read-unsupported'),
	};
	const power: ContextReadOperation<ModemManagerProviderSnapshot['power']> = {
		descriptor: readDescriptor('modemmanager.power'),
		read: (context) =>
			readField(context, 'powerRead', (snapshot) => snapshot.power, 'power-read-unsupported'),
	};
	return { radio, modes, bands, signal, sim, power };
}
