// Feature detection + identity ladder against the MM-faithful fake, over the three
// property shapes the fake serves (1.20 / 1.22 / 1.24). Proves detection reads the
// REAL observed property set — Physdev present on 1.22+ and absent on 1.20 — and that
// the identity ladder resolves a stable slot from the tree's Device / Physdev values.
//
// Runs under `dbus-run-session -- bun test control/test-support`.

import { afterEach, describe, expect, test } from 'bun:test';
import {
	detectModemFeatures,
	type MmFeatures,
	modemIdentityFactsFromTree,
	resolveModemIdentity,
} from '../src/backend';
import { logicalSlotId } from '../src/domain';
import { createDbusTransport, type DbusTransport } from '../src/transport';
import {
	FakeModemManager,
	fetchManagedObjects,
	type MmShape,
	type ModemSpec,
	modemPath,
} from './fake-mm';
import { hasSessionBus, sessionBusAddress, warnSkippedWithoutBus } from './session-bus';

warnSkippedWithoutBus('MM feature detection + identity ladder');

const VERSION_FOR: Record<MmShape, string> = {
	'1.20': '1.20.0',
	'1.22': '1.22.0',
	'1.24': '1.24.0',
};

const modem = (index: number, device?: string): ModemSpec => ({
	index,
	equipmentId: `49015420323751${index}`,
	...(device !== undefined ? { device } : {}),
	sims: [
		{ index, iccid: `890000000000000000${index}`, imsi: `00101000000000${index}`, active: true },
	],
});

describe.skipIf(!hasSessionBus())('feature detection over 3 fake shapes', () => {
	let fake: FakeModemManager;
	let transport: DbusTransport;

	async function boot(shape: MmShape, modems: readonly ModemSpec[]): Promise<void> {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, shape, modems });
		transport = createDbusTransport({ busAddress });
		await transport.connect();
	}

	afterEach(async () => {
		await transport.disconnect();
		await fake.stop();
	});

	async function detect(shape: MmShape): Promise<MmFeatures> {
		await boot(shape, [modem(0)]);
		const tree = await fetchManagedObjects(transport, fake.busName);
		return detectModemFeatures(VERSION_FOR[shape], tree, modemPath(0));
	}

	test('1.20 shape ⇒ no physdev, basic cell info', async () => {
		expect(await detect('1.20')).toEqual({
			physdev: false,
			cellInfo: 'basic',
			esimStatus: true,
			opSerialization: true,
		});
	});

	test('1.22 shape ⇒ physdev present, rich cell info', async () => {
		expect(await detect('1.22')).toEqual({
			physdev: true,
			cellInfo: 'rich',
			esimStatus: true,
			opSerialization: true,
		});
	});

	test('1.24 shape ⇒ physdev present, rich cell info', async () => {
		expect(await detect('1.24')).toEqual({
			physdev: true,
			cellInfo: 'rich',
			esimStatus: true,
			opSerialization: true,
		});
	});
});

describe.skipIf(!hasSessionBus())('identity ladder against the observed tree', () => {
	let fake: FakeModemManager;
	let transport: DbusTransport;

	async function boot(shape: MmShape, modems: readonly ModemSpec[]): Promise<void> {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, shape, modems });
		transport = createDbusTransport({ busAddress });
		await transport.connect();
	}

	afterEach(async () => {
		await transport.disconnect();
		await fake.stop();
	});

	test('a slot-* Device resolves via rung 1 with high confidence', async () => {
		await boot('1.24', [modem(0, 'slot-usb2-1')]);
		const tree = await fetchManagedObjects(transport, fake.busName);
		const resolved = resolveModemIdentity(modemIdentityFactsFromTree(tree, modemPath(0)));
		expect(resolved.slotSource).toBe('device-slot-uid');
		expect(resolved.identity.logicalSlotId).toBe(logicalSlotId('slot-usb2-1'));
	});

	test('a path-shaped Device on 1.24 falls to Physdev (rung 2)', async () => {
		await boot('1.24', [modem(0)]);
		const tree = await fetchManagedObjects(transport, fake.busName);
		const resolved = resolveModemIdentity(modemIdentityFactsFromTree(tree, modemPath(0)));
		expect(resolved.slotSource).toBe('physdev');
		expect(resolved.confidence).toBe('high');
	});

	test('1.20 has no Physdev, so a path-shaped Device falls to equipment fallback', async () => {
		await boot('1.20', [modem(0)]);
		const tree = await fetchManagedObjects(transport, fake.busName);
		const resolved = resolveModemIdentity(modemIdentityFactsFromTree(tree, modemPath(0)));
		expect(resolved.slotSource).toBe('equipment-fallback');
	});
});
