// Harness-driven `hil-cycle` integration — the RB-10 port-cycle harness end to end.
//
// The REAL `createUhubctlPowerHook` from `control/src/backend/uhubctl-power-hook.ts` is
// used unmodified; only the `UhubctlRunner` and the presence poller are faked. So these
// tests exercise the actual argv construction, the actual serialisation, and the actual
// re-enumeration postcondition — not a stand-in.
//
// NOTHING HERE MAY SHELL OUT. Real `uhubctl` IS installed on this dev sandbox
// (`/usr/bin/uhubctl`), so the environment provides no accidental protection: the
// guarantee is structural. This file never imports `SpawnUhubctlRunner` / `SpawnCommandRunner`
// and contains no `Bun.spawn`. Anyone extending it must keep that property.
//
// A virtual clock stands in for wall time: the fake runner advances it by the dark-window
// length, so `disappeared=` / `reenumerated=` are exact and the suite runs instantly.

import { expect, test } from 'bun:test';
import {
	createUhubctlPowerHook,
	type UhubctlPortMap,
	type UhubctlResult,
	type UhubctlRunner,
	type UsbEnumerationPoller,
} from '@ceralive/modem-control';
import {
	type HilCycleDeps,
	type HilCyclePhase,
	type MmSlotRecord,
	runHilCycle,
} from './commands/hil-cycle';
import { capturingIo } from './io';

const SLOT = 'platform-fc000000.usb-usb-0:1.4.4:1.4';
const MM_DEVICE = '/sys/devices/platform/fc000000.usb/usb4/4-1/4-1.4/4-1.4.4';
const MM_PATH = '/org/freedesktop/ModemManager1/Modem/2';
const PORT_MAP: UhubctlPortMap = { [SLOT]: { hubLocation: '4-1.4', port: 4 } };

const SWEEP = [
	'4-1: 0bda:0411 mfg="Generic" product="USB3.2 Hub" serial=""',
	'4-1.4: 0bda:0411 mfg="Generic" product="USB3.2 Hub" serial=""',
	'4-1.4.4: 2c7c:0801 mfg="Quectel" product="RM530N-GL" serial="abc"',
	'',
].join('\n');

/** How the fake bus behaves once `uhubctl` has been asked to cycle the port. */
type BusScript =
	/** Dark for `darkPolls` samples, then the SAME ID_PATH returns. */
	| { readonly kind: 'recovers'; readonly darkPolls: number }
	/** Dark forever — the hub cut power and nothing came back. */
	| { readonly kind: 'never-returns' }
	/** Never dark: the hub accepted the request (exit 0) but did NOT cut VBUS. */
	| { readonly kind: 'no-drop' };

interface Harness {
	readonly deps: HilCycleDeps;
	/** Every dep call and phase marker, in the order they happened. */
	readonly calls: string[];
	/** Exactly the argv arrays handed to `uhubctl` — empty means it never ran. */
	readonly argvs: string[][];
}

interface HarnessOptions {
	readonly bus: BusScript;
	/** What ModemManager reports AFTER the cycle (default: the same slot UID). */
	readonly mmAfter?: readonly MmSlotRecord[];
	readonly ports?: UhubctlPortMap;
	/** Simulated dark-window duration — `uhubctl -a cycle -d N` blocks for it. */
	readonly darkWindowMs?: number;
}

function harness(options: HarnessOptions): Harness {
	const calls: string[] = [];
	const argvs: string[][] = [];
	let clockMs = 1_000;
	const now = (): number => clockMs;
	const sleep = (ms: number): Promise<void> => {
		clockMs += ms;
		return Promise.resolve();
	};

	let cut = false;
	let darkSamples = 0;
	const poller: UsbEnumerationPoller = {
		idPathFor(): Promise<string | undefined> {
			calls.push('poller');
			if (!cut || options.bus.kind === 'no-drop') {
				return Promise.resolve(SLOT);
			}
			if (options.bus.kind === 'never-returns') {
				return Promise.resolve(undefined);
			}
			if (darkSamples < options.bus.darkPolls) {
				darkSamples += 1;
				return Promise.resolve(undefined);
			}
			return Promise.resolve(SLOT);
		},
	};

	const runner: UhubctlRunner = {
		run(argv: readonly string[]): Promise<UhubctlResult> {
			calls.push(`uhubctl:${argv.join(' ')}`);
			argvs.push([...argv]);
			// A real `uhubctl -a cycle -d N` BLOCKS for the whole dark window and only
			// then returns — model that, because it is what makes the drop hard to see.
			clockMs += options.darkWindowMs ?? 3_000;
			cut = true;
			return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
		},
	};

	let mmReads = 0;
	const mmSlots = (): Promise<readonly MmSlotRecord[]> => {
		calls.push('mmSlots');
		mmReads += 1;
		if (mmReads === 1) {
			return Promise.resolve([{ path: MM_PATH, device: MM_DEVICE }]);
		}
		return Promise.resolve(options.mmAfter ?? [{ path: MM_PATH, device: MM_DEVICE }]);
	};

	const deps: HilCycleDeps = {
		readPortMap: () => Promise.resolve(options.ports ?? PORT_MAP),
		createPowerHook: (ports, recordingPoller) =>
			createUhubctlPowerHook({
				ports,
				runner,
				poller: recordingPoller,
				enumerationTimeoutMs: 200,
				pollIntervalMs: 50,
				now,
				sleep,
			}),
		poller,
		usbSweep: () => {
			calls.push('usbSweep');
			return Promise.resolve(SWEEP);
		},
		mmSlots,
		now,
		sleep,
		mmRedetectTimeoutMs: 200,
		mmPollIntervalMs: 50,
		onPhase: (phase: HilCyclePhase) => calls.push(`phase:${phase}`),
	};

	return { deps, calls, argvs };
}

/** Collapse runs of the same entry so a poll loop does not make the order unassertable. */
function dedupeAdjacent(entries: readonly string[]): string[] {
	return entries.filter((entry, i) => entry !== entries[i - 1]);
}

test('hil-cycle drives the full call order and emits the PASS line', async () => {
	const { deps, calls, argvs } = harness({ bus: { kind: 'recovers', darkPolls: 2 } });
	const io = capturingIo();

	const code = await runHilCycle(io, { slot: SLOT, mmSlot: MM_PATH }, deps);

	expect(code).toBe(0);
	// The whole point of the harness: the order is the contract.
	expect(dedupeAdjacent(calls)).toEqual([
		'phase:pre-capture',
		'usbSweep',
		'mmSlots',
		'poller',
		'phase:cycle',
		'poller',
		'uhubctl:-l 4-1.4 -p 4 -a cycle -d 3',
		'poller',
		'phase:disappeared',
		'phase:reenumerated',
		'phase:mm-redetect',
		'mmSlots',
		'phase:emit',
	]);
	// Exactly one cycle, on exactly the mapped hub/port, with no smuggled flag.
	expect(argvs).toEqual([['-l', '4-1.4', '-p', '4', '-a', 'cycle', '-d', '3']]);
	// The dark window is 3000ms; two 50ms polls elapse before the device is back.
	expect(io.stdout).toContain(`HIL-CYCLE PASS slot=${SLOT} disappeared=3000 reenumerated=3100`);
	expect(io.stdout.join('\n')).toContain(`mm slot UID:  ${MM_DEVICE}`);
});

test('a hub that never re-enumerates fails with reenumeration-timeout', async () => {
	const { deps, argvs } = harness({ bus: { kind: 'never-returns' } });
	const io = capturingIo();

	const code = await runHilCycle(io, { slot: SLOT, mmSlot: MM_PATH }, deps);

	expect(code).toBe(1);
	expect(io.stdout).toContain(`HIL-CYCLE FAIL slot=${SLOT} reason=reenumeration-timeout`);
	expect(io.stdout.join('\n')).not.toContain('HIL-CYCLE PASS');
	// The cycle really was attempted — this is a recovery failure, not a refusal.
	expect(argvs).toHaveLength(1);
});

test('exit 0 from uhubctl without a VBUS drop is NOT a pass', async () => {
	// The RB-10 thesis, as a test: the hub accepted the request and exited 0, but the
	// modem never left the bus. A harness that trusted the exit code would pass here.
	const { deps, argvs } = harness({ bus: { kind: 'no-drop' } });
	const io = capturingIo();

	const code = await runHilCycle(io, { slot: SLOT, mmSlot: MM_PATH }, deps);

	expect(code).toBe(1);
	expect(io.stdout).toContain(`HIL-CYCLE FAIL slot=${SLOT} reason=no-vbus-drop`);
	expect(argvs).toEqual([['-l', '4-1.4', '-p', '4', '-a', 'cycle', '-d', '3']]);
	expect(io.stderr.join('\n')).toContain('A zero exit from uhubctl does not prove VBUS was cut');
});

test('an unmapped slot is refused before any capture or power call', async () => {
	const { deps, calls, argvs } = harness({
		bus: { kind: 'recovers', darkPolls: 2 },
		ports: { 'some-other-key': { hubLocation: '1-1', port: 2 } },
	});
	const io = capturingIo();

	const code = await runHilCycle(io, { slot: SLOT, mmSlot: MM_PATH }, deps);

	expect(code).toBe(1);
	expect(io.stdout).toContain(`HIL-CYCLE FAIL slot=${SLOT} reason=hub-map-slot-unmapped`);
	// Zero side effects: no sweep, no mmcli, no poll, and above all no uhubctl.
	expect(calls).toEqual([]);
	expect(argvs).toEqual([]);
});

test('a different modem at the same selector fails with mm-slot-mismatch', async () => {
	const { deps } = harness({
		bus: { kind: 'recovers', darkPolls: 2 },
		mmAfter: [{ path: MM_PATH, device: '/sys/devices/platform/fc000000.usb/usb1/1-1/1-1.3' }],
	});
	const io = capturingIo();

	const code = await runHilCycle(io, { slot: SLOT, mmSlot: MM_PATH }, deps);

	expect(code).toBe(1);
	expect(io.stdout).toContain(`HIL-CYCLE FAIL slot=${SLOT} reason=mm-slot-mismatch`);
	expect(io.stderr.join('\n')).toContain(MM_DEVICE);
});

test('a bus that recovers but ModemManager never re-reports fails with mm-redetect-timeout', async () => {
	const { deps } = harness({ bus: { kind: 'recovers', darkPolls: 2 }, mmAfter: [] });
	const io = capturingIo();

	const code = await runHilCycle(io, { slot: SLOT, mmSlot: MM_PATH }, deps);

	expect(code).toBe(1);
	expect(io.stdout).toContain(`HIL-CYCLE FAIL slot=${SLOT} reason=mm-redetect-timeout`);
});
