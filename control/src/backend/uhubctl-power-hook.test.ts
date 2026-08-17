// The uhubctl power hook — the refusals matter more than the happy path:
//   - a mapped key cycles the right port and reports `applied` only on re-enumeration
//   - an UNMAPPED key is `unsupported` with ZERO commands run
//   - a non-zero uhubctl exit is `failed` and never claims re-enumeration
//   - a modem that never comes back is `failed` with expected-vs-observed
//   - wiring this hook into the ladder does NOT arm it: recovery.enabled=false still
//     fires zero cycles

import { describe, expect, test } from 'bun:test';
import { epochMillis, runtimePath } from '../domain';
import { ModemActor } from './modem-actor';
import { RecoveryLadder, type RecoveryRequest, type RecoverySteps } from './recovery-ladder';
import {
	createUhubctlPowerHook,
	parseUhubctlPortMap,
	type UhubctlPortMap,
	type UhubctlResult,
	type UhubctlRunner,
	type UsbEnumerationPoller,
	uhubctlCycleArgv,
} from './uhubctl-power-hook';

const STABLE_KEY = 'slot:a';
const ID_PATH = 'platform-fc800000.usb-usb-0:1.4.1:1.2';

const PORTS: UhubctlPortMap = {
	[STABLE_KEY]: { hubLocation: '1-1.4', port: 1 },
};

/** A runner that records every argv it was handed and returns a canned result. */
function fakeRunner(result: UhubctlResult, calls: string[][]): UhubctlRunner {
	return {
		run(argv) {
			calls.push([...argv]);
			return result;
		},
	};
}

const OK: UhubctlResult = { stdout: 'Sent power off request\n', stderr: '', exitCode: 0 };

/** A poller that walks a scripted sequence of ID_PATH observations. */
function scriptedPoller(sequence: readonly (string | undefined)[]): UsbEnumerationPoller {
	let index = 0;
	return {
		idPathFor() {
			const value = sequence[Math.min(index, sequence.length - 1)];
			index += 1;
			return value;
		},
	};
}

/** A clock that advances a fixed step per read — makes the timeout loop deterministic. */
function steppingClock(stepMs: number): () => number {
	let value = 0;
	return () => {
		const current = value;
		value += stepMs;
		return current;
	};
}

const context = { stableKey: STABLE_KEY, at: epochMillis(0) };
const noSleep = (): Promise<void> => Promise.resolve();

describe('uhubctl power hook — a mapped key cycles its port', () => {
	test('applied: the exact argv is run and the SAME ID_PATH comes back', async () => {
		const calls: string[][] = [];
		const hook = createUhubctlPowerHook({
			ports: PORTS,
			runner: fakeRunner(OK, calls),
			// Pre-cut observation, then absent, then the same path returns.
			poller: scriptedPoller([ID_PATH, undefined, ID_PATH]),
			sleep: noSleep,
		});

		expect(hook.capability.power).toBe('usb-hub-port-cycle');

		const result = await hook.cycle(context);
		expect(result.status).toBe('applied');
		expect(result.reason).toContain(ID_PATH);
		// Argv array, no shell, allowlisted flags — asserted byte-for-byte.
		expect(calls).toEqual([['-l', '1-1.4', '-p', '1', '-a', 'cycle', '-d', '3']]);
	});

	test('the argv builder refuses a token that is not allowlisted', () => {
		expect(uhubctlCycleArgv({ hubLocation: '1-1.4', port: 1 }, 3)).toEqual([
			'-l',
			'1-1.4',
			'-p',
			'1',
			'-a',
			'cycle',
			'-d',
			'3',
		]);
		// A mapping that evaded the schema cannot smuggle a flag into the argv.
		expect(() => uhubctlCycleArgv({ hubLocation: '--force', port: 1 }, 3)).toThrow('allowlisted');
	});

	test('the schema rejects a hub location that is not a bus-port path', () => {
		expect(() =>
			parseUhubctlPortMap('{"slot:a":{"hubLocation":"; rm -rf /","port":1}}', 'x'),
		).toThrow('hubLocation');
	});
});

describe('uhubctl power hook — an unmapped stable key is unsupported', () => {
	test('no mapping ⇒ unsupported, and the runner is NEVER invoked', async () => {
		const calls: string[][] = [];
		const hook = createUhubctlPowerHook({
			ports: PORTS,
			runner: fakeRunner(OK, calls),
			poller: { idPathFor: () => Promise.reject(new Error('poller must not be consulted')) },
			sleep: noSleep,
		});
		const result = await hook.cycle({ stableKey: 'slot:unknown', at: epochMillis(0) });
		expect(result.status).toBe('unsupported');
		expect(result.reason).toContain('slot:unknown');
		expect(calls).toEqual([]);
	});
});

describe('uhubctl power hook — a failing cycle command fails', () => {
	test('a non-zero exit is failed, carries stderr, and never claims re-enumeration', async () => {
		const calls: string[][] = [];
		const hook = createUhubctlPowerHook({
			ports: PORTS,
			runner: fakeRunner(
				{ stdout: '', stderr: 'No compatible devices detected!', exitCode: 1 },
				calls,
			),
			poller: scriptedPoller([ID_PATH, ID_PATH]),
			sleep: noSleep,
		});
		const result = await hook.cycle(context);
		expect(result.status).toBe('failed');
		expect(result.reason).toContain('exited 1');
		expect(result.reason).toContain('No compatible devices detected!');
		expect(calls).toHaveLength(1);
	});

	test('a runner that throws is failed, not an unhandled rejection', async () => {
		const hook = createUhubctlPowerHook({
			ports: PORTS,
			runner: { run: () => Promise.reject(new Error('uhubctl: command not found')) },
			poller: scriptedPoller([ID_PATH]),
			sleep: noSleep,
		});
		const result = await hook.cycle(context);
		expect(result.status).toBe('failed');
		expect(result.reason).toContain('command not found');
	});
});

describe('uhubctl power hook — an enumeration timeout fails', () => {
	test('the modem never returning is failed with expected-vs-observed', async () => {
		const calls: string[][] = [];
		const hook = createUhubctlPowerHook({
			ports: PORTS,
			runner: fakeRunner(OK, calls),
			// Seen before the cut, then gone forever.
			poller: scriptedPoller([ID_PATH, undefined]),
			enumerationTimeoutMs: 1000,
			pollIntervalMs: 250,
			now: steppingClock(400),
			sleep: noSleep,
		});
		const result = await hook.cycle(context);
		expect(result.status).toBe('failed');
		expect(result.reason).toContain('did not re-enumerate within 1000ms');
		expect(result.reason).toContain(ID_PATH);
		expect(result.reason).toContain('no device');
		// The port WAS cycled — the failure is the postcondition, not the command.
		expect(calls).toHaveLength(1);
	});

	test('a DIFFERENT device appearing at that key is not accepted as recovery', async () => {
		const hook = createUhubctlPowerHook({
			ports: PORTS,
			runner: fakeRunner(OK, []),
			poller: scriptedPoller([ID_PATH, 'platform-fc800000.usb-usb-0:9.9:1.0']),
			enumerationTimeoutMs: 1000,
			now: steppingClock(400),
			sleep: noSleep,
		});
		const result = await hook.cycle(context);
		expect(result.status).toBe('failed');
		expect(result.reason).toContain('9.9');
	});

	test('an aborted signal ends the wait instead of hanging', async () => {
		const controller = new AbortController();
		controller.abort();
		const hook = createUhubctlPowerHook({
			ports: PORTS,
			runner: fakeRunner(OK, []),
			poller: scriptedPoller([ID_PATH, undefined]),
			signal: controller.signal,
			sleep: noSleep,
		});
		const result = await hook.cycle(context);
		expect(result.status).toBe('failed');
		expect(result.reason).toContain('cancelled');
	});
});

describe('uhubctl power hook — wiring it in does NOT arm recovery', () => {
	test('recovery.enabled=false fires ZERO uhubctl cycles even with a real hook installed', async () => {
		const calls: string[][] = [];
		const hook = createUhubctlPowerHook({
			ports: PORTS,
			runner: fakeRunner(OK, calls),
			poller: { idPathFor: () => Promise.reject(new Error('poller must not be consulted')) },
			sleep: noSleep,
		});
		const throwingSteps: RecoverySteps = {
			nmCycle: () => Promise.reject(new Error('nmCycle must not fire')),
			mmCycle: () => Promise.reject(new Error('mmCycle must not fire')),
			reset: () => Promise.reject(new Error('reset must not fire')),
		};
		const request: RecoveryRequest = {
			stableKey: STABLE_KEY,
			modem: runtimePath('/org/freedesktop/ModemManager1/Modem/0'),
			attribution: 'modem-fault',
			now: epochMillis(0),
			probeHealthy: () => Promise.resolve(false),
		};
		const ladder = new RecoveryLadder({
			actor: new ModemActor(),
			steps: throwingSteps,
			powerHook: hook,
		});

		const outcome = await ladder.run({ enabled: false }, request);

		expect(outcome.kind).toBe('disabled');
		expect(outcome.steps).toEqual([]);
		// The whole point: a REAL power hook is installed and still nothing ran.
		expect(calls).toEqual([]);
	});

	test('the same hook DOES cycle once recovery is explicitly enabled', async () => {
		const calls: string[][] = [];
		const hook = createUhubctlPowerHook({
			ports: PORTS,
			runner: fakeRunner(OK, calls),
			poller: scriptedPoller([ID_PATH, ID_PATH]),
			sleep: noSleep,
		});
		const ladder = new RecoveryLadder({
			actor: new ModemActor(),
			steps: {
				nmCycle: () => Promise.resolve({ status: 'failed', reason: 'x' }),
				mmCycle: () => Promise.resolve({ status: 'failed', reason: 'x' }),
				reset: () => Promise.resolve({ status: 'failed', reason: 'x' }),
			},
			powerHook: hook,
		});
		const outcome = await ladder.run(
			{ enabled: true },
			{
				stableKey: STABLE_KEY,
				modem: runtimePath('/org/freedesktop/ModemManager1/Modem/0'),
				attribution: 'modem-fault',
				now: epochMillis(0),
				probeHealthy: () => Promise.resolve(false),
			},
		);
		expect(outcome.steps.find((s) => s.rung === 'powerCycle')?.status).toBe('applied');
		expect(calls).toHaveLength(1);
	});
});
