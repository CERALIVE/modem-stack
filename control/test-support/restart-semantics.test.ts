// Restart / lifecycle semantics — the QA-failure scenario A3.1 will build against.
//
// When the MM service loses or regains bus ownership, a correct consumer must treat it
// as a source becoming unavailable, NOT as the modems being removed. This proves the
// FAKE emits the right signals for that: dropping the name produces a real daemon
// `NameOwnerChanged` (owner → "") with ZERO spurious `InterfacesRemoved`, reclaiming it
// produces `NameOwnerChanged` ("" → owner), and a full restart hands the name to a NEW
// owner (a new epoch) — still without any bogus removal. Add/remove drive the
// `InterfacesAdded` / `InterfacesRemoved` object-lifecycle signals. Run under
// `dbus-run-session`. (A3.1 owns the CONSUMER logic; this task proves the emissions.)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDbusTransport, type DbusTransport, type SignalEvent } from '../src/transport';
import {
	BUS_NAME,
	bearerPath,
	FakeModemManager,
	type ModemSpec,
	modemPath,
	OBJECT_MANAGER_IFACE,
	simPath,
} from './fake-mm';
import { hasSessionBus, sessionBusAddress, warnSkippedWithoutBus } from './session-bus';

warnSkippedWithoutBus('MM fake restart semantics');

const DBUS_IFACE = 'org.freedesktop.DBus';

const MODEM_0: ModemSpec = {
	index: 0,
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

const paths = (events: readonly SignalEvent[]): unknown[] => events.map((event) => event.body[0]);

describe.skipIf(!hasSessionBus())('MM fake — restart / name-ownership semantics', () => {
	let fake: FakeModemManager;
	let transport: DbusTransport;
	let nameEvents: SignalEvent[];
	let removedEvents: SignalEvent[];
	let addedEvents: SignalEvent[];

	beforeEach(async () => {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, modems: [MODEM_0] });
		transport = createDbusTransport({ busAddress });
		await transport.connect();
		nameEvents = [];
		removedEvents = [];
		addedEvents = [];
		await transport.subscribeSignal(
			{ interface: DBUS_IFACE, member: 'NameOwnerChanged' },
			(event) => {
				if (event.body[0] === BUS_NAME) {
					nameEvents.push(event);
				}
			},
		);
		await transport.subscribeSignal(
			{ interface: OBJECT_MANAGER_IFACE, member: 'InterfacesRemoved' },
			(event) => removedEvents.push(event),
		);
		await transport.subscribeSignal(
			{ interface: OBJECT_MANAGER_IFACE, member: 'InterfacesAdded' },
			(event) => addedEvents.push(event),
		);
	});

	afterEach(async () => {
		await transport.disconnect();
		await fake.stop();
	});

	test('dropping the name emits NameOwnerChanged (owner → "") with ZERO removals', async () => {
		const owner = fake.uniqueName;
		await fake.dropName();
		await waitFor(() => nameEvents.some((event) => event.body[2] === ''));

		const lost = nameEvents.find((event) => event.body[2] === '');
		expect(lost?.body[0]).toBe(BUS_NAME);
		expect(lost?.body[1]).toBe(owner);
		// The whole point: name loss is NOT a modem removal.
		await sleep(50);
		expect(removedEvents).toHaveLength(0);
	});

	test('reclaiming the name emits NameOwnerChanged ("" → owner)', async () => {
		await fake.dropName();
		await waitFor(() => nameEvents.some((event) => event.body[2] === ''));
		await fake.reclaimName();
		await waitFor(() => nameEvents.some((event) => event.body[1] === '' && event.body[2] !== ''));

		const regained = nameEvents.find((event) => event.body[1] === '' && event.body[2] !== '');
		expect(regained?.body[0]).toBe(BUS_NAME);
		expect(regained?.body[2]).toBe(fake.uniqueName);
		expect(removedEvents).toHaveLength(0);
	});

	test('a full restart hands the name to a NEW owner with ZERO removals', async () => {
		const before = fake.uniqueName;
		await fake.restart();
		const after = fake.uniqueName;
		expect(after).not.toBe(before);
		await waitFor(() => nameEvents.some((event) => event.body[2] === after));

		const handoff = nameEvents.find((event) => event.body[2] === after);
		expect(handoff?.body[0]).toBe(BUS_NAME);
		await sleep(50);
		expect(removedEvents).toHaveLength(0);
	});

	test('add / remove drive InterfacesAdded / InterfacesRemoved for every object', async () => {
		const modem1: ModemSpec = {
			index: 1,
			sims: [{ index: 1, iccid: '8900000000000000002', imsi: '001010000000002', active: true }],
		};
		fake.addModem(modem1);
		await waitFor(() => addedEvents.length >= 3);
		expect(paths(addedEvents)).toEqual(
			expect.arrayContaining([modemPath(1), simPath(1), bearerPath(1)]),
		);

		fake.removeModem(1);
		await waitFor(() => removedEvents.length >= 3);
		expect(paths(removedEvents)).toEqual(
			expect.arrayContaining([modemPath(1), simPath(1), bearerPath(1)]),
		);
	});
});
