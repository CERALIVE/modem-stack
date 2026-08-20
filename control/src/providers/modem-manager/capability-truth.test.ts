// End-to-end capability truth through the REAL ModemManager provider.
//
// The unit suites in `src/radio/` prove the decoders and the descriptor builders. This
// one proves the WIRE: a `SupportedModes` property served by the MM-faithful object
// model reaches `operations().modes.describe()` without anything in between coercing
// it. That is the acceptance property — "`preferred: none` survives to the descriptor
// VERBATIM" is a claim about the whole path, not about a pure function.
//
// It runs on the in-memory transport (`test-support/conformance/mm-transport.ts`) for
// the reason the conformance matrix does: a suite that SKIPS wherever no session bus
// exists answers nothing.

import { beforeEach, describe, expect, test } from 'bun:test';
import { FakeMmTransport } from '../../../test-support/conformance/mm-transport';
import type { ModemSpec } from '../../../test-support/fake-mm/object-model';
import {
	type DeviceGeneration,
	deviceGeneration,
	type PhysicalModemId,
	physicalModemId,
} from '../../domain';
import { MODE_NONE, type ModeSelection } from '../../radio';
import type { DbusValue, MethodCall, MethodReply } from '../../transport';
import type { ProviderExecutionContext } from '../contracts';
import { createModemManagerProvider } from './provider';
import type { ModemManagerProviderOperations } from './types';

const CS = 1 << 0;
const M2G = 1 << 1;
const M3G = 1 << 2;
const M4G = 1 << 3;
const M5G = 1 << 4;
/** A mode bit no ModemManager release this build knows about defines. */
const FUTURE = 1 << 9;

const GENERATION: DeviceGeneration = deviceGeneration(1);
const PROFILE = 'generic-mm';

/**
 * Fibocom FM350-GL on the bench M.2→USB carrier — the same spec the conformance matrix
 * uses, and the reason this whole todo exists: ONE combination, `preferred` = 0.
 */
const FM350_SPEC: ModemSpec = {
	index: 4,
	manufacturer: 'Fibocom',
	model: 'FM350-GL',
	revision: '81600.0000.00.19.17.10',
	supportedModes: [[CS | M2G | M3G | M4G, 0]],
	currentModes: [CS | M2G | M3G | M4G, 0],
	supportedBands: [33, 378],
	sims: [{ index: 4, iccid: '8900000000000000004', imsi: '001010000000004', active: true }],
};

/** Bench Quectel RM530N-GL, matrix values. */
const QUECTEL_SPEC: ModemSpec = {
	index: 1,
	manufacturer: 'Quectel',
	model: 'RM530N-GL',
	revision: 'RM530NGLAAR11A02M4G',
	supportedModes: [[CS | M2G | M3G, 0]],
	currentModes: [CS | M2G | M3G, 0],
	supportedBands: [33, 378],
	sims: [{ index: 1, iccid: '8900000000000000001', imsi: '001010000000001', active: true }],
};

/** Bench SIMCom SIM7600G-H, matrix values. */
const SIMCOM_SPEC: ModemSpec = {
	index: 2,
	manufacturer: 'SIMCom',
	model: 'SIM7600G-H',
	revision: 'LE20B04SIM7600G22',
	supportedModes: [[M3G, 0]],
	currentModes: [M3G, 0],
	sims: [{ index: 2, iccid: '8900000000000000002', imsi: '001010000000002', active: true }],
};

/** A hypothetical modem advertising a mode bit this build cannot name. */
const UNKNOWN_COMBINATION_SPEC: ModemSpec = {
	index: 5,
	manufacturer: 'Unknown Radios Inc.',
	model: 'FUTURE-1',
	revision: '1.0',
	supportedModes: [
		[M4G | M5G, M5G],
		[M4G | M5G | FUTURE, FUTURE],
	],
	currentModes: [M4G | M5G, M5G],
	sims: [{ index: 5, iccid: '8900000000000000005', imsi: '001010000000005', active: true }],
};

/**
 * A modem with NO SIM, as ModemManager reports one: failed state, `StateFailedReason`
 * = 2 (`SIM_MISSING`), and — critically — an empty `sims` list so `Sim` is `/`.
 */
const NO_SIM_SPEC: ModemSpec = {
	index: 6,
	manufacturer: 'Quectel',
	model: 'RM530N-GL',
	revision: 'RM530NGLAAR11A02M4G',
	state: -1,
	stateFailedReason: 2,
	supportedModes: [[CS | M2G | M3G, 0]],
	currentModes: [CS | M2G | M3G, 0],
	sims: [],
};

/**
 * The SAME modem still initializing: `Sim` is `/` and NO failure reason is exported.
 * Built field-by-field rather than spread from `NO_SIM_SPEC`, because the absence of
 * `stateFailedReason` is the entire point of this fixture and a spread would carry it.
 */
const BLANK_SIM_SPEC: ModemSpec = {
	index: 7,
	manufacturer: 'Quectel',
	model: 'RM530N-GL',
	revision: 'RM530NGLAAR11A02M4G',
	state: 1,
	supportedModes: [[CS | M2G | M3G, 0]],
	currentModes: [CS | M2G | M3G, 0],
	sims: [],
};

function contextFor(spec: ModemSpec): ProviderExecutionContext {
	const id: PhysicalModemId = physicalModemId(`serial:fake-device-${spec.index}`);
	return {
		physicalModemId: id,
		generation: GENERATION,
		transport: 'modemmanager',
		passiveFacts: [],
		composition: 'generic',
		profile: PROFILE,
	};
}

/**
 * The in-memory transport with `SetCurrentModes` / `SetCurrentBands` ACTUALLY APPLIED.
 *
 * The base transport accepts every call and changes nothing, which is exactly the
 * accepted-but-ignored write the readback gate exists to catch — so both behaviours are
 * needed, and `applyWrites` selects between them.
 */
class WritableMmTransport extends FakeMmTransport {
	#spec: ModemSpec;
	readonly #applyWrites: boolean;

	constructor(spec: ModemSpec, applyWrites: boolean) {
		super({ modems: [spec] });
		this.#spec = spec;
		this.#applyWrites = applyWrites;
	}

	override async callMethod(call: MethodCall): Promise<MethodReply> {
		if (call.member === 'SetCurrentModes' && this.#applyWrites) {
			const pair = (call.args?.[0] ?? []) as readonly number[];
			this.#spec = { ...this.#spec, currentModes: [pair[0] ?? 0, pair[1] ?? 0] };
			this.removeModem(this.#spec.index);
			this.addModem(this.#spec);
			return { signature: '', body: [] };
		}
		return super.callMethod(call);
	}

	override tree(): DbusValue {
		return super.tree();
	}
}

function providerFor(spec: ModemSpec) {
	const transport = new FakeMmTransport({ modems: [spec] });
	const provider = createModemManagerProvider({ transport });
	return { provider, transport, operations: provider.definition.operations(PROFILE) };
}

const allowedValues = (constraints: { kind: string; values?: readonly unknown[] }) =>
	constraints.kind === 'allowed-values' ? (constraints.values ?? []) : [];

describe('FM350 — `preferred: none` survives to the descriptor VERBATIM', () => {
	let operations: ModemManagerProviderOperations;
	const context = contextFor(FM350_SPEC);

	beforeEach(() => {
		operations = providerFor(FM350_SPEC).operations;
	});

	test('the live descriptor offers exactly the modem`s own combination', async () => {
		const descriptor = await operations.modes.describe(context);
		expect(descriptor.constraints).toEqual({
			kind: 'allowed-values',
			values: [{ allowed: ['cs', '2g', '3g', '4g'], preferred: MODE_NONE }],
		});
	});

	test('`preferred` is `none` and is not any of the allowed modes', async () => {
		const descriptor = await operations.modes.describe(context);
		const values = allowedValues(descriptor.constraints) as readonly ModeSelection[];
		expect(values[0]?.preferred).toBe(MODE_NONE);
		for (const mode of ['cs', '2g', '3g', '4g', '5g']) {
			expect(values[0]?.preferred).not.toBe(mode);
		}
	});

	test('the READ answers the same combination with its raw masks intact', async () => {
		const result = await operations.modes.read(context);
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.value.current).toEqual({
			state: 'reported',
			combination: {
				allowedMask: CS | M2G | M3G | M4G,
				allowed: ['cs', '2g', '3g', '4g'],
				preferredMask: 0,
				preferred: MODE_NONE,
				classification: 'named',
				anomalies: [],
			},
		});
	});

	test('the observation retains `CurrentModes` as its `(uu)` pair, unflattened', async () => {
		const { provider } = providerFor(FM350_SPEC);
		const snapshot = await provider.readSnapshot(context);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		const view = snapshot.observation;
		expect(view.freshness.state).toBe('fresh');
		expect(view.value?.diagnostics.raw['Modem.CurrentModes']).toEqual([CS | M2G | M3G | M4G, 0]);
		expect(view.value?.diagnostics.raw['Modem.SignalQuality']).toEqual([71, true]);
	});

	test('the write is disruptive, journalled, admitted and readback-gated', async () => {
		const descriptor = await operations.modes.describe(context);
		expect(descriptor.mutationImpact).toBe('disruptive');
		expect(descriptor.journal.required).toBe(true);
		expect(descriptor.admission.required).toBe(true);
		expect(descriptor.readback.required).toBe(true);
	});
});

describe('Quectel and SIMCom descriptors', () => {
	test('Quectel offers exactly its one advertised combination', async () => {
		const { operations } = providerFor(QUECTEL_SPEC);
		const descriptor = await operations.modes.describe(contextFor(QUECTEL_SPEC));
		expect(descriptor.constraints).toEqual({
			kind: 'allowed-values',
			values: [{ allowed: ['cs', '2g', '3g'], preferred: MODE_NONE }],
		});
	});

	test('SIMCom offers exactly its one advertised combination', async () => {
		const { operations } = providerFor(SIMCOM_SPEC);
		const descriptor = await operations.modes.describe(contextFor(SIMCOM_SPEC));
		expect(descriptor.constraints).toEqual({
			kind: 'allowed-values',
			values: [{ allowed: ['3g'], preferred: MODE_NONE }],
		});
	});

	test('neither device`s preference is invented from its allowed set', async () => {
		for (const spec of [QUECTEL_SPEC, SIMCOM_SPEC]) {
			const { operations } = providerFor(spec);
			const descriptor = await operations.modes.describe(contextFor(spec));
			const values = allowedValues(descriptor.constraints) as readonly ModeSelection[];
			expect(values[0]?.preferred).toBe(MODE_NONE);
		}
	});
});

describe('an unknown combination is offered, not coerced to unsupported', () => {
	const context = contextFor(UNKNOWN_COMBINATION_SPEC);

	test('both combinations reach the descriptor, the unnameable one included', async () => {
		const { operations } = providerFor(UNKNOWN_COMBINATION_SPEC);
		const descriptor = await operations.modes.describe(context);
		expect(allowedValues(descriptor.constraints)).toEqual([
			{ allowed: ['4g', '5g'], preferred: '5g' },
			{ allowed: ['4g', '5g', 'mode-bit-512'], preferred: 'mode-bit-512' },
		]);
	});

	test('the descriptor stays AVAILABLE despite the unknown member', async () => {
		const { operations } = providerFor(UNKNOWN_COMBINATION_SPEC);
		const descriptor = await operations.modes.describe(context);
		expect(descriptor.availability).toEqual({ state: 'available' });
		expect(descriptor.support.write).toEqual({ supported: true });
	});

	test('the read classifies it without dropping it', async () => {
		const { operations } = providerFor(UNKNOWN_COMBINATION_SPEC);
		const result = await operations.modes.read(context);
		if (result.status !== 'applied') throw new Error('expected applied');
		expect(result.value.supported.combinations).toHaveLength(2);
		expect(result.value.supported.combinations[1]?.classification).toBe('unknown-combination');
		expect(result.value.supported.undecodable).toEqual([]);
	});

	test('a selection the modem never advertised is refused, never rounded', async () => {
		const { operations } = providerFor(UNKNOWN_COMBINATION_SPEC);
		const result = await operations.modes.write(context, {
			allowed: ['4g', '5g'],
			preferred: '4g',
		});
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'mode-combination-not-advertised',
		});
	});
});

describe('mode writes are readback-gated at the call path, not only in the descriptor', () => {
	test('an accepted-but-ignored SetCurrentModes is refused, never reported applied', async () => {
		const transport = new WritableMmTransport(UNKNOWN_COMBINATION_SPEC, false);
		const provider = createModemManagerProvider({ transport });
		const result = await provider.definition
			.operations(PROFILE)
			.modes.write(contextFor(UNKNOWN_COMBINATION_SPEC), {
				allowed: ['4g', '5g', 'mode-bit-512'],
				preferred: 'mode-bit-512',
			});
		expect(result).toMatchObject({ status: 'refused', reason: 'mode-write-readback-mismatch' });
	});

	test('a write the modem HONOURS reports applied and returns the new truth', async () => {
		const transport = new WritableMmTransport(UNKNOWN_COMBINATION_SPEC, true);
		const provider = createModemManagerProvider({ transport });
		const result = await provider.definition
			.operations(PROFILE)
			.modes.write(contextFor(UNKNOWN_COMBINATION_SPEC), {
				allowed: ['4g', '5g', 'mode-bit-512'],
				preferred: 'mode-bit-512',
			});
		if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
		expect(result.value.current).toMatchObject({
			state: 'reported',
			combination: { preferred: 'mode-bit-512', preferredMask: FUTURE },
		});
	});
});

describe('band writes carry the disruptive class and the certification gate', () => {
	const context = contextFor(FM350_SPEC);

	test('the live band descriptor is disruptive and refused without certification', async () => {
		const { operations } = providerFor(FM350_SPEC);
		const descriptor = await operations.bands.describe(context);
		expect(descriptor.mutationImpact).toBe('disruptive');
		expect(descriptor.availability).toEqual({
			state: 'refused',
			reason: 'band-certification-required',
		});
		expect(descriptor.support.write).toEqual({
			supported: false,
			reason: 'band-certification-required',
		});
	});

	test('the certification precondition and readback are both declared', async () => {
		const { operations } = providerFor(FM350_SPEC);
		const descriptor = await operations.bands.describe(context);
		expect(descriptor.livePreconditions).toContain('band-certification-present');
		expect(descriptor.readback.required).toBe(true);
		expect(descriptor.journal.required).toBe(true);
		expect(descriptor.admission.required).toBe(true);
	});

	test('a band WRITE is refused and never reaches the bus', async () => {
		const { operations, transport } = providerFor(FM350_SPEC);
		const before = transport.calls.length;
		const result = await operations.bands.write(context, ['eutran-3']);
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'band-write-certification-required',
		});
		expect(
			transport.calls.slice(before).filter((call) => call.member === 'SetCurrentBands'),
		).toEqual([]);
	});

	test('band READS stay available on the same uncertified device', async () => {
		const { operations } = providerFor(FM350_SPEC);
		const result = await operations.bands.read(context);
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.value.supported).toEqual(['eutran-3', 'ngran-78']);
	});

	test('an SKU resolver that finds no catalog entry still refuses', async () => {
		const transport = new FakeMmTransport({ modems: [FM350_SPEC] });
		const provider = createModemManagerProvider({
			transport,
			bandSku: () => ({ vidPid: '0e8d:7127', model: 'FM350-GL', firmwarePrefix: '81600' }),
		});
		const descriptor = await provider.definition.operations(PROFILE).bands.describe(context);
		expect(descriptor.availability).toEqual({
			state: 'refused',
			reason: 'band-certification-required',
		});
	});
});

describe('no-SIM is EXPLICIT evidence, through the provider', () => {
	test('a modem reporting `sim-missing` yields an evidence-backed absent state', async () => {
		const { provider } = providerFor(NO_SIM_SPEC);
		const snapshot = await provider.readSnapshot(contextFor(NO_SIM_SPEC));
		if (!snapshot.ok) throw new Error('expected a snapshot');
		expect(snapshot.sim.presence).toBe('absent');
		expect(snapshot.sim.presenceEvidence).toEqual({
			kind: 'state-failed-reason',
			field: 'failedReason',
			value: 'sim-missing',
		});
	});

	test('THE CONTROL: the same blank SIM path WITHOUT the reason is never absent', async () => {
		const { provider } = providerFor(BLANK_SIM_SPEC);
		const snapshot = await provider.readSnapshot(contextFor(BLANK_SIM_SPEC));
		if (!snapshot.ok) throw new Error('expected a snapshot');
		expect(snapshot.sim.presence).toBe('unknown');
		expect(snapshot.sim.presenceEvidence).toEqual({
			kind: 'no-evidence',
			inspected: ['sim', 'simSlots', 'failedReason'],
		});
	});

	test('`present: false` is carried by BOTH, so it is never a claim of absence', async () => {
		for (const spec of [NO_SIM_SPEC, BLANK_SIM_SPEC]) {
			const { provider } = providerFor(spec);
			const snapshot = await provider.readSnapshot(contextFor(spec));
			if (!snapshot.ok) throw new Error('expected a snapshot');
			expect(snapshot.sim.present).toBe(false);
		}
	});

	test('a modem WITH a SIM names the object path that proved it', async () => {
		const { provider } = providerFor(QUECTEL_SPEC);
		const snapshot = await provider.readSnapshot(contextFor(QUECTEL_SPEC));
		if (!snapshot.ok) throw new Error('expected a snapshot');
		expect(snapshot.sim.presence).toBe('present');
		expect(snapshot.sim.presenceEvidence).toEqual({
			kind: 'sim-object-path',
			field: 'sim',
			value: '/org/freedesktop/ModemManager1/SIM/1',
		});
	});

	test('the normalized observation agrees with the snapshot on both devices', async () => {
		for (const [spec, expected] of [
			[NO_SIM_SPEC, 'known'],
			[BLANK_SIM_SPEC, 'unknown'],
		] as const) {
			const { provider } = providerFor(spec);
			const snapshot = await provider.readSnapshot(contextFor(spec));
			if (!snapshot.ok) throw new Error('expected a snapshot');
			expect(snapshot.observation.value?.sim.presence.state).toBe(expected);
			expect(snapshot.observation.value?.sim.presenceEvidence).toEqual(
				snapshot.sim.presenceEvidence,
			);
		}
	});
});
