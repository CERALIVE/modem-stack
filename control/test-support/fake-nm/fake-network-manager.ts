// A fake `NetworkManagerPort` that drives the stateful nmcli-runner.
//
// It fulfils the real port contract (profile CRUD, device-exact activate/deactivate,
// quiesce lease) by building nmcli argv and running them through `StatefulNmcliRunner`,
// so a `readGsmProfile` after a `createGsmProfile`/`updateGsmProfile` returns exactly
// what was written — a genuine readback double for reconcile/observer tests. It is a
// TEST DOUBLE, not the shipping adapter: it wires only the fields the port interface
// carries. A4.1's `NmcliNmPort` owns the full nine-field GSM write parity and the
// atomic Auto-APN transitions; this harness is what A4.1 injects to assert them.

import { epochMillis } from '../../src/domain';
import {
	type ConnectionId,
	connectionId,
	type DeviceIfname,
	type GsmProfile,
	type GsmProfileInput,
	type GsmProfilePatch,
	type NetworkManagerPort,
	type QuiesceLease,
	type Receipt,
	receipt,
} from '../../src/ports';
import { type NmcliResult, StatefulNmcliRunner } from './nmcli-runner';

const READBACK_FIELDS = [
	'connection.id',
	'gsm.apn',
	'gsm.username',
	'gsm.password',
	'gsm.home-only',
	'gsm.auto-config',
	'gsm.network-id',
];

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

export class FakeNetworkManagerPort implements NetworkManagerPort {
	readonly #runner: StatefulNmcliRunner;

	constructor(runner: StatefulNmcliRunner = new StatefulNmcliRunner()) {
		this.#runner = runner;
	}

	/** The underlying runner — exposed so tests can assert the argv call log. */
	get runner(): StatefulNmcliRunner {
		return this.#runner;
	}

	async createGsmProfile(profile: GsmProfileInput): Promise<GsmProfile> {
		const argv = [
			'connection',
			'add',
			'type',
			'gsm',
			'con-name',
			profile.connectionName,
			'gsm.apn',
			profile.apn,
			'gsm.home-only',
			yesNo(profile.homeOnly),
			'gsm.auto-config',
			yesNo(profile.autoConfig),
		];
		if (profile.username !== undefined) {
			argv.push('gsm.username', profile.username);
		}
		if (profile.password !== undefined) {
			argv.push('gsm.password', profile.password);
		}
		if (profile.networkId !== undefined) {
			argv.push('gsm.network-id', profile.networkId);
		}
		const result = this.#runner.run(argv);
		const uuid = /\(([^)]+)\) successfully added/.exec(result.stdout)?.[1];
		if (uuid === undefined) {
			throw new Error(`fake nmcli: add did not return a UUID (${result.stderr})`);
		}
		const created = await this.readGsmProfile(connectionId(uuid));
		if (created === undefined) {
			throw new Error('fake nmcli: created profile did not read back');
		}
		return created;
	}

	async readGsmProfile(id: ConnectionId): Promise<GsmProfile | undefined> {
		const result = this.#runner.run([
			'-t',
			'-f',
			READBACK_FIELDS.join(','),
			'connection',
			'show',
			id,
		]);
		if (result.exitCode !== 0) {
			return undefined;
		}
		return buildProfile(id, parseTerse(result.stdout));
	}

	async updateGsmProfile(id: ConnectionId, patch: GsmProfilePatch): Promise<GsmProfile> {
		const argv: string[] = ['connection', 'modify', id];
		if (patch.connectionName !== undefined) {
			argv.push('connection.id', patch.connectionName);
		}
		if (patch.apn !== undefined) {
			argv.push('gsm.apn', patch.apn);
		}
		if (patch.username !== undefined) {
			argv.push('gsm.username', patch.username);
		}
		if (patch.password !== undefined) {
			argv.push('gsm.password', patch.password);
		}
		if (patch.homeOnly !== undefined) {
			argv.push('gsm.home-only', yesNo(patch.homeOnly));
		}
		if (patch.autoConfig !== undefined) {
			argv.push('gsm.auto-config', yesNo(patch.autoConfig));
		}
		if (patch.networkId !== undefined) {
			argv.push('gsm.network-id', patch.networkId);
		}
		const result = this.#runner.run(argv);
		if (result.exitCode !== 0) {
			throw new Error(`fake nmcli: modify failed (${result.stderr})`);
		}
		const updated = await this.readGsmProfile(id);
		if (updated === undefined) {
			throw new Error(`fake nmcli: profile ${id} vanished after modify`);
		}
		return updated;
	}

	async deleteGsmProfile(id: ConnectionId): Promise<void> {
		this.#runner.run(['connection', 'delete', id]);
	}

	async activate(id: ConnectionId, ifname: DeviceIfname): Promise<Receipt> {
		const result = this.#runner.run(['connection', 'up', id, 'ifname', ifname]);
		return activationReceipt(result, `activated ${id} on ${ifname}`);
	}

	async deactivate(id: ConnectionId, ifname: DeviceIfname): Promise<Receipt> {
		if (this.#activeUuidOn(ifname) !== id) {
			return receipt('enabled', 'applied', `${id} not active on ${ifname}; nothing to deactivate`);
		}
		const result = this.#runner.run(['device', 'disconnect', ifname]);
		return activationReceipt(result, `deactivated ${id} on ${ifname}`);
	}

	async acquireQuiesceLease(id: ConnectionId, ifname: DeviceIfname): Promise<QuiesceLease> {
		if (this.#activeUuidOn(ifname) === id) {
			this.#runner.run(['device', 'disconnect', ifname]);
		}
		return { connectionId: id, deviceIfname: ifname, acquiredAt: epochMillis(Date.now()) };
	}

	async releaseQuiesceLease(lease: QuiesceLease): Promise<void> {
		this.#runner.run(['connection', 'up', lease.connectionId, 'ifname', lease.deviceIfname]);
	}

	#activeUuidOn(ifname: DeviceIfname): string | undefined {
		const result = this.#runner.run(['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']);
		for (const line of result.stdout.split('\n')) {
			const [uuid, device] = line.split(':');
			if (device === ifname && uuid) {
				return uuid;
			}
		}
		return undefined;
	}
}

function activationReceipt(result: NmcliResult, appliedReason: string): Receipt {
	return result.exitCode === 0
		? receipt('enabled', 'applied', appliedReason)
		: receipt('enabled', 'failed', result.stderr || 'nmcli returned a non-zero exit code');
}

function parseTerse(stdout: string): Map<string, string> {
	const settings = new Map<string, string>();
	for (const line of stdout.split('\n')) {
		const separator = line.indexOf(':');
		if (separator >= 0) {
			settings.set(line.slice(0, separator), line.slice(separator + 1));
		}
	}
	return settings;
}

function buildProfile(id: ConnectionId, settings: Map<string, string>): GsmProfile {
	const username = settings.get('gsm.username') ?? '';
	const password = settings.get('gsm.password') ?? '';
	const networkId = settings.get('gsm.network-id') ?? '';
	return {
		connectionId: id,
		connectionName: settings.get('connection.id') ?? '',
		apn: settings.get('gsm.apn') ?? '',
		homeOnly: settings.get('gsm.home-only') === 'yes',
		autoConfig: settings.get('gsm.auto-config') === 'yes',
		...(username !== '' ? { username } : {}),
		...(password !== '' ? { password } : {}),
		...(networkId !== '' ? { networkId } : {}),
	};
}
