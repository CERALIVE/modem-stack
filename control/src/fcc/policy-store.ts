// Durable persistence for the operator's FCC-auto-unlock POLICY.
//
// WHY THE FILE IS THE RECORD AND THE SYMLINK IS NOT. ModemManager's opt-in
// mechanism is a symlink in `/etc/ModemManager/fcc-unlock.d/<vid>:<pid>`. `/etc` is
// on the rootfs, and the rootfs is exactly what a RAUC A/B slot swap REPLACES
// (`image-building-pipeline/docs/partition-contract.md`), so that symlink survives a
// reboot and does NOT survive an OTA. `/data` is the only update-surviving store, so
// the durable record lives there and the symlink is a derived artifact re-created
// from it on every boot by `ceralive-fcc-reconcile`.
//
// The two hard guarantees are the SAME ones `backend/usage/policy-store.ts` makes,
// and deliberately implemented the same way so the pair can be read side by side:
//   - MODE 0600 via temp → chmod → atomic rename, regardless of umask.
//   - FAIL-SAFE ON CORRUPTION: an unparseable/incompatible file logs METADATA ONLY
//     (byte length + a classification reason, never the content) and is treated as
//     EMPTY. Note the divergence from the usage store, and it is load-bearing: the
//     usage store REWRITES a fresh file, while this one leaves the damaged bytes on
//     disk for an operator to look at and simply refuses to act on them. Enabling a
//     regulatory-unlock procedure is not something to infer from a file we could not
//     read, and silently replacing the evidence would make the next person's
//     diagnosis impossible.
//
// A policy row carries ONLY a `<vid>:<pid>` MODEL identifier and a boolean. There is
// no per-unit identity here by construction — no serial, no ICCID, no ID_PATH —
// because ModemManager's mechanism is model-wide and a per-unit key would be a
// promise the dispatcher cannot keep.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isFccUnlockKey } from './coverage';

/** The current on-disk schema version. Bump when the persisted shape changes. */
export const FCC_UNLOCK_SCHEMA_VERSION = 1;

/** The pinned location of the policy of record. `/data` survives a slot swap. */
export const FCC_UNLOCK_POLICY_PATH = '/data/ceralive/fcc-unlock-policy.json';

/**
 * The persisted document.
 *
 * `unlock` is a TOTAL map from `<vid>:<pid>` to the operator's answer. An absent key
 * and an explicit `false` are the same fact (not opted in) and both are legal on
 * disk: a `false` is what an opt-OUT leaves behind, and keeping it is what lets the
 * shell reconciler prove it parsed a real answer rather than an empty document.
 */
export interface PersistedFccUnlockPolicy {
	readonly schemaVersion: typeof FCC_UNLOCK_SCHEMA_VERSION;
	readonly savedAtMs: number;
	readonly unlock: Readonly<Record<string, boolean>>;
}

/** A metadata-only log event. Corruption NEVER carries the raw file content. */
export type FccUnlockLogEvent = {
	readonly kind: 'corrupt-policy';
	readonly bytes: number;
	readonly reason: string;
};

export type FccUnlockLogger = (event: FccUnlockLogEvent) => void;

/** The persistence seam `setFccUnlockPolicy` drives. */
export interface FccUnlockPolicyStore {
	/** Load persisted policy; an absent or unreadable file loads as EMPTY. */
	load(nowMs: number): Promise<PersistedFccUnlockPolicy>;
	/** Atomically write policy with mode 0600 (temp → chmod → rename). */
	save(state: PersistedFccUnlockPolicy): Promise<void>;
}

export interface FccUnlockPolicyFileStoreOptions {
	readonly path?: string;
	readonly logger?: FccUnlockLogger;
}

function defaultLogger(event: FccUnlockLogEvent): void {
	console.warn(`[fcc-unlock-policy] ${event.kind}: bytes=${event.bytes} reason=${event.reason}`);
}

function emptyState(nowMs: number): PersistedFccUnlockPolicy {
	return { schemaVersion: FCC_UNLOCK_SCHEMA_VERSION, savedAtMs: nowMs, unlock: {} };
}

/** A schema violation naming only the offending FIELD (never file content). */
class FccPolicySchemaError extends Error {
	constructor(field: string) {
		super(`schema-mismatch: ${field}`);
	}
}

/**
 * Parse + validate the document. Throws `FccPolicySchemaError` (metadata-only).
 *
 * WHOLE-DOCUMENT rejection, never per-key skipping: a half-applied policy is a
 * policy nobody wrote, and the shell reconciler makes the same all-or-nothing
 * judgement, so the two halves agree on what a damaged file means.
 */
function validate(raw: unknown): PersistedFccUnlockPolicy {
	if (typeof raw !== 'object' || raw === null) {
		throw new FccPolicySchemaError('document');
	}
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== FCC_UNLOCK_SCHEMA_VERSION) {
		throw new FccPolicySchemaError('schemaVersion');
	}
	if (typeof doc.savedAtMs !== 'number' || !Number.isFinite(doc.savedAtMs)) {
		throw new FccPolicySchemaError('savedAtMs');
	}
	if (typeof doc.unlock !== 'object' || doc.unlock === null || Array.isArray(doc.unlock)) {
		throw new FccPolicySchemaError('unlock');
	}
	const unlock: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(doc.unlock as Record<string, unknown>)) {
		if (!isFccUnlockKey(key)) {
			throw new FccPolicySchemaError('unlock.key');
		}
		if (typeof value !== 'boolean') {
			throw new FccPolicySchemaError('unlock.value');
		}
		unlock[key] = value;
	}
	return {
		schemaVersion: FCC_UNLOCK_SCHEMA_VERSION,
		savedAtMs: doc.savedAtMs,
		unlock,
	};
}

/** Classify a load failure into a metadata-only reason string (no raw content). */
function classifyFailure(error: unknown): string {
	if (error instanceof FccPolicySchemaError) {
		return error.message;
	}
	if (error instanceof SyntaxError) {
		const offset = /position (\d+)/.exec(error.message)?.[1];
		return offset !== undefined ? `invalid-json at offset ${offset}` : 'invalid-json';
	}
	return 'unreadable';
}

/** The `<vid>:<pid>` models the policy positively enables. Sorted, for stability. */
export function enabledFccUnlockKeys(state: PersistedFccUnlockPolicy): string[] {
	return Object.entries(state.unlock)
		.filter(([, enabled]) => enabled)
		.map(([key]) => key)
		.sort();
}

/** One model's answer. An unmentioned model is NOT enabled — absence is not consent. */
export function isFccUnlockEnabled(state: PersistedFccUnlockPolicy, key: string): boolean {
	return state.unlock[key] === true;
}

export function createFccUnlockPolicyFileStore(
	options: FccUnlockPolicyFileStoreOptions = {},
): FccUnlockPolicyStore {
	const logger = options.logger ?? defaultLogger;
	const path = options.path ?? FCC_UNLOCK_POLICY_PATH;

	async function writeAtomic(state: PersistedFccUnlockPolicy): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		// The trailing newline is for the shell reconciler's benefit, not decoration:
		// it reads the file with `tr -d`, and a newline-terminated document is what a
		// human `cat`ing it on a board expects to see.
		await writeFile(tmp, `${JSON.stringify(state)}\n`);
		// chmod AFTER the write (not an open flag) so mode is 0600 regardless of umask.
		await chmod(tmp, 0o600);
		await rename(tmp, path);
	}

	return {
		async load(nowMs: number): Promise<PersistedFccUnlockPolicy> {
			let text: string;
			try {
				text = await readFile(path, 'utf8');
			} catch {
				// Absent (or unreadable) → EMPTY, which activates nothing. This is the
				// state on every device that never opted in, and it is the safe default.
				return emptyState(nowMs);
			}
			try {
				return validate(JSON.parse(text));
			} catch (error) {
				logger({
					kind: 'corrupt-policy',
					bytes: Buffer.byteLength(text, 'utf8'),
					reason: classifyFailure(error),
				});
				// Deliberately NOT rewritten — see the header. Refuse to act, keep the
				// evidence, and let the next write replace it wholesale.
				return emptyState(nowMs);
			}
		},
		save: writeAtomic,
	};
}
