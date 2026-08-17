// Durable persistence for the operator's data-usage POLICY (cycle day + advisory
// threshold), the write-side counterpart of `store.ts`'s counter persistence.
//
// WHY THIS IS LOCAL STATE AND NOT A MODEM WRITE. ModemManager has no data-usage
// API at all. Verified against a live MM 1.24.2 (`mmcli --help-all`, plus a D-Bus
// introspection of a real `…/ModemManager1/Modem/N`): the only `Setup`/threshold
// surface on the whole object is `Modem.Signal.Setup` /
// `Modem.Signal.SetupThresholds`, whose keys are `rssi-threshold` and
// `error-rate-threshold` — RADIO QUALITY, not bytes. The only byte counters MM
// offers are the per-BEARER read-only `Stats` (`rx-bytes`/`tx-bytes`), which
// reset with every connection and therefore cannot carry a monthly cycle.
//
// That is exactly why the sampler in this directory counts `/proc/net/dev`
// instead, and why `ports/README.md`'s ownership table records usage policy as
// LOCAL-CONTROLLER owned. So the write path is a local, versioned, fail-soft
// file — never a D-Bus mutation. (`Modem.Signal.Setup` is additionally forbidden
// outright by the shadow-mode mutation-freedom contract; nothing here goes near
// it.)
//
// The two hard guarantees are the SAME ones `store.ts` makes, and deliberately
// implemented the same way so the pair can be read side by side:
//   - MODE 0600 via temp → chmod → atomic rename, regardless of umask.
//   - FAIL-SOFT ON CORRUPTION: an unparseable/incompatible file logs METADATA
//     ONLY (byte length + a classification reason, never the content) and is
//     replaced by a fresh empty 0600 file rather than throwing.
//
// A policy row carries ONLY an opaque slot id and two numbers. By construction
// there is no subscriber or device identity here (no ICCID/IMSI/IMEI, no
// operator, no model) — the same no-PII property the counter store holds.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DesiredUsage } from '../../domain';

/** The current on-disk schema version. Bump when the persisted shape changes. */
export const USAGE_POLICY_SCHEMA_VERSION = 1;

/** One slot's persisted usage policy. Both fields are absent when unset. */
export interface PersistedUsagePolicySlot {
	readonly logicalSlotId: string;
	/** Day of month (1–31) the cycle resets; UTC, month-length clamped (A4.3). */
	readonly cycleDay?: number;
	/** Advisory threshold in bytes; crossing it raises an advisory, never gates. */
	readonly thresholdBytes?: number;
}

/** The full persisted policy document. */
export interface PersistedUsagePolicy {
	readonly schemaVersion: typeof USAGE_POLICY_SCHEMA_VERSION;
	readonly savedAtMs: number;
	readonly slots: readonly PersistedUsagePolicySlot[];
}

/** A metadata-only log event. Corruption NEVER carries the raw file content. */
export type UsagePolicyLogEvent = {
	readonly kind: 'corrupt-policy';
	readonly bytes: number;
	readonly reason: string;
};

/** Sink for policy-store log events. Defaults to a metadata-only `console.warn`. */
export type UsagePolicyLogger = (event: UsagePolicyLogEvent) => void;

/** The persistence seam `setUsagePolicy` drives. */
export interface UsagePolicyStore {
	/** Load persisted policy; recreate a fresh 0600 file if absent or corrupt. */
	load(nowMs: number): Promise<PersistedUsagePolicy>;
	/** Atomically write policy with mode 0600 (temp → chmod → rename). */
	save(state: PersistedUsagePolicy): Promise<void>;
}

export interface UsagePolicyFileStoreOptions {
	readonly path: string;
	readonly logger?: UsagePolicyLogger;
}

function defaultLogger(event: UsagePolicyLogEvent): void {
	console.warn(`[usage-policy] ${event.kind}: bytes=${event.bytes} reason=${event.reason}`);
}

function freshState(nowMs: number): PersistedUsagePolicy {
	return { schemaVersion: USAGE_POLICY_SCHEMA_VERSION, savedAtMs: nowMs, slots: [] };
}

/** A schema violation naming only the offending FIELD (never file content). */
class PolicySchemaError extends Error {
	constructor(field: string) {
		super(`schema-mismatch: ${field}`);
	}
}

/** True for a value that is a legal cycle day (integer 1–31). */
export function isValidCycleDay(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31;
}

/** True for a value that is a legal advisory threshold (non-negative integer). */
export function isValidThresholdBytes(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateSlot(raw: unknown): PersistedUsagePolicySlot {
	if (typeof raw !== 'object' || raw === null) {
		throw new PolicySchemaError('slot');
	}
	const slot = raw as Record<string, unknown>;
	if (typeof slot.logicalSlotId !== 'string' || slot.logicalSlotId.length === 0) {
		throw new PolicySchemaError('logicalSlotId');
	}
	if (slot.cycleDay !== undefined && !isValidCycleDay(slot.cycleDay)) {
		throw new PolicySchemaError('cycleDay');
	}
	if (slot.thresholdBytes !== undefined && !isValidThresholdBytes(slot.thresholdBytes)) {
		throw new PolicySchemaError('thresholdBytes');
	}
	return {
		logicalSlotId: slot.logicalSlotId,
		...(slot.cycleDay !== undefined ? { cycleDay: slot.cycleDay } : {}),
		...(slot.thresholdBytes !== undefined ? { thresholdBytes: slot.thresholdBytes } : {}),
	};
}

/** Parse + validate the document. Throws `PolicySchemaError` (metadata-only). */
function validate(raw: unknown): PersistedUsagePolicy {
	if (typeof raw !== 'object' || raw === null) {
		throw new PolicySchemaError('document');
	}
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== USAGE_POLICY_SCHEMA_VERSION) {
		throw new PolicySchemaError('schemaVersion');
	}
	if (typeof doc.savedAtMs !== 'number' || !Number.isFinite(doc.savedAtMs)) {
		throw new PolicySchemaError('savedAtMs');
	}
	if (!Array.isArray(doc.slots)) {
		throw new PolicySchemaError('slots');
	}
	return {
		schemaVersion: USAGE_POLICY_SCHEMA_VERSION,
		savedAtMs: doc.savedAtMs,
		slots: doc.slots.map(validateSlot),
	};
}

/** Classify a load failure into a metadata-only reason string (no raw content). */
function classifyFailure(error: unknown): string {
	if (error instanceof PolicySchemaError) {
		return error.message;
	}
	if (error instanceof SyntaxError) {
		const offset = /position (\d+)/.exec(error.message)?.[1];
		return offset !== undefined ? `invalid-json at offset ${offset}` : 'invalid-json';
	}
	return 'unreadable';
}

/**
 * Read one slot's policy out of a loaded document.
 *
 * This is the read half the composition root uses to build each slot's
 * `UsageObservation.usage`, so the persisted file — not an in-memory guess — is
 * what the sampler accounts against. An unknown slot answers `{}`, i.e. "no
 * policy set", which is exactly what `defaultCellularPolicy` starts from.
 */
export function selectUsagePolicy(
	state: PersistedUsagePolicy,
	logicalSlotId: string,
): DesiredUsage {
	const slot = state.slots.find((entry) => entry.logicalSlotId === logicalSlotId);
	if (slot === undefined) {
		return {};
	}
	return {
		...(slot.cycleDay !== undefined ? { cycleDay: slot.cycleDay } : {}),
		...(slot.thresholdBytes !== undefined ? { thresholdBytes: slot.thresholdBytes } : {}),
	};
}

export function createUsagePolicyFileStore(options: UsagePolicyFileStoreOptions): UsagePolicyStore {
	const logger = options.logger ?? defaultLogger;
	const { path } = options;

	async function writeAtomic(state: PersistedUsagePolicy): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		await writeFile(tmp, JSON.stringify(state));
		// chmod AFTER the write (not an open flag) so mode is 0600 regardless of umask.
		await chmod(tmp, 0o600);
		await rename(tmp, path);
	}

	return {
		async load(nowMs: number): Promise<PersistedUsagePolicy> {
			let text: string;
			try {
				text = await readFile(path, 'utf8');
			} catch {
				// Absent (or unreadable) → start empty; the first save lays down a 0600 file.
				return freshState(nowMs);
			}
			try {
				return validate(JSON.parse(text));
			} catch (error) {
				logger({
					kind: 'corrupt-policy',
					bytes: Buffer.byteLength(text, 'utf8'),
					reason: classifyFailure(error),
				});
				const fresh = freshState(nowMs);
				await writeAtomic(fresh);
				return fresh;
			}
		},
		save: writeAtomic,
	};
}
