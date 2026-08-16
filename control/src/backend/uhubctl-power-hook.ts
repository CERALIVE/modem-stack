// The `usb-hub-port-cycle` power hook — recovery ladder rung 4, backed by `uhubctl`.
//
// This is the FIRST real `PowerHook` implementation. It cuts VBUS on one port of a
// per-port-power-switching (PPPS) USB hub, waits for the modem to come back on the
// SAME physical topology path, and reports `applied` only when it actually did.
//
// FOUR safety properties, in the order they bite:
//
//   1. CONFIG-MAPPED, NEVER DISCOVERED. A stable key is power-cyclable only if an
//      operator wrote it into an explicitly-pathed config file (`readUhubctlPowerConfig`
//      takes the path as an argument — there is no default path, no search, no probe).
//      An unmapped key returns `unsupported` and touches nothing. Guessing which hub
//      port a modem is on and then cutting its power is exactly the failure mode that
//      would black out an unrelated device.
//   2. ARGV ONLY, ALLOWLISTED. The command is built as an argv array and handed to an
//      injected runner — there is no shell, no string interpolation, no `sh -c`. Every
//      generated token is re-checked against `ALLOWED_ARGV` before the runner is
//      called, so even a config that somehow evaded the schema cannot smuggle a flag.
//   3. BOUNDED + CANCELLABLE. The runner call is bounded by `commandTimeoutMs`, the
//      re-enumeration wait by `enumerationTimeoutMs`, and both observe an optional
//      `AbortSignal`. The worst case is `commandTimeoutMs + enumerationTimeoutMs`;
//      there is no path that waits forever.
//   4. SERIALISED PER MODEM. Like every other disruptive op in this backend (see
//      `mm-mutations.ts`), a cycle runs through the shared per-modem `ModemActor`,
//      keyed on the STABLE key. Two overlapping cycles on one port would otherwise
//      interleave a power-on with a power-off and leave the port dark.
//
// PROOF OF SUCCESS IS RE-ENUMERATION, NOT EXIT CODE 0. `uhubctl` exiting 0 only means
// the hub accepted the request. The hook records the modem's `ID_PATH` BEFORE the cut
// and only reports `applied` once that same `ID_PATH` is observed again — a port that
// powers back up with nothing on it is a `failed`, reported with expected-vs-observed.
//
// -----------------------------------------------------------------------------------
// CAVEAT — STALE DEVICE FILES ON LINUX KERNELS BEFORE 6.0.
//
// uhubctl README, FAQ section `_USB devices are not removed after port power down on
// Linux_` (github.com/mvp/uhubctl, README.md), verbatim:
//
//   "After powering down USB port, udev does not get any event, so it keeps the device
//    files around. However, trying to access the device files will lead to an IO error.
//    This is Linux kernel issue and is fixed since uhubctl 2.5.0 for systems with Linux
//    kernel 6.0 or later. If you are still using Linux 5.x or older, you can use this
//    workaround for this issue:
//
//        sudo uhubctl -a off -l ${location} -p ${port}
//        sudo udevadm trigger --action=remove /sys/bus/usb/devices/${location}.${port}/
//
//    Device file will be removed by udev, but USB device will be still visible in
//    `lsusb`. Note that path /sys/bus/usb/devices/${location}.${port} will only exist if
//    device was detected on that port. When you turn power back on, device should
//    re-enumerate properly (no need to call `udevadm` again)."
//
// Why it matters HERE: during the dark window of a cycle, a pre-6.0 kernel leaves the
// device files in place, so a presence check that asks "does the node still exist?"
// reports the modem as present when it is electrically gone — and would let this hook
// declare `applied` off a stale artefact rather than a real re-enumeration.
//
// THIS HOOK DOES NOT RUN `udevadm trigger --action=remove` ITSELF, deliberately: it is
// a privileged host-wide udev mutation whose sysfs path only exists if a device was
// detected there, and firing it from a recovery rung would make rung 4 mutate state
// well outside the port it was mapped to. Instead the hook is built so the caveat
// cannot corrupt its verdict — presence is resolved by the INJECTED
// `UsbEnumerationPoller`, whose production implementation re-reads udev every call and
// never caches (see `usb-enumerator.ts`, which re-runs `udevadm info --export-db` per
// `enumerate()`), and the postcondition compares `ID_PATH`, not a device-node path. A
// deployment pinned to a pre-6.0 kernel wires the `udevadm trigger --action=remove`
// step into that poller or into a udev rule — one explicit, auditable place.
//
// Hardware note: the README's compatible-hub table lists `0BDA:0411` (Rosonway RSH-A10
// / RSH-A16, Juiced Systems 6HUB-01) as per-port-power-switching capable — that is the
// Realtek chipset on this project's bench board. `0bda:5411` is NOT on that list, so a
// hub reporting that id may need `-f`, which this hook never passes.
// -----------------------------------------------------------------------------------

import { z } from 'zod';
import { ModemActor } from './modem-actor';
import type {
	PowerCapability,
	PowerCycleContext,
	PowerCycleResult,
	PowerHook,
	PreferredUsbMode,
} from './power-contract';

/**
 * A uhubctl hub location: `<bus>-<port>[.<port>…]` (e.g. `1-1`, `2-1.4`), or a bare
 * bus number for a root hub. This mirrors the Linux sysfs USB path and is the ONLY
 * shape accepted — a VID:PID selector or a `--` flag can never parse as one.
 */
const HUB_LOCATION = /^[0-9]{1,3}(-[0-9]{1,3}(\.[0-9]{1,3})*)?$/;

/** One mapped modem: which PPPS hub it hangs off, and which port on that hub. */
export const uhubctlPortMappingSchema = z.strictObject({
	/** The hub's uhubctl location (`-l`), e.g. `1-1` or `2-1.4`. */
	hubLocation: z.string().regex(HUB_LOCATION, 'hubLocation must look like `1-1` or `2-1.4`'),
	/** The 1-based port number on that hub (`-p`). */
	port: z.number().int().min(1).max(255),
});
export type UhubctlPortMapping = z.infer<typeof uhubctlPortMappingSchema>;

/**
 * The whole config file: a map from STABLE KEY to its hub/port mapping. `.strictObject`
 * on each entry means a typo'd or smuggled extra field is rejected rather than ignored.
 */
export const uhubctlPortMapSchema = z.record(z.string().min(1), uhubctlPortMappingSchema);
export type UhubctlPortMap = z.infer<typeof uhubctlPortMapSchema>;

/**
 * Parse config text (JSON) into a validated port map. `path` is used only for the
 * error message, so a malformed file fails visibly with a named field.
 */
export function parseUhubctlPortMap(text: string, path: string): UhubctlPortMap {
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`invalid uhubctl port map ${path}: ${describe(error)}`);
	}
	const result = uhubctlPortMapSchema.safeParse(raw);
	if (!result.success) {
		const issue = result.error.issues[0];
		const where = issue?.path.join('.') || '(root)';
		throw new Error(
			`invalid uhubctl port map ${path}: ${where}: ${issue?.message ?? 'schema mismatch'}`,
		);
	}
	return result.data;
}

/**
 * Read + validate a port map from an EXPLICIT path. There is intentionally no default
 * and no discovery: a caller that cannot name the file gets no power control.
 */
export async function readUhubctlPortMap(path: string): Promise<UhubctlPortMap> {
	return parseUhubctlPortMap(await Bun.file(path).text(), path);
}

/** The result of one `uhubctl` invocation. */
export interface UhubctlResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/**
 * A runner over `uhubctl` argv — structurally the same seam as `NmcliRunner`. Tests
 * inject a fake; the device injects `SpawnUhubctlRunner`. The hook NEVER spawns
 * directly, so the argv the tests assert against is byte-for-byte what runs on-device.
 */
export interface UhubctlRunner {
	run(argv: readonly string[]): UhubctlResult | Promise<UhubctlResult>;
}

/** The device-exact runner: spawns the real `uhubctl` with the argv array verbatim. */
export class SpawnUhubctlRunner implements UhubctlRunner {
	async run(argv: readonly string[]): Promise<UhubctlResult> {
		const proc = Bun.spawn(['uhubctl', ...argv], { stdout: 'pipe', stderr: 'pipe' });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}
}

/**
 * Resolves the modem's current udev `ID_PATH` (its physical topology UID) for a stable
 * key, or `undefined` when nothing is enumerated there. Injected so tests need no
 * hardware; the production implementation MUST re-read udev/sysfs every call (see the
 * pre-6.0 stale-devfile caveat at the top of this file).
 */
export interface UsbEnumerationPoller {
	idPathFor(stableKey: string): string | undefined | Promise<string | undefined>;
}

const DEFAULT_ENUMERATION_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
/** `uhubctl -d` — seconds the port stays dark before it is powered back on. */
const DEFAULT_POWER_OFF_DELAY_SECONDS = 3;

/** Construction dependencies. Everything that touches the system is injectable. */
export interface UhubctlPowerHookDeps {
	/** The validated stable-key → hub/port map (see `readUhubctlPortMap`). */
	readonly ports: UhubctlPortMap;
	readonly runner: UhubctlRunner;
	readonly poller: UsbEnumerationPoller;
	/** Shared per-modem serialisation. Defaults to a private actor. */
	readonly actor?: ModemActor;
	readonly enumerationTimeoutMs?: number;
	readonly commandTimeoutMs?: number;
	readonly pollIntervalMs?: number;
	readonly powerOffDelaySeconds?: number;
	readonly preferredUsbMode?: PreferredUsbMode;
	/** Cancels an in-flight cycle — the hook resolves `failed`, it never hangs. */
	readonly signal?: AbortSignal;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
}

/**
 * Every argv token this hook is permitted to emit. The flags are literals; the two
 * value slots are re-validated against the same shapes the schema enforced. Anything
 * else is a bug in this file and fails closed before the runner is called.
 */
const ALLOWED_ARGV: readonly RegExp[] = [
	/^-l$/,
	/^-p$/,
	/^-a$/,
	/^-d$/,
	/^cycle$/,
	HUB_LOCATION,
	/^[0-9]{1,3}$/,
];

/** Build the `uhubctl` argv for one mapping. Pure + exported so tests can assert it. */
export function uhubctlCycleArgv(
	mapping: UhubctlPortMapping,
	powerOffDelaySeconds: number,
): readonly string[] {
	const argv = [
		'-l',
		mapping.hubLocation,
		'-p',
		String(mapping.port),
		'-a',
		'cycle',
		'-d',
		String(powerOffDelaySeconds),
	];
	for (const token of argv) {
		if (!ALLOWED_ARGV.some((allowed) => allowed.test(token))) {
			throw new Error(`refusing to run uhubctl: argv token '${token}' is not allowlisted`);
		}
	}
	return argv;
}

/** The `usb-hub-port-cycle` power hook. One instance serves every mapped modem. */
export function createUhubctlPowerHook(deps: UhubctlPowerHookDeps): PowerHook {
	const enumerationTimeoutMs = deps.enumerationTimeoutMs ?? DEFAULT_ENUMERATION_TIMEOUT_MS;
	const commandTimeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const powerOffDelaySeconds = deps.powerOffDelaySeconds ?? DEFAULT_POWER_OFF_DELAY_SECONDS;
	const actor = deps.actor ?? new ModemActor();
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;

	const capability: PowerCapability = {
		power: 'usb-hub-port-cycle',
		usbReset: true,
		enumerationTimeoutMs,
		...(deps.preferredUsbMode !== undefined ? { preferredUsbMode: deps.preferredUsbMode } : {}),
	};

	const cancelled = (): PowerCycleResult | undefined =>
		deps.signal?.aborted === true
			? { status: 'failed', reason: 'power cycle cancelled by the caller' }
			: undefined;

	async function awaitReenumeration(
		stableKey: string,
		expected: string | undefined,
	): Promise<PowerCycleResult> {
		const deadline = now() + enumerationTimeoutMs;
		let observed: string | undefined;
		while (now() < deadline) {
			const abort = cancelled();
			if (abort !== undefined) {
				return abort;
			}
			observed = await deps.poller.idPathFor(stableKey);
			// A port cycle preserves the physical topology, so the SAME ID_PATH must
			// come back. If nothing was enumerated before the cut there is no path to
			// compare against — any device re-appearing at that key is the recovery.
			if (observed !== undefined && (expected === undefined || observed === expected)) {
				return {
					status: 'applied',
					reason: `port cycled; modem re-enumerated at ID_PATH '${observed}'`,
				};
			}
			await sleep(pollIntervalMs);
		}
		return {
			status: 'failed',
			reason:
				`modem did not re-enumerate within ${enumerationTimeoutMs}ms — expected ID_PATH ` +
				`${expected === undefined ? '(any device)' : `'${expected}'`}, observed ` +
				`${observed === undefined ? 'no device' : `'${observed}'`}`,
		};
	}

	async function cycleMapped(
		stableKey: string,
		mapping: UhubctlPortMapping,
	): Promise<PowerCycleResult> {
		// Record the pre-cut topology path — the postcondition compares against it.
		const expected = await deps.poller.idPathFor(stableKey);

		let argv: readonly string[];
		try {
			argv = uhubctlCycleArgv(mapping, powerOffDelaySeconds);
		} catch (error) {
			return { status: 'failed', reason: describe(error) };
		}

		let result: UhubctlResult;
		try {
			result = await withTimeout(
				Promise.resolve(deps.runner.run(argv)),
				commandTimeoutMs,
				`uhubctl did not return within ${commandTimeoutMs}ms`,
			);
		} catch (error) {
			return { status: 'failed', reason: `uhubctl ${argv.join(' ')} failed: ${describe(error)}` };
		}
		if (result.exitCode !== 0) {
			return {
				status: 'failed',
				reason:
					`uhubctl ${argv.join(' ')} exited ${result.exitCode}: ` +
					`${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
			};
		}

		// Exit 0 only means the hub accepted the request — re-enumeration is the proof.
		return awaitReenumeration(stableKey, expected);
	}

	return {
		capability,
		cycle(context: PowerCycleContext): Promise<PowerCycleResult> {
			const { stableKey } = context;
			const mapping = deps.ports[stableKey];
			if (mapping === undefined) {
				// Refuse BEFORE the actor and before any I/O: an unmapped key must never
				// cut power to a port that was never declared to belong to it.
				return Promise.resolve({
					status: 'unsupported',
					reason: `no uhubctl hub/port mapping is configured for stable key '${stableKey}'`,
				});
			}
			const abort = cancelled();
			if (abort !== undefined) {
				return Promise.resolve(abort);
			}
			// Serialised on the STABLE key, like every other disruptive op (mm-mutations).
			return actor.run(stableKey, () => cycleMapped(stableKey, mapping));
		},
	};
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bound a promise; rejects with `message` if it has not settled in `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
