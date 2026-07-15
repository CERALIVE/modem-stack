#!/usr/bin/env bun

// Cross-arch D-Bus probe smoke harness.
//
// A self-contained smoke binary (compiled for amd64 + arm64) that spins the A2.3 fake
// ModemManager on the session bus and PROVES the four properties the plan requires:
//   1. EXTERNAL-auth handshake succeeds + GetManagedObjects returns real data — via the
//      SHIPPED compiled `modem-control probe --bus-address <addr>` subprocess (`--cli`).
//   2. at least one signal is received (InterfacesAdded -> a `+ ADDED` watch event).
//   3. MM-restart / bus-loss vs real-removal are DISCRIMINATED: a bus name drop marks
//      the modem SOURCE-UNAVAILABLE with its row RETAINED, whereas an InterfacesRemoved
//      is a `- REMOVED` — two different observable outcomes (A3.1 epoch authority).
//
// `--negative` spins the fake with ZERO modems (a deliberately broken fixture): the probe
// assertion then fails and the harness exits non-zero, proving the smoke is not a no-op.

import { parseArgs } from 'node:util';
import { createDbusTransport } from '@ceralive/modem-control/transport';
import { FakeModemManager, type ModemSpec } from '../../control/test-support/fake-mm';
import { FakeNetworkManagerPort } from '../../control/test-support/fake-nm';
import { runWatch } from '../src/commands/watch';
import { createStackContext } from '../src/context';
import { capturingIo } from '../src/io';

const ICCID_PREFIX = '89000000000000';

function fail(message: string): never {
	console.error(`SMOKE FAIL: ${message}`);
	process.exit(1);
}

function check(condition: boolean, message: string): void {
	if (!condition) {
		fail(message);
	}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			fail(`timed out waiting for ${what}`);
		}
		await sleep(10);
	}
}

const spec = (index: number): ModemSpec => ({
	index,
	sims: [
		{
			index,
			iccid: `${ICCID_PREFIX}${1000 + index}`,
			imsi: `0010100000${1000 + index}`,
			active: true,
		},
	],
});

/** Run the SHIPPED `modem-control probe` binary and assert the handshake + data. */
async function probeCheck(
	cliPath: string,
	busAddress: string,
	expectModems: number,
): Promise<void> {
	const proc = Bun.spawn([cliPath, 'probe', '--bus-address', busAddress], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	process.stdout.write(stdout);
	const okLine = stdout.split('\n').find((l) => l.startsWith('PROBE OK: external-auth, objects='));
	check(
		okLine !== undefined,
		`probe printed no PROBE OK line (exit ${code}); stderr=${stderr.trim()}`,
	);
	const objects = Number((okLine as string).split('objects=')[1]);
	check(objects >= expectModems, `probe reported objects=${objects}, expected >= ${expectModems}`);
	for (let index = 0; index < expectModems; index += 1) {
		check(stdout.includes(`/Modem/${index}`), `probe did not list /Modem/${index}`);
	}
	check(!stdout.includes(ICCID_PREFIX), 'probe leaked a raw ICCID — redaction failed');
	console.log(`SMOKE: probe OK (external-auth handshake + GetManagedObjects, objects=${objects})`);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { cli: { type: 'string' }, negative: { type: 'boolean', default: false } },
	});
	const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
	if (busAddress === undefined) {
		fail('no DBUS_SESSION_BUS_ADDRESS — run under dbus-run-session');
	}

	const modems = values.negative ? [] : [spec(0), spec(1)];
	const fake = await FakeModemManager.start({ busAddress, modems });

	if (values.cli !== undefined) {
		await probeCheck(values.cli, busAddress, 2);
	}

	// Signal + discrimination, in-process against the SAME fake.
	const transport = createDbusTransport({ busAddress });
	const ctx = createStackContext(
		{ busAddress },
		{ transport, nm: new FakeNetworkManagerPort(), enumerate: () => Promise.resolve([]) },
	);
	const io = capturingIo();
	const controller = new AbortController();
	const watching = runWatch(ctx, io, { signal: controller.signal });

	await waitFor(
		() => io.stdout.some((l) => l.startsWith('+ ADDED') && l.includes('/Modem/0')),
		'initial modem',
	);
	fake.addModem(spec(2));
	await waitFor(() => io.stdout.some((l) => l.includes('/Modem/2')), 'InterfacesAdded signal');
	console.log('SMOKE: signal received (InterfacesAdded -> + ADDED)');

	await fake.dropName();
	await waitFor(
		() => io.stdout.some((l) => l.startsWith('! SOURCE-UNAVAILABLE')),
		'bus-loss -> source-unavailable',
	);
	check(
		io.stdout.some((l) => l.includes('sourceUnavailable')),
		'bus-loss did not mark the modem sourceUnavailable',
	);
	check(
		!io.stdout.some((l) => l.startsWith('- REMOVED')),
		'bus-loss was mis-read as a removal (should retain the row)',
	);
	await fake.reclaimName();
	await waitFor(() => io.stdout.some((l) => l.includes('health=live')), 'restore after reclaim');
	console.log('SMOKE: bus-loss -> SOURCE-UNAVAILABLE (row retained, NOT removed)');

	fake.removeModem(2);
	await waitFor(
		() => io.stdout.some((l) => l.startsWith('- REMOVED') && l.includes('/Modem/2')),
		'real removal',
	);
	console.log('SMOKE: real removal -> REMOVED (discriminated from bus-loss)');

	controller.abort();
	await watching;
	await ctx.close();
	await transport.disconnect();
	await fake.stop();
	console.log('SMOKE PASS');
	process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
