// Self-test proving the harness itself models the REAL ModemManager object tree.
//
// It drives the fake through the production transport (the same seam A3.x uses) and
// walks ObjectManager → modem → SIM → Modem3gpp, asserting the architectural facts
// review insisted on: `Modem` and `Modem.Modem3gpp` are SEPARATE interfaces, SIMs are
// SEPARATE `/SIM/<n>` objects reached via the modem's `Sim` path, the bearer is
// observable but every connect method throws the tripwire, and the 1.20 vs 1.24
// property shapes differ exactly by `Physdev`. Run under `dbus-run-session`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDbusTransport, type DbusTransport, type SignalEvent } from '../src/transport';
import {
	BEARER_IFACE,
	bearerPath,
	FakeModemManager,
	fetchManagedObjects,
	findInterface,
	followObjectPath,
	hasInterface,
	interfaceNames,
	MODEM_IFACE,
	MODEM3GPP_IFACE,
	type ModemSpec,
	modemPath,
	pathsWithInterface,
	propValue,
	SIM_IFACE,
	SIMPLE_IFACE,
	simPath,
} from './fake-mm';
import { hasSessionBus, sessionBusAddress, warnSkippedWithoutBus } from './session-bus';

warnSkippedWithoutBus('MM-faithful fake self-test');

const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

const MODEM_0: ModemSpec = {
	index: 0,
	equipmentId: '350000000000001',
	device: 'slot-usb2-1',
	sims: [{ index: 0, iccid: '8900000000000000001', imsi: '001010000000001', active: true }],
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('waitFor timed out');
		}
		await sleep(5);
	}
}

describe.skipIf(!hasSessionBus())('MM-faithful fake service — self-test walk', () => {
	let fake: FakeModemManager;
	let transport: DbusTransport;

	beforeEach(async () => {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, shape: '1.24', modems: [MODEM_0] });
		transport = createDbusTransport({ busAddress });
		await transport.connect();
	});

	afterEach(async () => {
		await transport.disconnect();
		await fake.stop();
	});

	test('ObjectManager lists the modem, its SIM, and its bearer as separate objects', async () => {
		const tree = await fetchManagedObjects(transport, fake.busName);
		expect(pathsWithInterface(tree, MODEM_IFACE)).toEqual([modemPath(0)]);
		expect(pathsWithInterface(tree, SIM_IFACE)).toEqual([simPath(0)]);
		expect(pathsWithInterface(tree, BEARER_IFACE)).toEqual([bearerPath(0)]);
	});

	test('the modem exposes Modem and Modem3gpp as SEPARATE interfaces, never merged', async () => {
		const tree = await fetchManagedObjects(transport, fake.busName);
		const names = interfaceNames(tree, modemPath(0));
		expect(names).toContain(MODEM_IFACE);
		expect(names).toContain(MODEM3GPP_IFACE);
		// Modem3gpp props (Imei) live under their OWN interface key, not under Modem.
		expect(propValue(findInterface(tree, modemPath(0), MODEM_IFACE), 'Imei')).toBeUndefined();
		expect(propValue(findInterface(tree, modemPath(0), MODEM3GPP_IFACE), 'Imei')).toBe(
			'350000000000001',
		);
	});

	test("the modem's Sim path resolves to a separate /SIM/<n> object", async () => {
		const tree = await fetchManagedObjects(transport, fake.busName);
		const modemProps = findInterface(tree, modemPath(0), MODEM_IFACE);
		expect(propValue(modemProps, 'Sim')).toBe(simPath(0));
		const simObject = followObjectPath(tree, modemProps, 'Sim');
		expect(simObject?.[0]).toBe(simPath(0));
		expect(hasInterface(tree, simPath(0), SIM_IFACE)).toBe(true);
		expect(propValue(findInterface(tree, simPath(0), SIM_IFACE), 'SimIdentifier')).toBe(
			'8900000000000000001',
		);
	});

	test('the bearer is observable in the tree but Connect throws the tripwire', async () => {
		const tree = await fetchManagedObjects(transport, fake.busName);
		expect(hasInterface(tree, bearerPath(0), BEARER_IFACE)).toBe(true);
		await expect(
			transport.callMethod({
				destination: fake.busName,
				path: bearerPath(0),
				interface: BEARER_IFACE,
				member: 'Connect',
			}),
		).rejects.toThrow(/TRIPWIRE/);
	});

	test('the modem Simple.Connect and CreateBearer are tripwires too', async () => {
		const call = (iface: string, member: string) =>
			transport.callMethod({
				destination: fake.busName,
				path: modemPath(0),
				interface: iface,
				member,
			});
		await expect(call(SIMPLE_IFACE, 'Connect')).rejects.toThrow(/TRIPWIRE/);
		await expect(call(MODEM_IFACE, 'CreateBearer')).rejects.toThrow(/TRIPWIRE/);
	});

	test('an invalidated-only PropertiesChanged carries names in the invalidated array', async () => {
		const events: SignalEvent[] = [];
		const sub = await transport.subscribeSignal(
			{ interface: PROPERTIES_IFACE, member: 'PropertiesChanged', path: modemPath(0) },
			(event) => events.push(event),
		);
		fake.invalidateProperties(modemPath(0), MODEM_IFACE, ['SignalQuality']);
		await waitFor(() => events.length > 0);
		await sub.unsubscribe();

		const [event] = events;
		expect(event?.body[0]).toBe(MODEM_IFACE);
		expect(event?.body[1]).toEqual([]);
		expect(event?.body[2]).toEqual(['SignalQuality']);
	});

	test('a changed PropertiesChanged carries new values in the changed dict', async () => {
		const events: SignalEvent[] = [];
		const sub = await transport.subscribeSignal(
			{ interface: PROPERTIES_IFACE, member: 'PropertiesChanged', path: modemPath(0) },
			(event) => events.push(event),
		);
		fake.changeProperties(modemPath(0), MODEM_IFACE, [['SignalQuality', ['(ub)', [42, true]]]]);
		await waitFor(() => events.length > 0);
		await sub.unsubscribe();

		const [event] = events;
		expect(event?.body[1]).toEqual([['SignalQuality', { signature: '(ub)', value: [42, true] }]]);
		expect(event?.body[2]).toEqual([]);
	});

	test('SIM hot-swap replaces the /SIM object and invalidates the modem Sim', async () => {
		const events: SignalEvent[] = [];
		const sub = await transport.subscribeSignal(
			{ interface: PROPERTIES_IFACE, member: 'PropertiesChanged', path: modemPath(0) },
			(event) => events.push(event),
		);
		fake.replaceSim(0, { index: 7, iccid: '8900000000000000007', imsi: '001010000000007' });
		await waitFor(() => events.length > 0);
		await sub.unsubscribe();

		expect(events[0]?.body[2]).toEqual(['Sim']);
		const tree = await fetchManagedObjects(transport, fake.busName);
		expect(propValue(findInterface(tree, modemPath(0), MODEM_IFACE), 'Sim')).toBe(simPath(7));
		expect(hasInterface(tree, simPath(0), SIM_IFACE)).toBe(false);
		expect(propValue(findInterface(tree, simPath(7), SIM_IFACE), 'SimIdentifier')).toBe(
			'8900000000000000007',
		);
	});
});

describe.skipIf(!hasSessionBus())('MM property shapes — 1.20 vs 1.24', () => {
	async function readModemProps(shape: '1.20' | '1.24') {
		const busAddress = sessionBusAddress();
		const fake = await FakeModemManager.start({ busAddress, shape, modems: [MODEM_0] });
		const transport = createDbusTransport({ busAddress });
		await transport.connect();
		try {
			const tree = await fetchManagedObjects(transport, fake.busName);
			return findInterface(tree, modemPath(0), MODEM_IFACE);
		} finally {
			await transport.disconnect();
			await fake.stop();
		}
	}

	test('the 1.20-shape carries Device but omits Physdev', async () => {
		const props = await readModemProps('1.20');
		expect(propValue(props, 'Device')).toBe('slot-usb2-1');
		expect(propValue(props, 'Physdev')).toBeUndefined();
	});

	test('the 1.24-shape carries both Device and Physdev', async () => {
		const props = await readModemProps('1.24');
		expect(propValue(props, 'Device')).toBe('slot-usb2-1');
		expect(typeof propValue(props, 'Physdev')).toBe('string');
	});
});
