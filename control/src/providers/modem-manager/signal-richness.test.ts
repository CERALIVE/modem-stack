// End-to-end extended-signal truth through the REAL ModemManager provider.
//
// `observations/normalization.test.ts` proves the normalizer against a fixture. This one
// proves the WIRE, and it exists because the wire is exactly where this used to break:
// a `Modem.Signal` RAT dict is an `a{sv}`, so every member value arrives WRAPPED in a
// variant, and the retention layer used to keep the key while dropping the reading. A
// normalizer test cannot see that — it is handed the record the provider built.
//
// It runs on the in-memory transport for the reason the conformance matrix does: a suite
// that SKIPS wherever no session bus exists answers nothing.

import { describe, expect, test } from 'bun:test';
import { FakeMmTransport } from '../../../test-support/conformance/mm-transport';
import type { ModemSpec } from '../../../test-support/fake-mm/object-model';
import { type DeviceGeneration, deviceGeneration, physicalModemId } from '../../domain';
import type { NormalizedMetric, NormalizedSignal } from '../../observations';
import type { ProviderExecutionContext } from '../contracts';
import { createModemManagerProvider } from './provider';

const GENERATION: DeviceGeneration = deviceGeneration(1);
const PROFILE = 'generic-mm';

/** Quectel RM530N-GL attached 5G NSA: the NR leg and the LTE anchor are both live. */
const NSA_SPEC: ModemSpec = {
	index: 1,
	manufacturer: 'Quectel',
	model: 'RM530N-GL',
	revision: 'RM530NGLAAR11A02M4G',
	sims: [{ index: 1, iccid: '8900000000000000001', imsi: '001010000000001', active: true }],
	extendedSignal: {
		Nr5g: { rsrp: -98.5, rsrq: -11, snr: 6.5, 'error-rate': 0 },
		Lte: { rssi: -71, rsrp: -104, rsrq: -13.5, snr: 4, 'error-rate': 0 },
	},
};

/** Sierra MC7354 on EV-DO — the ONE `Modem.Signal` dict MM defines `sinr` on. */
const EVDO_SPEC: ModemSpec = {
	index: 2,
	manufacturer: 'Sierra Wireless',
	model: 'MC7354',
	revision: 'SWI9X15C',
	sims: [{ index: 2, iccid: '8900000000000000002', imsi: '001010000000002', active: true }],
	extendedSignal: { Evdo: { rssi: -83, ecio: -2.5, sinr: 9.5, io: -95, 'error-rate': 0 } },
};

/** The same modem with `Modem.Signal` exported and every RAT dict still empty. */
const SILENT_SPEC: ModemSpec = {
	index: 3,
	manufacturer: 'Quectel',
	model: 'RM530N-GL',
	revision: 'RM530NGLAAR11A02M4G',
	sims: [{ index: 3, iccid: '8900000000000000003', imsi: '001010000000003', active: true }],
};

function contextFor(spec: ModemSpec): ProviderExecutionContext {
	return {
		physicalModemId: physicalModemId(`serial:fake-device-${spec.index}`),
		generation: GENERATION,
		transport: 'modemmanager',
		passiveFacts: [],
		composition: 'generic',
		profile: PROFILE,
	};
}

async function signalOf(spec: ModemSpec): Promise<NormalizedSignal> {
	const provider = createModemManagerProvider({
		transport: new FakeMmTransport({ modems: [spec] }),
	});
	const snapshot = await provider.readSnapshot(contextFor(spec));
	if (!snapshot.ok) {
		throw new Error('the fake modem must produce a snapshot');
	}
	const observation = snapshot.observation.value;
	if (observation === null) {
		throw new Error('a served payload must produce a valued envelope');
	}
	return observation.signal;
}

async function rawOf(spec: ModemSpec): Promise<Record<string, unknown>> {
	const provider = createModemManagerProvider({
		transport: new FakeMmTransport({ modems: [spec] }),
	});
	const snapshot = await provider.readSnapshot(contextFor(spec));
	if (!snapshot.ok || snapshot.observation.value === null) {
		throw new Error('the fake modem must produce a valued snapshot');
	}
	return snapshot.observation.value.diagnostics.raw as Record<string, unknown>;
}

function reasonOf(metric: NormalizedMetric<number>): string {
	return metric.state === 'unknown' ? metric.reason : `known:${metric.value}`;
}

describe('Modem.Signal RAT dicts reach NormalizedSignal through the provider', () => {
	test('an NSA attach yields rsrp/rsrq/snr, each attributed to the dict it came from', async () => {
		const signal = await signalOf(NSA_SPEC);

		expect(signal.rsrp).toMatchObject({ state: 'known', value: -98.5 });
		expect(signal.rsrq).toMatchObject({ state: 'known', value: -11 });
		expect(signal.snr).toMatchObject({ state: 'known', value: 6.5 });
		expect(signal.dbm).toMatchObject({ state: 'known', value: -71 });
		for (const metric of [signal.rsrp, signal.rsrq, signal.snr, signal.dbm]) {
			expect(metric.provenance.authority).toBe('authoritative');
		}
		expect(signal.rsrp.provenance.rawFields).toEqual(['Signal.Nr5g.rsrp']);
		expect(signal.dbm.provenance.rawFields).toEqual(['Signal.Lte.rssi']);
	});

	test('an EV-DO attach yields SINR, the member no LTE/NR dict carries', async () => {
		const signal = await signalOf(EVDO_SPEC);

		expect(signal.sinr).toMatchObject({ state: 'known', value: 9.5 });
		expect(signal.sinr.provenance.rawFields).toEqual(['Signal.Evdo.sinr']);
		expect(signal.sinr.provenance.authority).toBe('authoritative');
	});

	test('every dict member survives retention verbatim, values included', async () => {
		const raw = await rawOf(NSA_SPEC);

		expect(raw['Signal.Nr5g']).toEqual([
			['rsrp', -98.5],
			['rsrq', -11],
			['snr', 6.5],
			['error-rate', 0],
		]);
		expect(raw['Signal.Lte']).toContainEqual(['rsrp', -104]);
	});

	test('an exported but silent Signal interface reports READ-class unknowns, never zeros', async () => {
		const signal = await signalOf(SILENT_SPEC);

		for (const metric of [signal.dbm, signal.rsrp, signal.rsrq, signal.snr, signal.sinr]) {
			expect(reasonOf(metric)).toBe('not-reported');
			expect(metric).not.toHaveProperty('value');
		}
	});

	test('a modem with no Modem.Signal interface at all reports not-observed', async () => {
		const signal = await signalOf({ ...SILENT_SPEC, index: 4, hasSignal: false });

		for (const metric of [signal.rsrp, signal.rsrq, signal.snr, signal.sinr]) {
			expect(reasonOf(metric)).toBe('not-observed');
		}
	});
});
