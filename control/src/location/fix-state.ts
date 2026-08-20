// The GNSS display state machine — bounded acquisition and stale-fix expiry.
//
// It exists to make two dishonest renders impossible rather than merely unlikely:
//
//   1. An endless "acquiring…" spinner. A modem with no antenna answers "no fix"
//      forever, quite correctly, and a naive UI waits forever. Acquisition here is
//      BOUNDED — past `acquireTimeoutMs` the state becomes `no-fix`, which is a
//      terminal render, not a spinner.
//   2. A stale coordinate shown as current. A fix is only reachable through
//      `renderableFix`, which returns one ONLY in the `fix` state; every exit from
//      that state DROPS the fix rather than carrying it, so there is no code path
//      that can render a position the modem is no longer reporting.
//
// Pure and total: no clock, no I/O. The caller supplies `at` on every event, which
// is what makes both bounds testable without waiting for real time to pass.

import type { EpochMillis } from '../domain';
import type { FixRead, GnssFix } from '../ports/location';

export interface GnssFixStateConfig {
	/** How long acquisition may run before the state turns to an honest `no-fix`. */
	readonly acquireTimeoutMs: number;
	/** How long a fix stays current before it expires and is dropped. */
	readonly fixTtlMs: number;
}

/**
 * Defaults chosen against the fleet's own numbers: a cold GNSS start on the
 * bench modems is a low-minutes affair, so 120 s is long enough to be a fair
 * attempt and short enough that a missing antenna is reported inside a support
 * call rather than after one. A fix older than 30 s is not "current" on a moving
 * vehicle, which is the only context this display has.
 */
export const DEFAULT_FIX_STATE_CONFIG: GnssFixStateConfig = {
	acquireTimeoutMs: 120_000,
	fixTtlMs: 30_000,
};

export type NoFixReason = 'acquire-timeout' | 'reported-no-fix' | 'fix-expired';

export type GnssFixState =
	| { readonly kind: 'off' }
	| { readonly kind: 'acquiring'; readonly since: EpochMillis }
	| { readonly kind: 'no-fix'; readonly since: EpochMillis; readonly reason: NoFixReason }
	| { readonly kind: 'fix'; readonly fix: GnssFix }
	| { readonly kind: 'unavailable'; readonly reason: string };

export type GnssFixEvent =
	| { readonly kind: 'gnss-enabled'; readonly at: EpochMillis }
	| { readonly kind: 'gnss-disabled' }
	| { readonly kind: 'read'; readonly at: EpochMillis; readonly read: FixRead }
	| { readonly kind: 'tick'; readonly at: EpochMillis };

export const GNSS_OFF: GnssFixState = { kind: 'off' };

/** A fix is reachable ONLY here, and only while the state actually holds one. */
export function renderableFix(state: GnssFixState): GnssFix | undefined {
	return state.kind === 'fix' ? state.fix : undefined;
}

/** True while a bounded wait is legitimately in progress — the only spinner state. */
export function isAcquiring(state: GnssFixState): boolean {
	return state.kind === 'acquiring';
}

function expireIfDue(
	state: GnssFixState,
	at: EpochMillis,
	config: GnssFixStateConfig,
): GnssFixState {
	if (state.kind === 'acquiring' && at - state.since >= config.acquireTimeoutMs) {
		return { kind: 'no-fix', since: at, reason: 'acquire-timeout' };
	}
	if (state.kind === 'fix' && at - state.fix.observedAt >= config.fixTtlMs) {
		return { kind: 'no-fix', since: at, reason: 'fix-expired' };
	}
	return state;
}

function applyRead(
	state: GnssFixState,
	at: EpochMillis,
	read: FixRead,
	config: GnssFixStateConfig,
): GnssFixState {
	switch (read.outcome) {
		case 'fix':
			return { kind: 'fix', fix: read.fix };
		case 'no-fix':
			// Still inside the bound, the modem simply has not acquired yet — that is
			// what `acquiring` means, so a report of no-fix does not end the wait. Any
			// other state (including a held fix) drops to an honest `no-fix`.
			return state.kind === 'acquiring'
				? expireIfDue(state, at, config)
				: { kind: 'no-fix', since: at, reason: 'reported-no-fix' };
		case 'disabled':
			return GNSS_OFF;
		case 'unsupported':
		case 'error':
			return { kind: 'unavailable', reason: read.reason };
	}
}

/** Pure, total transition. Every exit from `fix` drops the coordinates. */
export function advanceGnssFixState(
	state: GnssFixState,
	event: GnssFixEvent,
	config: GnssFixStateConfig = DEFAULT_FIX_STATE_CONFIG,
): GnssFixState {
	switch (event.kind) {
		case 'gnss-enabled':
			return state.kind === 'fix' ? state : { kind: 'acquiring', since: event.at };
		case 'gnss-disabled':
			return GNSS_OFF;
		case 'read':
			return applyRead(state, event.at, event.read, config);
		case 'tick':
			return expireIfDue(state, event.at, config);
	}
}
