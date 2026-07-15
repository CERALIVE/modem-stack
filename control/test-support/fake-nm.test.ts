// Stateful NM harness — proves the nmcli-runner stub actually remembers state.
//
// These are real readback assertions, not mocked returns: a `connection show` after a
// `create` / `update` reflects exactly the fields written, and activation state tracks
// which UUID is up on which device. No D-Bus is involved, so the suite always runs.
// A4.1's `NmcliNmPort` injects this same runner to assert its nine-field GSM writes.

import { describe, expect, test } from 'bun:test';
import { connectionId, deviceIfname, type GsmProfileInput } from '../src/ports';
import { FakeNetworkManagerPort, StatefulNmcliRunner } from './fake-nm';

const BASE_PROFILE: GsmProfileInput = {
	connectionName: 'cell-home',
	apn: 'internet',
	username: 'user1',
	password: 'secret',
	homeOnly: true,
	autoConfig: false,
	networkId: '',
};

describe('StatefulNmcliRunner — raw argv state machine', () => {
	test('a connection added is then visible in connection show', () => {
		const runner = new StatefulNmcliRunner();
		const add = runner.run([
			'connection',
			'add',
			'type',
			'gsm',
			'con-name',
			'c1',
			'gsm.apn',
			'iot',
		]);
		const uuid = /\(([^)]+)\)/.exec(add.stdout)?.[1] ?? '';

		const show = runner.run(['-t', '-f', 'gsm.apn', 'connection', 'show', uuid]);
		expect(show.exitCode).toBe(0);
		expect(show.stdout).toBe('gsm.apn:iot');
	});

	test('modify updates a stored field and readback reflects it', () => {
		const runner = new StatefulNmcliRunner();
		const uuid = /\(([^)]+)\)/.exec(
			runner.run(['connection', 'add', 'type', 'gsm', 'con-name', 'c1', 'gsm.apn', 'old']).stdout,
		)?.[1] as string;

		runner.run(['connection', 'modify', uuid, 'gsm.apn', 'new']);
		expect(runner.run(['-t', '-f', 'gsm.apn', 'connection', 'show', uuid]).stdout).toBe(
			'gsm.apn:new',
		);
	});

	test('up marks a device active and device disconnect clears it', () => {
		const runner = new StatefulNmcliRunner();
		const uuid = /\(([^)]+)\)/.exec(
			runner.run(['connection', 'add', 'type', 'gsm', 'con-name', 'c1']).stdout,
		)?.[1] as string;

		runner.run(['connection', 'up', uuid, 'ifname', 'wwan0']);
		expect(runner.run(['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']).stdout).toBe(
			`${uuid}:wwan0`,
		);

		runner.run(['device', 'disconnect', 'wwan0']);
		expect(runner.run(['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']).stdout).toBe(
			'',
		);
	});
});

describe('FakeNetworkManagerPort — port contract over the stateful runner', () => {
	test('create then read returns the exact fields written', async () => {
		const nm = new FakeNetworkManagerPort();
		const created = await nm.createGsmProfile(BASE_PROFILE);
		const readBack = await nm.readGsmProfile(created.connectionId);

		expect(readBack?.connectionName).toBe('cell-home');
		expect(readBack?.apn).toBe('internet');
		expect(readBack?.username).toBe('user1');
		expect(readBack?.password).toBe('secret');
		expect(readBack?.homeOnly).toBe(true);
		expect(readBack?.autoConfig).toBe(false);
	});

	test('an update is persisted and reflected on the next read (manual → auto APN)', async () => {
		const nm = new FakeNetworkManagerPort();
		const created = await nm.createGsmProfile(BASE_PROFILE);

		const updated = await nm.updateGsmProfile(created.connectionId, {
			apn: '',
			username: '',
			password: '',
			autoConfig: true,
		});
		expect(updated.autoConfig).toBe(true);
		expect(updated.apn).toBe('');
		expect(updated.username).toBeUndefined();
		expect(updated.password).toBeUndefined();
	});

	test('activation on an exact device is readable, and deactivate clears it', async () => {
		const nm = new FakeNetworkManagerPort();
		const created = await nm.createGsmProfile(BASE_PROFILE);
		const ifname = deviceIfname('wwan0');

		const up = await nm.activate(created.connectionId, ifname);
		expect(up.status).toBe('applied');

		const down = await nm.deactivate(created.connectionId, ifname);
		expect(down.status).toBe('applied');
	});

	test('a quiesce lease deactivates the device and release reactivates it', async () => {
		const nm = new FakeNetworkManagerPort();
		const created = await nm.createGsmProfile(BASE_PROFILE);
		const ifname = deviceIfname('wwan0');
		await nm.activate(created.connectionId, ifname);

		const lease = await nm.acquireQuiesceLease(created.connectionId, ifname);
		expect(lease.deviceIfname).toBe(ifname);
		const activeDuringLease = nm.runner.run([
			'-t',
			'-f',
			'UUID,DEVICE',
			'connection',
			'show',
			'--active',
		]);
		expect(activeDuringLease.stdout).toBe('');

		await nm.releaseQuiesceLease(lease);
		const activeAfter = nm.runner.run([
			'-t',
			'-f',
			'UUID,DEVICE',
			'connection',
			'show',
			'--active',
		]);
		expect(activeAfter.stdout).toBe(`${created.connectionId}:wwan0`);
	});

	test('a deleted profile no longer reads back', async () => {
		const nm = new FakeNetworkManagerPort();
		const created = await nm.createGsmProfile(BASE_PROFILE);
		await nm.deleteGsmProfile(created.connectionId);
		expect(await nm.readGsmProfile(created.connectionId)).toBeUndefined();
	});

	test('an unknown connection id reads back as undefined', async () => {
		const nm = new FakeNetworkManagerPort();
		expect(await nm.readGsmProfile(connectionId('nope'))).toBeUndefined();
	});
});
