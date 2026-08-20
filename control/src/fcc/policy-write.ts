// `setFccUnlockPolicy` — the WRITE half of the FCC auto-unlock surface.
//
// TYPED RESULTS, NEVER A THROW ON BAD INPUT. Following the `PowerHook` and
// `setUsagePolicy` precedents, a malformed key or an uncovered model is a `rejected`
// result carrying a named reason rather than an exception — this is called from an
// RPC boundary, where a throw becomes an opaque 500.
//
// THE COVERAGE CHECK IS PART OF THE WRITE, not a UI nicety. Persisting `true` for a
// model ModemManager ships no procedure for would leave the operator staring at an
// enabled toggle that provably cannot do anything: the reconciler would find no
// `<vid>:<pid>` in the available tier and skip it forever, silently. Refusing at the
// write is the only place that fact can be reported to the person who asked for it.
//
// Disabling is deliberately NOT coverage-checked. A `false` must always be
// persistable — including for a model whose coverage answer has since changed, or
// which a previous release wrote — because a fail-closed opt-OUT is not a thing.

import { normalizeVidPid, resolveFccUnlockCoverage } from './coverage';
import type { FccUnlockPolicyStore, PersistedFccUnlockPolicy } from './policy-store';

export interface SetFccUnlockPolicyDeps {
	readonly store: FccUnlockPolicyStore;
	/** Injectable clock (defaults to `Date.now`). */
	readonly now?: () => number;
}

export interface SetFccUnlockPolicyRequest {
	readonly vid: string;
	readonly pid: string;
	readonly enabled: boolean;
}

export type SetFccUnlockPolicyRejection = 'invalid-vid-pid' | 'not-covered';

export type SetFccUnlockPolicyResult =
	| {
			readonly status: 'applied';
			/** The dispatcher key this write is about, normalized. */
			readonly key: string;
			readonly enabled: boolean;
			/** The whole document now on disk, so a caller need not re-read it. */
			readonly policy: PersistedFccUnlockPolicy;
			/**
			 * True when the persisted value CHANGED. A caller uses this to decide
			 * whether the modem needs a re-probe: ModemManager runs the dispatcher
			 * during initialization only, so a genuine change needs
			 * `mmcli -m <id> --disable && --enable` (or a replug) to take effect on an
			 * already-enumerated modem — and an unchanged write must not cost one.
			 */
			readonly changed: boolean;
	  }
	| {
			readonly status: 'rejected';
			readonly reason: SetFccUnlockPolicyRejection;
	  };

export async function setFccUnlockPolicy(
	request: SetFccUnlockPolicyRequest,
	deps: SetFccUnlockPolicyDeps,
): Promise<SetFccUnlockPolicyResult> {
	const key = normalizeVidPid(request.vid, request.pid);
	if (key === undefined) {
		return { status: 'rejected', reason: 'invalid-vid-pid' };
	}
	if (request.enabled && resolveFccUnlockCoverage(request.vid, request.pid) !== 'present') {
		return { status: 'rejected', reason: 'not-covered' };
	}

	const now = deps.now ?? Date.now;
	const nowMs = now();
	const current = await deps.store.load(nowMs);
	const changed = (current.unlock[key] === true) !== request.enabled;

	const next: PersistedFccUnlockPolicy = {
		schemaVersion: current.schemaVersion,
		savedAtMs: nowMs,
		unlock: { ...current.unlock, [key]: request.enabled },
	};
	await deps.store.save(next);

	return { status: 'applied', key, enabled: request.enabled, policy: next, changed };
}
