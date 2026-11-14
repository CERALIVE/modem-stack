import { expect, test } from 'bun:test';
import { FakeNetworkManagerPort } from '../../test-support/fake-nm/fake-network-manager';
import { StatefulNmcliRunner } from '../../test-support/fake-nm/nmcli-runner';
import { defaultCellularPolicy, type IpFamily, imeiEquipmentId } from '../domain';
import { connectionId } from '../ports';
import { planReconcile } from '../ports/reconcile';
import { buildProfile, createGsmArgs, patchPairs } from './nm-gsm-fields';
import { NmcliNmPort } from './nmcli-nm-port';

const profile = { connectionName: 'cellular', apn: '', homeOnly: true, autoConfig: true };
const policy = defaultCellularPolicy({ equipmentId: imeiEquipmentId('490154203237518') });
const capabilities = {
	supportedRats: new Set(['lte'] as const),
	simSlotCount: 1,
	supportsAutoApn: true,
};
const current = {
	hasProfile: true,
	connectionId: connectionId('test'),
	nmActivation: 'activated' as const,
	appliedApn: 'auto',
	appliedRoaming: false,
};

for (const [family, v4, v6] of [
	['ipv4', 'auto', 'disabled'],
	['ipv6', 'disabled', 'auto'],
	['ipv4v6', 'auto', 'auto'],
] as const) {
	test(`${family}: create, patch and saved readback`, async () => {
		const input = { ...profile, ipFamily: family };
		const methods = ['ipv4.method', v4, 'ipv6.method', v6];
		expect(createGsmArgs(input).slice(-4)).toEqual(methods);
		expect(patchPairs({ ipFamily: family })).toEqual(methods);
		const runner = new StatefulNmcliRunner();
		const port = new NmcliNmPort({ runner });
		const saved = await port.createGsmProfile(input);
		expect(saved.ipFamily).toBe(family);
		const fake = new FakeNetworkManagerPort();
		const fakeSaved = await fake.createGsmProfile(input);
		expect(fakeSaved.ipFamily).toBe(family);
		expect(
			(await fake.updateGsmProfile(fakeSaved.connectionId, { ipFamily: 'ipv6' })).ipFamily,
		).toBe('ipv6');
		for (const next of ['ipv4', 'ipv6', 'ipv4v6'] as const) {
			expect((await port.updateGsmProfile(saved.connectionId, { ipFamily: next })).ipFamily).toBe(
				next,
			);
		}
		await port.updateGsmProfile(saved.connectionId, { apn: 'changed' });
		expect((await port.readGsmProfile(saved.connectionId))?.ipFamily).toBe('ipv4v6');
		expect(runner.calls.some((call) => call.includes('up') || call.includes('disconnect'))).toBe(
			false,
		);
	});
	test(`${family}: planner writes until readback matches, without reconnect`, () => {
		const desired = { ...policy, connection: { apn: 'auto', ipFamily: family } };
		const plan = planReconcile(
			{ ...current, appliedIpFamily: family === 'ipv4' ? 'ipv6' : 'ipv4' },
			desired,
			capabilities,
		);
		const writes = plan.ops.filter((op) => op.port === 'nm');
		expect(writes).toEqual([
			{
				port: 'nm',
				op: {
					kind: 'updateGsmProfile',
					connectionId: current.connectionId,
					patch: { ...profile, connectionName: 'ceralive-cellular', ipFamily: family },
				},
			},
		]);
		expect(plan.receipts.find((r) => r.dimension === 'connection')?.status).toBe('pending');
		const matched = planReconcile(
			{ ...current, appliedIpFamily: family as IpFamily },
			desired,
			capabilities,
		);
		expect(matched.ops.filter((op) => op.port === 'nm')).toEqual([]);
		expect(matched.receipts.find((r) => r.dimension === 'connection')?.status).toBe('applied');
		const create = planReconcile({ ...current, hasProfile: false }, desired, capabilities);
		expect(create.ops[0]).toMatchObject({
			port: 'nm',
			op: { kind: 'createGsmProfile', profile: { ipFamily: family } },
		});
	});
}

test('omission preserves the legacy port argv and the default retains its 1.x family', () => {
	expect(createGsmArgs(profile)).toEqual([
		'connection',
		'add',
		'type',
		'gsm',
		'con-name',
		'cellular',
		'gsm.apn',
		'',
		'gsm.username',
		'',
		'gsm.password',
		'',
		'gsm.password-flags',
		'4',
		'gsm.home-only',
		'yes',
		'gsm.network-id',
		'',
		'gsm.auto-config',
		'yes',
		'connection.autoconnect',
		'yes',
		'connection.autoconnect-retries',
		'2',
	]);
	expect(patchPairs({ apn: 'changed' })).toEqual(['gsm.apn', 'changed']);
	const family: IpFamily = policy.connection.ipFamily;
	expect(family).toBe('ipv4v6');
	expect(planReconcile(current, policy, capabilities).ops.filter((op) => op.port === 'nm')).toEqual(
		[],
	);
});

test('readback never invents a family for unsupported method combinations', () => {
	for (const [v4, v6] of [
		['manual', 'auto'],
		['disabled', 'disabled'],
		['auto', 'ignore'],
	] as const) {
		expect(
			buildProfile(
				connectionId('test'),
				new Map([
					['ipv4.method', v4],
					['ipv6.method', v6],
				]),
			).ipFamily,
		).toBeUndefined();
	}
});

for (const ipFamily of ['ipv4', 'ipv6', 'ipv4v6'] as const) {
	test(`${ipFamily}: unknown applied family causes no reconcile write`, () => {
		const desired = { ...policy, connection: { apn: 'auto', ipFamily } };
		for (let pass = 0; pass < 2; pass++) {
			const plan = planReconcile(current, desired, capabilities);
			expect(plan.ops.filter((op) => op.port === 'nm')).toEqual([]);
			expect(plan.receipts.find((r) => r.dimension === 'connection')?.status).toBe('applied');
		}
	});
}

test('saved readback follows independently written methods rather than the request', async () => {
	const runner = new StatefulNmcliRunner();
	const port = new NmcliNmPort({ runner });
	const saved = await port.createGsmProfile({ ...profile, ipFamily: 'ipv4' });
	const fake = new FakeNetworkManagerPort(runner);
	for (const [v4, v6, expected] of [
		['disabled', 'auto', 'ipv6'],
		['auto', 'auto', 'ipv4v6'],
		['auto', 'disabled', 'ipv4'],
		['auto', 'ignore', undefined],
		['manual', 'auto', undefined],
		['disabled', 'disabled', undefined],
	] as const) {
		runner.run(['connection', 'modify', saved.connectionId, 'ipv4.method', v4, 'ipv6.method', v6]);
		expect((await port.readGsmProfile(saved.connectionId))?.ipFamily).toBe(expected);
		expect((await fake.readGsmProfile(saved.connectionId))?.ipFamily).toBe(expected);
	}
});
