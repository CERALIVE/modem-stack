// Conformance half (a): round-trip representative signatures against a fake service built
// on the SAME `@httptoolkit/dbus-native` library, over a real session bus. This proves the
// transport works end-to-end against the daemon; half (b) proves it against an independent
// producer. Run under `dbus-run-session -- bun test control/src/transport`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbusTransport } from './index';
import { createDbusTransport } from './index';
import {
	FAKE_IFACE,
	FAKE_PATH,
	type FakeService,
	INT64_MAX,
	startFakeService,
	UINT64_MAX,
} from './test-support/fake-service';

const SESSION_BUS = process.env.DBUS_SESSION_BUS_ADDRESS;

describe.skipIf(!SESSION_BUS)('conformance vs same-library fake service', () => {
	let fake: FakeService;
	let transport: DbusTransport;

	beforeAll(async () => {
		const busAddress = SESSION_BUS as string;
		fake = await startFakeService({ busAddress });
		transport = createDbusTransport({ busAddress });
		await transport.connect();
	});

	afterAll(async () => {
		await transport.disconnect();
		await fake.stop();
	});

	const call = (member: string, signature?: string, args?: unknown[]) =>
		transport.callMethod({
			destination: fake.busName,
			path: FAKE_PATH,
			interface: FAKE_IFACE,
			member,
			...(signature !== undefined ? { signature } : {}),
			...(args !== undefined ? { args: args as never } : {}),
		});

	test('a basic string method replies', async () => {
		const reply = await call('Ping');
		expect(reply.signature).toBe('s');
		expect(reply.body[0]).toBe('pong');
	});

	test('GetManagedObjects decodes the a{oa{sa{sv}}} shape with a 64-bit variant', async () => {
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
							['SignalQuality', { signature: 'u', value: 87 }],
							['DeviceIdentifier', { signature: 's', value: 'fake-device-0' }],
						],
					],
				],
			],
		]);
	});

	test('an INT64 reply above 2^53 decodes to an exact bigint', async () => {
		const reply = await call('GetInt64');
		expect(reply.body[0]).toBe(INT64_MAX);
		expect(typeof reply.body[0]).toBe('bigint');
	});

	test('a UINT64 reply at the full 64-bit maximum decodes exactly', async () => {
		const reply = await call('GetUint64');
		expect(reply.body[0]).toBe(UINT64_MAX);
	});

	test('2^63-1 round-trips through the daemon exactly (encode + decode)', async () => {
		const reply = await call('EchoUint64', 't', [INT64_MAX]);
		expect(reply.body[0]).toBe(INT64_MAX);
	});

	test('the full UINT64 maximum round-trips through the daemon exactly', async () => {
		const reply = await call('EchoUint64', 't', [UINT64_MAX]);
		expect(reply.body[0]).toBe(UINT64_MAX);
	});

	test('a negative INT64 round-trips through the daemon exactly', async () => {
		const reply = await call('EchoInt64', 'x', [-INT64_MAX]);
		expect(reply.body[0]).toBe(-INT64_MAX);
	});

	test('the service reports back the exact 64-bit value we encoded', async () => {
		const reply = await call('DescribeUint64', 't', [INT64_MAX]);
		expect(reply.body[0]).toBe(INT64_MAX.toString());
	});

	test('passing a JS number for a 64-bit argument is refused before the wire', async () => {
		await expect(
			transport.callMethod({
				destination: fake.busName,
				path: FAKE_PATH,
				interface: FAKE_IFACE,
				member: 'EchoUint64',
				signature: 't',
				args: [123 as never],
			}),
		).rejects.toThrow('requires a bigint');
	});
});
