// D-Bus mutations against the MM-faithful fake — the mode/PIN/PUK/scan/slot cases,
// per-modem serialization proof (call log), and the zero-bearer-calls tripwire.
//
// Runs under `dbus-run-session -- bun test control/test-support`.

import { afterEach, describe, expect, test } from 'bun:test';
import { createMmDbusBackend, type MmDbusBackend } from '../src/backend';
import { runtimePath } from '../src/domain';
import type { ModemRef } from '../src/ports';
import { createDbusTransport, type DbusTransport } from '../src/transport';
import {
	BUS_NAME,
	FakeModemManager,
	MM_LOCK_NONE,
	MM_LOCK_SIM_PIN,
	MM_LOCK_SIM_PUK,
	type ModemSpec,
	modemPath,
	SIMPLE_IFACE,
} from './fake-mm';
import { hasSessionBus, sessionBusAddress, warnSkippedWithoutBus } from './session-bus';

warnSkippedWithoutBus('D-Bus mutations');

const ref = (index: number): ModemRef => runtimePath(modemPath(index)) as ModemRef;

const sim = (index: number) => ({
	index,
	iccid: `890000000000000000${index}`,
	imsi: `00101000000000${index}`,
	active: true,
});

const modem = (index: number, extra: Partial<ModemSpec> = {}): ModemSpec => ({
	index,
	sims: [sim(index)],
	...extra,
});

describe.skipIf(!hasSessionBus())('MmDbusBackend — mutations', () => {
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

	test('setRadioModes applies a radio-mode receipt', async () => {
		await boot([modem(0)]);
		const receipt = await backend.setRadioModes(ref(0), { preferenceOrdered: ['5gnr', 'lte'] });
		expect(receipt.dimension).toBe('radio');
		expect(receipt.status).toBe('applied');
	});

	test('setPrimarySimSlot is unsupported on a single-slot modem', async () => {
		await boot([modem(0)]);
		const receipt = await backend.setPrimarySimSlot(ref(0), 1);
		expect(receipt.status).toBe('unsupported');
	});

	test('setPrimarySimSlot applies on a multi-slot modem', async () => {
		await boot([{ index: 0, sims: [sim(0), sim(10)] }]);
		const receipt = await backend.setPrimarySimSlot(ref(0), 2);
		expect(receipt.status).toBe('applied');
	});

	test('sendPin unlocks with the correct PIN', async () => {
		await boot([
			modem(0, { unlockRequired: MM_LOCK_SIM_PIN, unlockRetries: [[MM_LOCK_SIM_PIN, 3]] }),
		]);
		fake.expectPin(0, '0000');
		const result = await backend.sendPin(ref(0), '0000');
		expect(result.outcome).toBe('unlocked');
	});

	test('sendPin reports incorrect-pin with remaining attempts (exactly once)', async () => {
		await boot([
			modem(0, { unlockRequired: MM_LOCK_SIM_PIN, unlockRetries: [[MM_LOCK_SIM_PIN, 3]] }),
		]);
		fake.expectPin(0, '0000');
		const result = await backend.sendPin(ref(0), '9999');
		expect(result.outcome).toBe('incorrect-pin');
		expect(result.remainingAttempts).toBe(2);
	});

	test('sendPin surfaces a PUK lock when the last PIN attempt is spent (never a resubmit)', async () => {
		await boot([
			modem(0, { unlockRequired: MM_LOCK_SIM_PIN, unlockRetries: [[MM_LOCK_SIM_PIN, 1]] }),
		]);
		fake.expectPin(0, '0000');
		const result = await backend.sendPin(ref(0), '9999');
		expect(result.outcome).toBe('sim-puk-required');
	});

	test('sendPin on an unlocked SIM is a no-op unlocked receipt', async () => {
		await boot([modem(0, { unlockRequired: MM_LOCK_NONE })]);
		const result = await backend.sendPin(ref(0), '0000');
		expect(result.outcome).toBe('unlocked');
	});

	test('sendPuk unblocks with the correct PUK', async () => {
		await boot([
			modem(0, { unlockRequired: MM_LOCK_SIM_PUK, unlockRetries: [[MM_LOCK_SIM_PUK, 10]] }),
		]);
		fake.expectPuk(0, '12345678');
		const result = await backend.sendPuk(ref(0), '12345678', '1111');
		expect(result.outcome).toBe('unlocked');
	});

	test('sendPuk exhaustion permanently blocks the SIM (locked, zero remaining)', async () => {
		await boot([
			modem(0, { unlockRequired: MM_LOCK_SIM_PUK, unlockRetries: [[MM_LOCK_SIM_PUK, 1]] }),
		]);
		fake.expectPuk(0, '12345678');
		const result = await backend.sendPuk(ref(0), '00000000', '1111');
		expect(result.outcome).toBe('permanently-blocked');
		expect(result.remainingAttempts).toBe(0);
	});

	test('scanNetworks returns the configured operators', async () => {
		await boot([modem(0)]);
		fake.configureScan(0, [
			{ operatorCode: '310260', operatorName: 'T-Mobile', availability: 2 },
			{ operatorCode: '311480', operatorName: 'Verizon', availability: 1 },
		]);
		const result = await backend.scanNetworks(ref(0));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.networks).toHaveLength(2);
			expect(result.networks[0]).toMatchObject({ operatorCode: '310260', availability: 'current' });
			expect(result.networks[1]).toMatchObject({
				operatorName: 'Verizon',
				availability: 'available',
			});
		}
	});
});

describe.skipIf(!hasSessionBus())('MmDbusBackend — serialization + bearer safety', () => {
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

	test('two disruptive ops on the SAME modem serialize (no interleave)', async () => {
		await boot([modem(0)]);
		fake.setReplyDelay(80);
		fake.clearLogs();
		await Promise.all([
			backend.setRadioModes(ref(0), { preferenceOrdered: ['lte'] }),
			backend.setRadioModes(ref(0), { preferenceOrdered: ['5gnr'] }),
		]);
		expect(fake.callLog).toEqual([
			'SetCurrentModes:start:0',
			'SetCurrentModes:end:0',
			'SetCurrentModes:start:0',
			'SetCurrentModes:end:0',
		]);
	});

	test('concurrent mode-set + PIN on ONE modem serialize', async () => {
		await boot([
			modem(0, { unlockRequired: MM_LOCK_SIM_PIN, unlockRetries: [[MM_LOCK_SIM_PIN, 3]] }),
		]);
		fake.expectPin(0, '0000');
		fake.setReplyDelay(60);
		fake.clearLogs();
		await Promise.all([
			backend.setRadioModes(ref(0), { preferenceOrdered: ['lte'] }),
			backend.sendPin(ref(0), '0000'),
		]);
		const log = fake.callLog;
		expect(log.indexOf('SetCurrentModes:end:0')).toBeLessThan(log.indexOf('SendPin:start:0'));
	});

	test('disruptive ops on DIFFERENT modems run independently (overlap)', async () => {
		await boot([modem(0), modem(1)]);
		fake.setReplyDelay(100);
		fake.clearLogs();
		await Promise.all([
			backend.setRadioModes(ref(0), { preferenceOrdered: ['lte'] }),
			backend.setRadioModes(ref(1), { preferenceOrdered: ['lte'] }),
		]);
		const log = fake.callLog;
		const lastStart = Math.max(
			log.indexOf('SetCurrentModes:start:0'),
			log.indexOf('SetCurrentModes:start:1'),
		);
		const firstEnd = Math.min(
			log.indexOf('SetCurrentModes:end:0'),
			log.indexOf('SetCurrentModes:end:1'),
		);
		expect(lastStart).toBeLessThan(firstEnd);
	});

	test('the A2.3 bearer tripwire still fires — nothing here activates a bearer', async () => {
		await boot([modem(0)]);
		await expect(
			transport.callMethod({
				destination: BUS_NAME,
				path: modemPath(0),
				interface: SIMPLE_IFACE,
				member: 'Connect',
			}),
		).rejects.toThrow(/TRIPWIRE/);
	});
});
