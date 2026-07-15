// The device-exact `NmcliNmPort` proven against A2.3's stateful nmcli runner.
//
// No D-Bus, no bus — the runner is a synchronous in-memory nmcli state machine, so this
// suite always runs. It asserts the FULL nine-field GSM write parity on create + both
// Auto-APN transition directions (with real stateful readback), the password-flags 0/4
// convention, roaming ↔ network-id coupling, autoconnect/retries realism, verify-then-
// device-disconnect deactivation (never `connection down`), two-device isolation,
// abandoned-lease auto-release, and the activation-classification trio.

import { describe, expect, test } from 'bun:test';
import {
	NmcliNmPort,
	type NmcliResult,
	parseNmVersion,
	probeAutoApnCapability,
} from '../src/backend';
import { connectionId, deviceIfname, type GsmProfileInput } from '../src/ports';
import { StatefulNmcliRunner } from './fake-nm';

const MANUAL: GsmProfileInput = {
	connectionName: 'cell-roam',
	apn: 'internet',
	username: 'u',
	password: 'p',
	homeOnly: false,
	autoConfig: false,
	networkId: '310410',
};

const READBACK = [
	'connection.id',
	'gsm.apn',
	'gsm.username',
	'gsm.password',
	'gsm.password-flags',
	'gsm.home-only',
	'gsm.network-id',
	'gsm.auto-config',
	'connection.autoconnect',
	'connection.autoconnect-retries',
].join(',');

const reject = (stderr: string, exitCode = 10): NmcliResult => ({ stdout: '', stderr, exitCode });

/** Pairs from an add/modify argv, starting past the leading verb tokens. */
function argvPairs(argv: readonly string[], start: number): Map<string, string> {
	const map = new Map<string, string>();
	for (let i = start; i + 1 < argv.length; i += 2) {
		const key = argv[i];
		if (key === undefined) {
			break;
		}
		map.set(key, argv[i + 1] ?? '');
	}
	return map;
}

const addCall = (runner: StatefulNmcliRunner): readonly string[] =>
	runner.calls.find((c) => c[0] === 'connection' && c[1] === 'add') ?? [];

const showFields = (runner: StatefulNmcliRunner, id: string): Map<string, string> => {
	const out = runner.run(['-t', '-f', READBACK, 'connection', 'show', id]).stdout;
	const map = new Map<string, string>();
	for (const line of out.split('\n')) {
		const at = line.indexOf(':');
		if (at >= 0) {
			map.set(line.slice(0, at), line.slice(at + 1));
		}
	}
	return map;
};

/** Emulates NM's real rejection of `auto-config yes` with any credential still set. */
function violatesAutoConfig(argv: readonly string[]): boolean {
	const pairs = argvPairs(argv, 3);
	if (pairs.get('gsm.auto-config') !== 'yes') {
		return false;
	}
	return ['gsm.apn', 'gsm.username', 'gsm.password'].some((k) => (pairs.get(k) ?? '') !== '');
}

class ValidatingRunner {
	readonly inner = new StatefulNmcliRunner();
	readonly seen: string[][] = [];
	#failNext = false;

	failNextModify(): void {
		this.#failNext = true;
	}

	run(argv: readonly string[]): NmcliResult {
		this.seen.push([...argv]);
		if (argv[0] === 'connection' && (argv[1] === 'modify' || argv[1] === 'mod')) {
			if (this.#failNext) {
				this.#failNext = false;
				return reject('nmcli: modify rejected (test)');
			}
			if (violatesAutoConfig(argv)) {
				return reject('gsm.auto-config: mutually exclusive with APN/username/password');
			}
		}
		return this.inner.run(argv);
	}
}

class ScriptedUpRunner {
	readonly inner = new StatefulNmcliRunner();
	#up: NmcliResult | undefined;

	scriptUp(result: NmcliResult): void {
		this.#up = result;
	}

	run(argv: readonly string[]): NmcliResult {
		if (argv[0] === 'connection' && argv[1] === 'up' && this.#up !== undefined) {
			const scripted = this.#up;
			this.#up = undefined;
			return scripted;
		}
		return this.inner.run(argv);
	}
}

describe('NmcliNmPort — nine-field GSM write parity on create', () => {
	test('every field is written with its exact convention (roaming on, password set)', async () => {
		const runner = new StatefulNmcliRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile(MANUAL);

		const pairs = argvPairs(addCall(runner), 2);
		expect(pairs.get('type')).toBe('gsm');
		expect(pairs.get('con-name')).toBe('cell-roam');
		expect(pairs.get('gsm.apn')).toBe('internet');
		expect(pairs.get('gsm.username')).toBe('u');
		expect(pairs.get('gsm.password')).toBe('p');
		expect(pairs.get('gsm.password-flags')).toBe('0');
		expect(pairs.get('gsm.home-only')).toBe('no');
		expect(pairs.get('gsm.network-id')).toBe('310410');
		expect(pairs.get('gsm.auto-config')).toBe('no');
		expect(pairs.get('connection.autoconnect')).toBe('yes');
		expect(pairs.get('connection.autoconnect-retries')).toBe('2');

		expect(created.apn).toBe('internet');
		expect(created.networkId).toBe('310410');
		expect(created.homeOnly).toBe(false);
	});

	test('password-flags is "4" and creds are "" when no password is set (Bun empty-arg quirk)', async () => {
		const runner = new StatefulNmcliRunner();
		const port = new NmcliNmPort({ runner });
		await port.createGsmProfile({
			connectionName: 'c',
			apn: 'iot',
			homeOnly: true,
			autoConfig: false,
		});

		const pairs = argvPairs(addCall(runner), 2);
		expect(pairs.get('gsm.password-flags')).toBe('4');
		expect(pairs.get('gsm.password')).toBe('');
		expect(pairs.get('gsm.username')).toBe('');
	});

	test('created profiles carry autoconnect + retries (bench replug realism)', async () => {
		const runner = new StatefulNmcliRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile(MANUAL);

		const fields = showFields(runner, created.connectionId);
		expect(fields.get('connection.autoconnect')).toBe('yes');
		expect(fields.get('connection.autoconnect-retries')).toBe('2');
	});
});

describe('NmcliNmPort — network-id tracks roaming', () => {
	test('network-id is set while roaming and cleared when roaming turns off', async () => {
		const runner = new StatefulNmcliRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile(MANUAL);
		expect(showFields(runner, created.connectionId).get('gsm.network-id')).toBe('310410');

		await port.updateGsmProfile(created.connectionId, { homeOnly: true });
		const off = showFields(runner, created.connectionId);
		expect(off.get('gsm.network-id')).toBe('');
		expect(off.get('gsm.home-only')).toBe('yes');

		await port.updateGsmProfile(created.connectionId, { homeOnly: false, networkId: '260010' });
		const on = showFields(runner, created.connectionId);
		expect(on.get('gsm.network-id')).toBe('260010');
		expect(on.get('gsm.home-only')).toBe('no');
	});
});

describe('NmcliNmPort — atomic Auto-APN transitions (validating NM runner)', () => {
	test('manual → auto: ONE atomic modify clears creds + sets auto-config; readback correct', async () => {
		const runner = new ValidatingRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile(MANUAL);
		const ifname = deviceIfname('wwan0');

		const result = await port.transitionToAuto(created.connectionId, ifname);
		expect(result.receipt.status).toBe('applied');

		const modifies = runner.seen.filter((c) => c[0] === 'connection' && c[1] === 'modify');
		expect(modifies).toHaveLength(1);
		const pairs = argvPairs(modifies[0] ?? [], 3);
		expect(pairs.get('gsm.apn')).toBe('');
		expect(pairs.get('gsm.username')).toBe('');
		expect(pairs.get('gsm.password')).toBe('');
		expect(pairs.get('gsm.password-flags')).toBe('4');
		expect(pairs.get('gsm.auto-config')).toBe('yes');

		const fields = showFields(runner.inner, created.connectionId);
		expect(fields.get('gsm.auto-config')).toBe('yes');
		expect(fields.get('gsm.apn')).toBe('');
		expect(fields.get('gsm.password-flags')).toBe('4');
	});

	test('auto → manual: exact-reverse ONE atomic modify restores creds; readback correct', async () => {
		const runner = new ValidatingRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile({
			connectionName: 'auto',
			apn: '',
			homeOnly: true,
			autoConfig: true,
		});
		const ifname = deviceIfname('wwan0');

		const result = await port.transitionToManual(created.connectionId, ifname, {
			apn: 'internet',
			username: 'u',
			password: 'p',
		});
		expect(result.receipt.status).toBe('applied');

		const modifies = runner.seen.filter((c) => c[0] === 'connection' && c[1] === 'modify');
		expect(modifies).toHaveLength(1);
		const pairs = argvPairs(modifies[0] ?? [], 3);
		expect(pairs.get('gsm.apn')).toBe('internet');
		expect(pairs.get('gsm.password-flags')).toBe('0');
		expect(pairs.get('gsm.auto-config')).toBe('no');

		const fields = showFields(runner.inner, created.connectionId);
		expect(fields.get('gsm.apn')).toBe('internet');
		expect(fields.get('gsm.auto-config')).toBe('no');
	});

	test('a rejected modify leaves the profile byte-unchanged', async () => {
		const runner = new ValidatingRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile(MANUAL);
		const before = runner.inner.run([
			'-t',
			'-f',
			READBACK,
			'connection',
			'show',
			created.connectionId,
		]).stdout;

		runner.failNextModify();
		const result = await port.transitionToAuto(created.connectionId, deviceIfname('wwan0'));
		expect(result.receipt.status).toBe('failed');

		const after = runner.inner.run([
			'-t',
			'-f',
			READBACK,
			'connection',
			'show',
			created.connectionId,
		]).stdout;
		expect(after).toBe(before);
		expect(runner.seen.some((c) => c[0] === 'connection' && c[1] === 'up')).toBe(false);
	});

	test('boot capability gate: NM too old → unsupported + advisory, no modify issued', async () => {
		const runner = new ValidatingRunner();
		const port = new NmcliNmPort({ runner, autoApnCapable: false });
		const created = await port.createGsmProfile(MANUAL);

		const result = await port.transitionToAuto(created.connectionId, deviceIfname('wwan0'));
		expect(result.receipt.status).toBe('unsupported');
		expect(result.advisory).toBe('autoApnUnavailable');
		expect(runner.seen.some((c) => c[0] === 'connection' && c[1] === 'modify')).toBe(false);
	});
});

describe('NmcliNmPort — device-exact deactivation + two-device isolation', () => {
	test('quiescing one device leaves a shared profile active on the other, ifname per call', async () => {
		const runner = new StatefulNmcliRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile(MANUAL);
		const devA = deviceIfname('wwan0');
		const devB = deviceIfname('wwan1');
		await port.activate(created.connectionId, devA);
		await port.activate(created.connectionId, devB);

		const before = runner.run(['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']).stdout;
		expect(before).toContain(`${created.connectionId}:wwan0`);
		expect(before).toContain(`${created.connectionId}:wwan1`);

		const down = await port.deactivate(created.connectionId, devA);
		expect(down.status).toBe('applied');

		const after = runner.run(['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']).stdout;
		expect(after).not.toContain('wwan0');
		expect(after).toContain(`${created.connectionId}:wwan1`);

		expect(runner.calls).toContainEqual(['device', 'disconnect', 'wwan0']);
		expect(runner.calls.some((c) => c[0] === 'connection' && c[1] === 'down')).toBe(false);
	});

	test('deactivate is a no-op when the id is not active on the requested ifname', async () => {
		const runner = new StatefulNmcliRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile(MANUAL);
		await port.activate(created.connectionId, deviceIfname('wwan0'));

		const down = await port.deactivate(created.connectionId, deviceIfname('wwan1'));
		expect(down.status).toBe('applied');
		expect(runner.calls).not.toContainEqual(['device', 'disconnect', 'wwan1']);
	});
});

describe('NmcliNmPort — quiesce lease lifecycle', () => {
	test('an abandoned lease auto-releases and reactivates on sweep', async () => {
		let clock = 1_000;
		const runner = new StatefulNmcliRunner();
		const port = new NmcliNmPort({ runner, leaseTtlMs: 5_000, now: () => clock });
		const created = await port.createGsmProfile(MANUAL);
		const ifname = deviceIfname('wwan0');
		await port.activate(created.connectionId, ifname);

		await port.acquireQuiesceLease(created.connectionId, ifname);
		expect(runner.run(['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']).stdout).toBe(
			'',
		);

		clock = 1_000 + 4_000;
		await port.sweepExpiredLeases();
		expect(runner.run(['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']).stdout).toBe(
			'',
		);

		clock = 1_000 + 5_001;
		await port.sweepExpiredLeases();
		expect(runner.run(['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']).stdout).toBe(
			`${created.connectionId}:wwan0`,
		);
	});

	test('explicit release reactivates and a second release is a no-op', async () => {
		const runner = new StatefulNmcliRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile(MANUAL);
		const ifname = deviceIfname('wwan0');
		await port.activate(created.connectionId, ifname);

		const lease = await port.acquireQuiesceLease(created.connectionId, ifname);
		await port.releaseQuiesceLease(lease);
		const ups = runner.calls.filter((c) => c[0] === 'connection' && c[1] === 'up').length;
		await port.releaseQuiesceLease(lease);
		expect(runner.calls.filter((c) => c[0] === 'connection' && c[1] === 'up')).toHaveLength(ups);
	});
});

describe('NmcliNmPort — activation-result classification trio', () => {
	test('GSM_APN_FAILED under an auto profile → unsupported + autoApnUnavailable', async () => {
		const runner = new ScriptedUpRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile({
			connectionName: 'auto',
			apn: '',
			homeOnly: true,
			autoConfig: true,
		});
		runner.scriptUp(reject('Error: Connection activation failed: GSM_APN_FAILED', 4));

		const result = await port.transitionToAuto(created.connectionId, deviceIfname('wwan0'));
		expect(result.receipt.status).toBe('unsupported');
		expect(result.advisory).toBe('autoApnUnavailable');
	});

	test('any other activation error → failed', async () => {
		const runner = new ScriptedUpRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile(MANUAL);
		runner.scriptUp(reject('Error: Connection activation failed: no valid secrets', 4));

		const result = await port.transitionToManual(created.connectionId, deviceIfname('wwan0'), {
			apn: 'internet',
			username: 'u',
			password: 'p',
		});
		expect(result.receipt.status).toBe('failed');
		expect(result.advisory).toBeUndefined();
	});

	test('activation wait timeout → pending', async () => {
		const runner = new ScriptedUpRunner();
		const port = new NmcliNmPort({ runner });
		const created = await port.createGsmProfile({
			connectionName: 'auto',
			apn: '',
			homeOnly: true,
			autoConfig: true,
		});
		runner.scriptUp(reject('Error: Timeout expired (90 seconds)', 3));

		const result = await port.transitionToAuto(created.connectionId, deviceIfname('wwan0'));
		expect(result.receipt.status).toBe('pending');
		expect(result.advisory).toBeUndefined();
	});
});

describe('Auto-APN capability probe', () => {
	test('parses the nmcli version banner', () => {
		expect(parseNmVersion('nmcli tool, version 1.42.4')).toEqual({ major: 1, minor: 42 });
		expect(parseNmVersion('garbage')).toBeNull();
	});

	test('probe resolves capability from a --version answer (>=1.22 capable, older not)', async () => {
		const capable = {
			run: (argv: readonly string[]) =>
				argv[0] === '--version'
					? { stdout: 'nmcli tool, version 1.42.4', stderr: '', exitCode: 0 }
					: { stdout: '', stderr: '', exitCode: 0 },
		};
		const old = {
			run: (argv: readonly string[]) =>
				argv[0] === '--version'
					? { stdout: 'nmcli tool, version 1.20.6', stderr: '', exitCode: 0 }
					: { stdout: '', stderr: '', exitCode: 0 },
		};
		expect(await probeAutoApnCapability(capable)).toBe(true);
		expect(await probeAutoApnCapability(old)).toBe(false);
	});

	test('an unknown connection id reads back as undefined', async () => {
		const port = new NmcliNmPort({ runner: new StatefulNmcliRunner() });
		expect(await port.readGsmProfile(connectionId('nope'))).toBeUndefined();
	});
});
