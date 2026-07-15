// Conformance half (b): round-trip against an INDEPENDENT `python3-dbus` producer running
// as a subprocess — a different implementation on the wire than the JavaScript library
// under test. Agreement with a foreign producer, not just the same-library fake, is the
// real proof the codec is correct. Exercises the MM `a{oa{sa{sv}}}` shape, `x`/`t` above
// 2^53, variants, and a `PropertiesChanged` signal carrying invalidated properties.
//
// Skips loudly (never fails) when the session bus or `dbus-python` bindings are absent.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { DbusTransport, SignalEvent } from './index';
import { createDbusTransport } from './index';

const SESSION_BUS = process.env.DBUS_SESSION_BUS_ADDRESS;

const PY_BUS_NAME = 'tv.ceralive.ModemStackPy';
const PY_PATH = '/tv/ceralive/pyfake';
const PY_IFACE = 'tv.ceralive.ModemStackPy.Conformance';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

function hasDbusPython(): boolean {
	const probe = Bun.spawnSync(['python3', '-c', 'import dbus, dbus.service, gi.repository.GLib']);
	return probe.exitCode === 0;
}

async function waitForReady(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<void> {
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let seen = '';
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) {
				throw new Error('python producer exited before signalling READY');
			}
			seen += decoder.decode(value, { stream: true });
			if (seen.includes('READY')) {
				return;
			}
		}
		throw new Error('timed out waiting for python producer READY');
	} finally {
		reader.releaseLock();
	}
}

const runnable = Boolean(SESSION_BUS) && hasDbusPython();

describe.skipIf(!runnable)('conformance vs independent python3-dbus producer', () => {
	let producer: ReturnType<typeof Bun.spawn>;
	let transport: DbusTransport;

	beforeAll(async () => {
		const script = join(import.meta.dir, 'test-support', 'independent-producer.py');
		producer = Bun.spawn(['python3', script], {
			stdout: 'pipe',
			stderr: 'inherit',
			env: process.env,
		});
		await waitForReady(producer, 10_000);
		transport = createDbusTransport({ busAddress: SESSION_BUS as string });
		await transport.connect();
	});

	afterAll(async () => {
		await transport.disconnect();
		producer.kill();
	});

	const call = (member: string, signature?: string, args?: unknown[]) =>
		transport.callMethod({
			destination: PY_BUS_NAME,
			path: PY_PATH,
			interface: PY_IFACE,
			member,
			...(signature !== undefined ? { signature } : {}),
			...(args !== undefined ? { args: args as never } : {}),
		});

	test('the independent producer returns the a{oa{sa{sv}}} shape with 64-bit variants', async () => {
		const reply = await call('GetManagedObjects');
		expect(reply.signature).toBe('a{oa{sa{sv}}}');
		expect(reply.body[0]).toEqual([
			[
				'/org/freedesktop/ModemManager1/Modem/0',
				[
					[
						'org.freedesktop.ModemManager1.Modem',
						[
							['SupportedCapabilities', { signature: 't', value: UINT64_MAX }],
							['MaxBearers', { signature: 'x', value: -INT64_MAX }],
							['SignalQuality', { signature: 'u', value: 87 }],
							['DeviceIdentifier', { signature: 's', value: 'py-device-0' }],
						],
					],
				],
			],
		]);
	});

	test('an INT64 above 2^53 from the independent producer decodes to an exact bigint', async () => {
		const reply = await call('GetInt64');
		expect(reply.body[0]).toBe(INT64_MAX);
	});

	test('a UINT64 at the 64-bit maximum from the independent producer decodes exactly', async () => {
		const reply = await call('GetUint64');
		expect(reply.body[0]).toBe(UINT64_MAX);
	});

	test('a bare variant from the independent producer preserves signature and value', async () => {
		const reply = await call('GetVariant');
		expect(reply.body[0]).toEqual({ signature: 't', value: UINT64_MAX });
	});

	test('2^63-1 round-trips through the independent producer exactly', async () => {
		const reply = await call('EchoUint64', 't', [INT64_MAX]);
		expect(reply.body[0]).toBe(INT64_MAX);
	});

	test('the independent producer confirms the exact 64-bit value we encoded', async () => {
		const reply = await call('DescribeUint64', 't', [UINT64_MAX]);
		expect(reply.body[0]).toBe(UINT64_MAX.toString());
	});

	test('a PropertiesChanged signal decodes changed 64-bit values and invalidated names', async () => {
		let resolveEvent: (event: SignalEvent) => void = () => undefined;
		const received = new Promise<SignalEvent>((resolve) => {
			resolveEvent = resolve;
		});
		const subscription = await transport.subscribeSignal(
			{ interface: PROPERTIES_IFACE, member: 'PropertiesChanged', path: PY_PATH },
			(event) => resolveEvent(event),
		);
		await call('TriggerPropertiesChanged');

		const event = await received;
		expect(event.signature).toBe('sa{sv}as');
		const [interfaceName, changed, invalidated] = event.body;
		expect(interfaceName).toBe(PY_IFACE);
		expect(changed).toEqual([
			['AccessTechnologies', { signature: 't', value: UINT64_MAX }],
			['SignalQuality', { signature: 'u', value: 42 }],
		]);
		expect(invalidated).toEqual(['OperatorName', 'OperatorCode']);
		await subscription.unsubscribe();
	});
});
