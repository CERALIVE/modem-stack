// `modem-control hil-cycle <slot> --hub-map <file>` — the hardware-in-the-loop
// port-cycle harness (bench runbook RB-10).
//
// It drives ONE real VBUS cycle on a per-port-power-switching (PPPS) hub and proves the
// modem came back — physically, on the bus, and in ModemManager. It consumes the
// `usb-hub-port-cycle` PowerHook as-is (`createUhubctlPowerHook`) through the
// `createPowerHook` factory seam; it never builds argv or spawns anything itself.
//
// WHY A ZERO EXIT CODE FROM `uhubctl` IS NOT THE GATE. `uhubctl -a cycle` exiting 0 only
// means the hub ACCEPTED the request. A hub that silently ignores per-port power (very
// common on non-PPPS silicon) exits 0 and cuts nothing. The only honest observable is the
// modem VANISHING from the USB bus and coming back at the SAME physical topology path.
// This harness therefore asserts, in order:
//
//   1. pre-capture    — the `/sys/bus/usb/devices/*` sweep (there is NO `lsusb` on the
//                       bench image — see RB-9), `mmcli -L`, the slot's current udev
//                       `ID_PATH`, and the slot's `modem.generic.device` UID.
//   2. cycle          — `PowerHook.cycle()` for the mapped stable key.
//   3. disappeared    — a recorded sample where the slot's `ID_PATH` was ABSENT. This is
//                       the VBUS-drop proof.
//   4. reenumerated   — a later sample where the SAME `ID_PATH` is back, within deadline.
//   5. mm-redetect    — ModemManager reports the SAME `modem.generic.device` slot UID
//                       again (the RB-2 assertion, re-run after the cycle). The runtime
//                       `/Modem/<n>` path is allowed to change; the slot UID is not.
//   6. emit           — `HIL-CYCLE PASS slot=<s> disappeared=<ms> reenumerated=<ms>`.
//
// HOW THE DISAPPEARANCE IS OBSERVED, AND WHY IT IS NOT A SECOND POLLER. The harness wraps
// the injected `UsbEnumerationPoller` in a RECORDER and hands that recorder to the hook.
// Every presence sample the hook takes during its own cycle is timestamped into one
// trace, so the harness and the hook can never disagree about what the bus did — there is
// exactly one source of truth and no concurrent double-polling of udev.
//
// KNOWN OBSERVATION LIMIT (documented in RB-10, not hidden here). `uhubctl -a cycle -d N`
// BLOCKS for the whole dark window and only then returns, so the hook's first presence
// sample lands AFTER power is already back on. What makes the drop observable anyway is
// that USB re-enumeration is not instantaneous: on Linux >= 6.0 the device node is really
// removed on power-down (see the pre-6.0 caveat in `uhubctl-power-hook.ts`) and takes
// order-of-a-second to reappear. If the sampling still misses the gap the harness fails
// with `no-vbus-drop` rather than passing on a cycle it could not prove — and RB-10's
// manual two-phase `-a off` / sweep / `-a on` proof is the fallback that settles it.

import {
	epochMillis,
	type PowerHook,
	type UhubctlPortMap,
	type UsbEnumerationPoller,
} from '@ceralive/modem-control';
import type { CliIo } from '../io';

/** The ordered phases of one harness run — the call-order contract the tests pin. */
export const HIL_CYCLE_PHASES = [
	'pre-capture',
	'cycle',
	'disappeared',
	'reenumerated',
	'mm-redetect',
	'emit',
] as const;
export type HilCyclePhase = (typeof HIL_CYCLE_PHASES)[number];

/**
 * Every way this harness can refuse or fail. A run NEVER throws a bare exception at the
 * operator: it names one of these and exits non-zero, so a runbook can grep the reason.
 */
export const HIL_CYCLE_FAILURES = [
	/** The `--hub-map` file is missing, unreadable, or does not match the schema. */
	'hub-map-unreadable',
	/** The file parsed, but carries no hub/port entry for this slot. */
	'hub-map-slot-unmapped',
	/** The pre-state capture (sysfs sweep / `mmcli -L`) itself failed. */
	'pre-capture-failed',
	/** Nothing is enumerated at this slot right now — there is no baseline to prove. */
	'slot-not-enumerated',
	/** ModemManager does not report this slot before the cycle. */
	'mm-slot-absent',
	/** The stable key is mapped, but the hook reports no power capability for it. */
	'power-cycle-unsupported',
	/** The hook ran and reported a failure that is not a bus-observation failure. */
	'power-cycle-failed',
	/** The modem never left the bus — power was almost certainly NOT cut. */
	'no-vbus-drop',
	/** It left the bus but the same `ID_PATH` did not come back inside the deadline. */
	'reenumeration-timeout',
	/** The bus recovered but ModemManager never re-reported the slot UID. */
	'mm-redetect-timeout',
	/** ModemManager re-detected the slot with a DIFFERENT `modem.generic.device`. */
	'mm-slot-mismatch',
] as const;
export type HilCycleFailure = (typeof HIL_CYCLE_FAILURES)[number];

/** One ModemManager modem as the harness needs it: runtime path + stable slot UID. */
export interface MmSlotRecord {
	/** The runtime D-Bus path, e.g. `/org/freedesktop/ModemManager1/Modem/2`. */
	readonly path: string;
	/** `modem.generic.device` — the udev slot UID that must survive the cycle. */
	readonly device: string;
}

/** The outcome of one harness run. */
export type HilCycleOutcome =
	| {
			readonly kind: 'pass';
			readonly slot: string;
			readonly idPath: string;
			readonly mmDevice: string;
			readonly disappearedMs: number;
			readonly reenumeratedMs: number;
	  }
	| { readonly kind: 'failed'; readonly reason: HilCycleFailure; readonly detail: string };

/** Parsed `hil-cycle` arguments. */
export interface HilCycleArgs {
	/** The stable key: the `--hub-map` key AND the poller's lookup key. */
	readonly slot: string;
	/** The ModemManager selector (`--mm-slot`), defaulting to `slot` at the CLI layer. */
	readonly mmSlot: string;
}

/** Everything that touches the system is injected — the tests supply fakes for all of it. */
export interface HilCycleDeps {
	/** Read + validate the `--hub-map` file. Any throw becomes `hub-map-unreadable`. */
	readonly readPortMap: () => Promise<UhubctlPortMap>;
	/**
	 * Build the PowerHook over the validated map and the harness's RECORDING poller.
	 * Production passes `createUhubctlPowerHook`; tests pass the same factory with a
	 * fake `UhubctlRunner`, so the real hook is exercised end to end.
	 */
	readonly createPowerHook: (ports: UhubctlPortMap, poller: UsbEnumerationPoller) => PowerHook;
	/** Resolves the slot's current udev `ID_PATH`; must re-read udev on every call. */
	readonly poller: UsbEnumerationPoller;
	/** The `/sys/bus/usb/devices/*` sweep text (RB-9's canonical capture, never `lsusb`). */
	readonly usbSweep: () => Promise<string>;
	/** Every modem ModemManager currently reports, with its `modem.generic.device`. */
	readonly mmSlots: () => Promise<readonly MmSlotRecord[]>;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** How long after the cycle the same `ID_PATH` may take to return. */
	readonly reenumerationDeadlineMs?: number;
	/** How long ModemManager may take to re-report the slot UID after the bus recovers. */
	readonly mmRedetectTimeoutMs?: number;
	readonly mmPollIntervalMs?: number;
	/** Phase tap — the call-order seam the integration test asserts against. */
	readonly onPhase?: (phase: HilCyclePhase) => void;
}

const DEFAULT_REENUMERATION_DEADLINE_MS = 60_000;
const DEFAULT_MM_REDETECT_TIMEOUT_MS = 60_000;
const DEFAULT_MM_POLL_INTERVAL_MS = 500;

/** One timestamped presence sample taken by the hook through the recording poller. */
interface PresenceSample {
	readonly atMs: number;
	readonly idPath: string | undefined;
}

/** The `PASS` line RB-10 greps for. Exactly one shape, no optional fields. */
export function hilCyclePassLine(outcome: Extract<HilCycleOutcome, { kind: 'pass' }>): string {
	return `HIL-CYCLE PASS slot=${outcome.slot} disappeared=${outcome.disappearedMs} reenumerated=${outcome.reenumeratedMs}`;
}

/** The `FAIL` line RB-10 greps for — always carries a NAMED reason, never a stack trace. */
export function hilCycleFailLine(slot: string, reason: HilCycleFailure): string {
	return `HIL-CYCLE FAIL slot=${slot} reason=${reason}`;
}

/**
 * Run one HIL port cycle and report a typed outcome. This function performs no I/O of
 * its own — every system touch is a `deps` seam, so the same code path runs on the bench
 * and under test.
 */
export async function hilCycle(args: HilCycleArgs, deps: HilCycleDeps): Promise<HilCycleOutcome> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const reenumerationDeadlineMs = deps.reenumerationDeadlineMs ?? DEFAULT_REENUMERATION_DEADLINE_MS;
	const mmRedetectTimeoutMs = deps.mmRedetectTimeoutMs ?? DEFAULT_MM_REDETECT_TIMEOUT_MS;
	const mmPollIntervalMs = deps.mmPollIntervalMs ?? DEFAULT_MM_POLL_INTERVAL_MS;
	const phase = (p: HilCyclePhase): void => deps.onPhase?.(p);
	const fail = (reason: HilCycleFailure, detail: string): HilCycleOutcome => ({
		kind: 'failed',
		reason,
		detail,
	});

	let ports: UhubctlPortMap;
	try {
		ports = await deps.readPortMap();
	} catch (error) {
		return fail('hub-map-unreadable', describe(error));
	}
	// Refuse an unmapped slot BEFORE any capture and before the hook exists — the same
	// fail-closed ordering the hook itself uses. An unmapped key must never reach argv.
	if (ports[args.slot] === undefined) {
		return fail(
			'hub-map-slot-unmapped',
			`no hub/port entry for slot '${args.slot}' in the --hub-map file ` +
				`(mapped keys: ${Object.keys(ports).join(', ') || '(none)'})`,
		);
	}

	// ---- 1. pre-capture -------------------------------------------------------------
	phase('pre-capture');
	let sweep: string;
	let mmBefore: readonly MmSlotRecord[];
	try {
		sweep = await deps.usbSweep();
		mmBefore = await deps.mmSlots();
	} catch (error) {
		return fail('pre-capture-failed', describe(error));
	}
	if (sweep.trim() === '') {
		return fail('pre-capture-failed', 'the /sys/bus/usb/devices sweep produced no output');
	}

	let expectedIdPath: string | undefined;
	try {
		expectedIdPath = await deps.poller.idPathFor(args.slot);
	} catch (error) {
		return fail('pre-capture-failed', `resolving the slot ID_PATH failed: ${describe(error)}`);
	}
	if (expectedIdPath === undefined) {
		return fail(
			'slot-not-enumerated',
			`nothing is enumerated at slot '${args.slot}' right now — there is no ` +
				'baseline ID_PATH, so a re-enumeration could not be proven',
		);
	}

	const before = matchMmSlot(mmBefore, args.mmSlot);
	if (before === undefined) {
		return fail(
			'mm-slot-absent',
			`ModemManager does not report a modem matching '${args.mmSlot}' before the cycle ` +
				`(reported: ${mmBefore.map((r) => r.path).join(', ') || '(none)'})`,
		);
	}

	// ---- 2. cycle -------------------------------------------------------------------
	// The hook polls presence through this recorder, so the disappearance/re-enumeration
	// evidence is the hook's OWN observation trace rather than a second, racing poller.
	const trace: PresenceSample[] = [];
	let recording = false;
	const recorder: UsbEnumerationPoller = {
		async idPathFor(stableKey: string): Promise<string | undefined> {
			const idPath = await deps.poller.idPathFor(stableKey);
			if (recording) {
				trace.push({ atMs: now(), idPath });
			}
			return idPath;
		},
	};

	const hook = deps.createPowerHook(ports, recorder);
	phase('cycle');
	recording = true;
	const startedAtMs = now();
	const result = await hook.cycle({ stableKey: args.slot, at: epochMillis(startedAtMs) });
	recording = false;

	if (result.status === 'unsupported') {
		return fail('power-cycle-unsupported', result.reason);
	}

	// ---- 3. disappeared -------------------------------------------------------------
	// The VBUS-drop proof: a sample in which the slot's ID_PATH was gone from the bus.
	const goneAt = trace.findIndex((s) => s.idPath !== expectedIdPath);
	const gone = goneAt < 0 ? undefined : trace[goneAt];
	if (gone === undefined) {
		return fail(
			'no-vbus-drop',
			`the modem never left the bus during the cycle — ID_PATH '${expectedIdPath}' was ` +
				`present in all ${trace.length} sample(s). A zero exit from uhubctl does not ` +
				'prove VBUS was cut; run RB-10\u2019s manual two-phase `-a off` / sweep / `-a on` ' +
				'proof to settle whether this hub really switches per-port power.',
		);
	}
	const disappearedMs = gone.atMs - startedAtMs;
	phase('disappeared');

	// ---- 4. reenumerated ------------------------------------------------------------
	const backAt = trace.findIndex((s, i) => i > goneAt && s.idPath === expectedIdPath);
	const back = backAt < 0 ? undefined : trace[backAt];
	if (back === undefined) {
		return fail(
			'reenumeration-timeout',
			`ID_PATH '${expectedIdPath}' left the bus after ${disappearedMs}ms and never came ` +
				`back (hook verdict: ${result.status} — ${result.reason})`,
		);
	}
	const reenumeratedMs = back.atMs - startedAtMs;
	if (reenumeratedMs > reenumerationDeadlineMs) {
		return fail(
			'reenumeration-timeout',
			`ID_PATH '${expectedIdPath}' came back after ${reenumeratedMs}ms, past the ` +
				`${reenumerationDeadlineMs}ms deadline`,
		);
	}
	if (result.status !== 'applied') {
		return fail('power-cycle-failed', result.reason);
	}
	phase('reenumerated');

	// ---- 5. mm-redetect -------------------------------------------------------------
	// The RB-2 assertion, re-run: the runtime /Modem/<n> path MAY change across a cycle,
	// the `modem.generic.device` slot UID may NOT.
	phase('mm-redetect');
	const deadline = now() + mmRedetectTimeoutMs;
	let lastSeen: readonly MmSlotRecord[] = [];
	for (;;) {
		try {
			lastSeen = await deps.mmSlots();
		} catch (error) {
			return fail('mm-redetect-timeout', `re-reading ModemManager failed: ${describe(error)}`);
		}
		if (lastSeen.some((r) => r.device === before.device)) {
			break;
		}
		const atSelector = matchMmSlot(lastSeen, args.mmSlot);
		if (atSelector !== undefined) {
			// A modem answered at the same selector but is NOT the same physical slot —
			// waiting cannot fix that, so fail immediately with the honest reason.
			return fail(
				'mm-slot-mismatch',
				`ModemManager re-detected '${args.mmSlot}' with device '${atSelector.device}', ` +
					`expected '${before.device}'`,
			);
		}
		if (now() >= deadline) {
			return fail(
				'mm-redetect-timeout',
				`ModemManager did not re-report device '${before.device}' within ` +
					`${mmRedetectTimeoutMs}ms (reported: ${lastSeen.map((r) => r.device).join(', ') || '(none)'})`,
			);
		}
		await sleep(mmPollIntervalMs);
	}

	// ---- 6. emit --------------------------------------------------------------------
	phase('emit');
	return {
		kind: 'pass',
		slot: args.slot,
		idPath: expectedIdPath,
		mmDevice: before.device,
		disappearedMs,
		reenumeratedMs,
	};
}

/** Run the harness and print its result. Returns a process exit code. */
export async function runHilCycle(
	io: CliIo,
	args: HilCycleArgs,
	deps: HilCycleDeps,
): Promise<number> {
	const outcome = await hilCycle(args, deps);
	if (outcome.kind === 'failed') {
		io.out(hilCycleFailLine(args.slot, outcome.reason));
		io.err(`hil-cycle: ${outcome.reason}: ${outcome.detail}`);
		return 1;
	}
	io.out(`slot ID_PATH: ${outcome.idPath}`);
	io.out(`mm slot UID:  ${outcome.mmDevice}`);
	io.out(hilCyclePassLine(outcome));
	return 0;
}

/**
 * Match a ModemManager record by its runtime path, a trailing path segment (`Modem/2`
 * or `2`), or its `modem.generic.device` slot UID.
 */
export function matchMmSlot(
	records: readonly MmSlotRecord[],
	selector: string,
): MmSlotRecord | undefined {
	return records.find(
		(r) => r.path === selector || r.path.endsWith(`/${selector}`) || r.device === selector,
	);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
