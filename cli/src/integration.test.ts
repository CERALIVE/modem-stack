// Harness-driven CLI integration — probe / watch / apply / unlock-pin run end-to-end
// against the A2.3 fake ModemManager (real D-Bus, EXTERNAL auth) plus the A2.3 fake
// NetworkManager. Runs under `dbus-run-session -- bun test cli`. The commands are the
// dev/TS build here (faster iteration); the compiled binary is exercised separately by
// the cross-arch probe smoke.

import { afterEach, describe, expect, test } from 'bun:test';
import { createDbusTransport, type DbusTransport } from '@ceralive/modem-control/transport';
import {
	FakeModemManager,
	MM_LOCK_SIM_PIN,
	type ModemSpec,
} from '../../control/test-support/fake-mm';
import { FakeNetworkManagerPort } from '../../control/test-support/fake-nm';
import {
	hasSessionBus,
	sessionBusAddress,
	warnSkippedWithoutBus,
} from '../../control/test-support/session-bus';
import { runApply } from './commands/apply';
import { runProbe } from './commands/probe';
import { runUnlock } from './commands/unlock';
import { runWatch } from './commands/watch';
import { createStackContext, type StackContext } from './context';
import { type CapturingIo, capturingIo } from './io';
import type { PolicyFileSpec } from './policy-file';

warnSkippedWithoutBus('bench CLI integration');

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

const spec = (index: number, extra: Partial<ModemSpec> = {}): ModemSpec => ({
	index,
	sims: [
		{ index, iccid: `890000000000000000${index}`, imsi: `00101000000000${index}`, active: true },
	],
	...extra,
});

const POLICY: PolicyFileSpec = {
	enabled: true,
	connection: { apn: 'auto', ipFamily: 'ipv4v6' },
	roaming: false,
	radio: { preferenceOrdered: ['5gnr', 'lte', 'umts', 'gsm'] },
};

describe.skipIf(!hasSessionBus())('bench CLI — against the fake MM + NM', () => {
	let fake: FakeModemManager;
	let transport: DbusTransport;
	let ctx: StackContext;

	async function boot(modems: readonly ModemSpec[]): Promise<CapturingIo> {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, modems });
		transport = createDbusTransport({ busAddress });
		ctx = createStackContext(
			{ busAddress },
			{ transport, nm: new FakeNetworkManagerPort(), enumerate: () => Promise.resolve([]) },
		);
		return capturingIo();
	}

	afterEach(async () => {
		await ctx.close();
		await transport.disconnect();
		await fake.stop();
	});

	test('probe prints a stack snapshot and ends with PROBE OK; ICCID is redacted', async () => {
		const io = await boot([spec(0), spec(1)]);
		const code = await runProbe(ctx, io);
		expect(code).toBe(0);
		const text = io.stdout.join('\n');
		expect(text).toMatch(/PROBE OK: external-auth, objects=[1-9]/);
		expect(text).toContain('/Modem/0');
		expect(text).toContain('/Modem/1');
		expect(text).toContain('sim=[redacted]');
		// The sensitive ICCID must NEVER appear raw in the output.
		expect(text).not.toContain('8900000000000000000');
	});

	test('watch discriminates bus-loss (source-unavailable, retained) from real removal', async () => {
		const io = await boot([spec(0)]);
		const controller = new AbortController();
		const watching = runWatch(ctx, io, { signal: controller.signal });

		await waitFor(() => io.stdout.some((l) => l.startsWith('+ ADDED') && l.includes('/Modem/0')));
		fake.addModem(spec(1));
		await waitFor(() => io.stdout.some((l) => l.includes('/Modem/1')));

		await fake.dropName();
		await waitFor(() => io.stdout.some((l) => l.startsWith('! SOURCE-UNAVAILABLE')));
		await fake.reclaimName();
		await waitFor(() =>
			io.stdout.some((l) => l.startsWith('~ CHANGED') && l.includes('health=live')),
		);

		fake.removeModem(1);
		await waitFor(() => io.stdout.some((l) => l.startsWith('- REMOVED') && l.includes('/Modem/1')));

		controller.abort();
		expect(await watching).toBe(0);
		const text = io.stdout.join('\n');
		expect(text).toContain('! SOURCE-UNAVAILABLE');
		expect(text).toMatch(/- REMOVED .*\/Modem\/1/);
	}, 15_000);

	test('apply reconciles the policy: creates the profile, sets radio, prints receipts', async () => {
		const io = await boot([spec(0)]);
		const code = await runApply(ctx, io, POLICY);
		expect(code).toBe(0);
		const text = io.stdout.join('\n');
		expect(text).toContain('applied nm.createGsmProfile');
		expect(text).toContain('applied mm.setRadioModes');
		expect(text).toContain('receipts:');
		expect(text).toMatch(/connection: (applied|pending)/);
		expect(ctx.nm instanceof FakeNetworkManagerPort).toBe(true);
	});

	test('unlock-pin submits the PIN and never echoes it', async () => {
		const io = capturingIo(['1234']);
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({
			busAddress,
			modems: [spec(0, { unlockRequired: MM_LOCK_SIM_PIN })],
		});
		fake.expectPin(0, '1234');
		transport = createDbusTransport({ busAddress });
		ctx = createStackContext(
			{ busAddress },
			{ transport, nm: new FakeNetworkManagerPort(), enumerate: () => Promise.resolve([]) },
		);

		const code = await runUnlock(ctx, io, 'pin', undefined);
		expect(code).toBe(0);
		const text = io.stdout.join('\n');
		expect(text).toContain('unlock-pin: unlocked');
		// The secret must never be echoed to any output stream.
		expect(text).not.toContain('1234');
		expect(io.stderr.join('\n')).not.toContain('1234');
	});
});
