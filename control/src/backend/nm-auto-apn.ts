// Auto-APN: boot capability probe, the two atomic transition argv builders, and the
// activation-result classifier.
//
// Auto-APN (`apn:"auto"` ⇒ NM `gsm.auto-config yes`) needs NetworkManager >= 1.22
// (bookworm ships 1.42). A boot capability probe reads nmcli's version — replacing any
// implicit/hardcoded gating — and when NM is too old an auto policy resolves to
// `unsupported` up front with the `autoApnUnavailable` advisory (no modify at all).
//
// When NM DOES support auto-config a bad/unknown SIM can still have no MBPI match: the
// connection fails to activate with a GSM_APN_FAILED device-state reason. That is
// classified at ACTIVATION, not guessed ahead of time — reactivate the exact
// (uuid, ifname) pair, await the terminal state, then:
//   GSM_APN_FAILED under an auto profile → unsupported + autoApnUnavailable advisory
//   any other activation error            → failed
//   nmcli's own activation wait timed out → pending

import { type Receipt, receipt } from '../ports';
import { cliArg, passwordFlags } from './nm-gsm-fields';
import { type NmcliResult, type NmcliRunner, runNmcli } from './nmcli-runner';

/** The single advisory Auto-APN raises when it cannot be honored. */
export const AUTO_APN_ADVISORY = 'autoApnUnavailable';
export type AutoApnAdvisory = typeof AUTO_APN_ADVISORY;

/** The outcome of an Auto-APN transition: a receipt plus an optional advisory flag. */
export interface AutoApnTransitionResult {
	readonly receipt: Receipt;
	readonly advisory?: AutoApnAdvisory;
}

/** Explicit APN + credentials for the manual direction of a transition. */
export interface ManualApn {
	readonly apn: string;
	readonly username?: string;
	readonly password?: string;
}

const AUTO_CONFIG_MIN_MAJOR = 1;
const AUTO_CONFIG_MIN_MINOR = 22;

/** nmcli's own `--wait` timeout exit status (nmcli(1): 3 = timeout expired). */
const NMCLI_EXIT_TIMEOUT = 3;

const APN_FAILED = /gsm[_-]?apn[_-]?failed/i;

/** Parse `nmcli tool, version 1.42.4` → `{ major, minor }` (null on garbage). */
export function parseNmVersion(output: string): { major: number; minor: number } | null {
	const match = /version\s+(\d+)\.(\d+)/i.exec(output);
	if (match?.[1] === undefined || match[2] === undefined) {
		return null;
	}
	return { major: Number(match[1]), minor: Number(match[2]) };
}

/** `true` iff the parsed NM version is >= 1.22 (auto-config support floor). */
export function autoApnSupportedByVersion(version: { major: number; minor: number }): boolean {
	if (version.major !== AUTO_CONFIG_MIN_MAJOR) {
		return version.major > AUTO_CONFIG_MIN_MAJOR;
	}
	return version.minor >= AUTO_CONFIG_MIN_MINOR;
}

/**
 * Decide from a `nmcli --version` result whether Auto-APN is available on this install.
 * Fail-CLOSED — an unreadable/garbled version is "not capable", so we never claim
 * Auto-APN works when we cannot prove it does.
 */
export function autoApnCapableFromVersion(result: NmcliResult): boolean {
	if (result.exitCode !== 0) {
		return false;
	}
	const version = parseNmVersion(result.stdout);
	return version !== null && autoApnSupportedByVersion(version);
}

/** Boot capability probe: run `nmcli --version` and resolve Auto-APN availability. */
export async function probeAutoApnCapability(runner: NmcliRunner): Promise<boolean> {
	return autoApnCapableFromVersion(await runNmcli(runner, ['--version']));
}

/**
 * ONE atomic `connection modify` that flips a profile to Auto-APN: clears every
 * credential AND sets `gsm.auto-config yes` in the SAME invocation. Order/atomicity
 * matter — NM rejects `auto-config yes` while any credential is still set, so the clear
 * and the enable MUST land together (never two modifies).
 */
export function toAutoArgs(id: string): string[] {
	return [
		'connection',
		'modify',
		id,
		'gsm.apn',
		'',
		'gsm.username',
		'',
		'gsm.password',
		'',
		'gsm.password-flags',
		'4',
		'gsm.auto-config',
		'yes',
	];
}

/**
 * The exact reverse: ONE atomic `connection modify` restoring explicit APN + creds and
 * clearing `gsm.auto-config`, with password-flags matching the (new) password.
 */
export function toManualArgs(id: string, creds: ManualApn): string[] {
	return [
		'connection',
		'modify',
		id,
		'gsm.apn',
		cliArg(creds.apn),
		'gsm.username',
		cliArg(creds.username),
		'gsm.password',
		cliArg(creds.password),
		'gsm.password-flags',
		passwordFlags(creds.password),
		'gsm.auto-config',
		'no',
	];
}

/**
 * Classify a `connection up` result into a receipt (+ advisory). `underAuto` marks that
 * the profile being activated is an Auto-APN profile, so an APN failure is the "no MBPI
 * match for this SIM" case → unsupported + advisory rather than a hard fail.
 */
export function classifyActivation(
	result: NmcliResult,
	options: { readonly underAuto: boolean },
): AutoApnTransitionResult {
	if (result.exitCode === 0) {
		return { receipt: receipt('connection', 'applied', 'connection activated') };
	}
	if (result.exitCode === NMCLI_EXIT_TIMEOUT || /timeout/i.test(result.stderr)) {
		return {
			receipt: receipt(
				'connection',
				'pending',
				'activation wait timed out; terminal state unknown',
			),
		};
	}
	if (options.underAuto && (APN_FAILED.test(result.stderr) || APN_FAILED.test(result.stdout))) {
		return {
			receipt: receipt(
				'connection',
				'unsupported',
				'Auto-APN found no operator match for this SIM',
			),
			advisory: AUTO_APN_ADVISORY,
		};
	}
	return {
		receipt: receipt('connection', 'failed', result.stderr || 'connection activation failed'),
	};
}
