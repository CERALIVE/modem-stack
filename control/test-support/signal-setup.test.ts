// Signal.Setup full lifecycle + read-only enrichment against the fake MM service.
//
// Locks the reviewed contract (draft §rounds 4-6): Setup is applied once at start,
// once per hot-plug, RE-APPLIED to survivors after an owner-epoch change, NEVER fired
// for an old epoch, and a modem lacking `Modem.Signal` reports `signalCadence:
// unsupported` (never a start failure). Also surfaces `Modem.Revision` + eSIM.
//
// Runs under `dbus-run-session -- bun test control/test-support`.

import { afterEach, describe, expect, test } from 'bun:test';
import { createMmDbusBackend, type MmDbusBackend } from '../src/backend';
import { runtimePath } from '../src/domain';
import type { ModemRef } from '../src/ports';
import { createDbusTransport, type DbusTransport } from '../src/transport';
import { FakeModemManager, type ModemSpec, modemPath, type SignalSetupCall } from './fake-mm';
import { hasSessionBus, sessionBusAddress, warnSkippedWithoutBus } from './session-bus';

warnSkippedWithoutBus('Signal.Setup lifecycle');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('waitFor timed out');
		}
		await sleep(5);
	}
}

const ref = (index: number): ModemRef => runtimePath(modemPath(index)) as ModemRef;

const sim = (index: number, extra: Record<string, unknown> = {}) => ({
	index,
	iccid: `890000000000000000${index}`,
	imsi: `00101000000000${index}`,
	active: true,
	...extra,
});

const modem = (index: number, extra: Partial<ModemSpec> = {}): ModemSpec => ({
	index,
	sims: [sim(index)],
	...extra,
});

describe.skipIf(!hasSessionBus())('SignalSetupManager — epoch lifecycle', () => {
	let fake: FakeModemManager;
	let transport: DbusTransport;
	let backend: MmDbusBackend;

	async function boot(modems: readonly ModemSpec[]): Promise<void> {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, modems });
		transport = createDbusTransport({ busAddress });
		backend = createMmDbusBackend({ transport });
		await backend.start();
	}

	afterEach(async () => {
		await backend.stop();
		await transport.disconnect();
		await fake.stop();
	});

	const forOwner = (owner: string | undefined): SignalSetupCall[] =>
		fake.signalSetupCalls.filter((call) => call.owner === owner);

	const modemsForOwner = (owner: string | undefined): number[] =>
		forOwner(owner)
			.map((call) => call.modemIndex)
			.sort((a, b) => a - b);

	test('applies Signal.Setup once per modem at start', async () => {
		await boot([modem(0), modem(1)]);
		const owner = fake.uniqueName;
		await waitFor(() => forOwner(owner).length === 2);
		expect(modemsForOwner(owner)).toEqual([0, 1]);
	});

	test('applies Signal.Setup to a hot-plugged modem', async () => {
		await boot([modem(0)]);
		const owner = fake.uniqueName;
		await waitFor(() => forOwner(owner).length === 1);
		fake.addModem(modem(2));
		await waitFor(() => forOwner(owner).length === 2);
		expect(modemsForOwner(owner)).toEqual([0, 2]);
	});

	test('re-applies to survivors on a new epoch, with ZERO old-epoch calls', async () => {
		await boot([modem(0), modem(1)]);
		const oldOwner = fake.uniqueName;
		await waitFor(() => forOwner(oldOwner).length === 2);
		fake.addModem(modem(2));
		await waitFor(() => forOwner(oldOwner).length === 3);

		await fake.restart();
		const newOwner = fake.uniqueName;
		expect(newOwner).not.toBe(oldOwner);
		await waitFor(() => forOwner(newOwner).length === 3);

		// Survivors re-applied under the new epoch...
		expect(modemsForOwner(newOwner)).toEqual([0, 1, 2]);
		// ...and NOT one extra Setup fired for the old epoch.
		expect(modemsForOwner(oldOwner)).toEqual([0, 1, 2]);
	});

	test('a modem without Modem.Signal reports signalCadence unsupported (no call, no failure)', async () => {
		await boot([modem(0, { hasSignal: false }), modem(1)]);
		const owner = fake.uniqueName;
		await waitFor(() => forOwner(owner).length === 1);
		await waitFor(() => backend.signalCadence(ref(0)) === 'unsupported');
		expect(backend.signalCadence(ref(0))).toBe('unsupported');
		expect(modemsForOwner(owner)).toEqual([1]);
	});
});

describe.skipIf(!hasSessionBus())('MmDbusBackend — read-only enrichment', () => {
	let fake: FakeModemManager;
	let transport: DbusTransport;
	let backend: MmDbusBackend;

	afterEach(async () => {
		await backend.stop();
		await transport.disconnect();
		await fake.stop();
	});

	test('surfaces Modem.Revision, eSIM SimType/EsimStatus, cadence, and serving cell', async () => {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({
			busAddress,
			modems: [
				{
					index: 0,
					revision: 'EM120R-GL_V1.0',
					sims: [sim(0, { simType: 2, esimStatus: 2 })],
				},
			],
		});
		transport = createDbusTransport({ busAddress });
		backend = createMmDbusBackend({ transport });
		await backend.start();
		fake.configureCellInfo(0, [
			[
				['serving', ['b', true]],
				['cell-id', ['s', 'CELL-A']],
				['rsrp', ['i', -85]],
				['rsrq', ['i', -9]],
				['sinr', ['i', 15]],
				['physical-ci', ['u', 7]],
			],
		]);
		await waitFor(() => backend.signalCadence(ref(0)) === 'active');

		const enrichment = await backend.readEnrichment(ref(0));
		expect(enrichment.revision).toBe('EM120R-GL_V1.0');
		expect(enrichment.esim.simType).toBe('esim');
		expect(enrichment.esim.esimStatus).toBe('with-profiles');
		expect(enrichment.signalCadence).toBe('active');
		expect(enrichment.servingCell).toMatchObject({ cellId: 'CELL-A', pci: 7, sinr: 15, rsrp: -85 });
		expect(enrichment.servingCell?.source).toBe(modemPath(0));
	});
});
