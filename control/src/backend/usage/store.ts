// Versioned, fail-soft persistence for the usage sampler.
//
// The persisted file is a small JSON document carrying ONLY opaque slot ids,
// interface names, and numbers — never any subscriber/device identity (no ICCID,
// IMSI, IMEI, operator or model). By construction the sampler holds no such fields,
// and `no-pii.test.ts` proves the serialized bytes stay clean.
//
// Two hard guarantees:
//   - MODE 0600: the file is written to a temp path, chmod'd to 0600 AFTER the
//     write, then atomically renamed over the target — so the on-disk file always
//     ends up owner-read/write-only regardless of the process umask.
//   - FAIL-SOFT ON CORRUPTION: an unparseable/incompatible file is never fatal. We
//     log METADATA ONLY (byte length + a classification reason — never the raw,
//     possibly-sensitive content), recreate a fresh empty 0600 file, and carry on.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The current on-disk schema version. Bump when the persisted shape changes. */
export const USAGE_SCHEMA_VERSION = 1;

/** One slot's persisted accounting row — opaque ids and numbers only. */
export interface PersistedSlot {
	readonly logicalSlotId: string;
	readonly cycleBytes: number;
	readonly cycleStartMs: number;
	readonly mappingGeneration?: number;
	readonly ifname?: string;
	readonly lastObserved?: number;
}

/** The full persisted document. `bootId` scopes the baselines to one kernel session. */
export interface PersistedUsage {
	readonly schemaVersion: typeof USAGE_SCHEMA_VERSION;
	readonly bootId: string;
	readonly savedAtMs: number;
	readonly slots: readonly PersistedSlot[];
}

/** A metadata-only log event. Corruption NEVER carries the raw file content. */
export type UsageLogEvent = {
	readonly kind: 'corrupt-state';
	readonly bytes: number;
	readonly reason: string;
};

/** Sink for sampler log events. Defaults to a metadata-only `console.warn`. */
export type UsageLogger = (event: UsageLogEvent) => void;

/** The persistence seam the sampler drives. */
export interface UsageStore {
	/** Load persisted state; recreate a fresh 0600 file if absent or corrupt. */
	load(currentBootId: string, nowMs: number): Promise<PersistedUsage>;
	/** Atomically write state with mode 0600 (temp → chmod → rename). */
	save(state: PersistedUsage): Promise<void>;
}

export interface UsageFileStoreOptions {
	readonly path: string;
	readonly logger?: UsageLogger;
}

function defaultLogger(event: UsageLogEvent): void {
	console.warn(`[usage-sampler] ${event.kind}: bytes=${event.bytes} reason=${event.reason}`);
}

function freshState(bootId: string, nowMs: number): PersistedUsage {
	return { schemaVersion: USAGE_SCHEMA_VERSION, bootId, savedAtMs: nowMs, slots: [] };
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function validateSlot(raw: unknown): PersistedSlot {
	if (typeof raw !== 'object' || raw === null) {
		throw new SchemaError('slot');
	}
	const slot = raw as Record<string, unknown>;
	if (typeof slot.logicalSlotId !== 'string') {
		throw new SchemaError('logicalSlotId');
	}
	if (!isFiniteNumber(slot.cycleBytes) || !isFiniteNumber(slot.cycleStartMs)) {
		throw new SchemaError('cycleBytes|cycleStartMs');
	}
	return {
		logicalSlotId: slot.logicalSlotId,
		cycleBytes: slot.cycleBytes,
		cycleStartMs: slot.cycleStartMs,
		...(isFiniteNumber(slot.mappingGeneration)
			? { mappingGeneration: slot.mappingGeneration }
			: {}),
		...(typeof slot.ifname === 'string' ? { ifname: slot.ifname } : {}),
		...(isFiniteNumber(slot.lastObserved) ? { lastObserved: slot.lastObserved } : {}),
	};
}

/** Parse + validate the document. Throws `SchemaError` (metadata-only) on mismatch. */
function validate(raw: unknown): PersistedUsage {
	if (typeof raw !== 'object' || raw === null) {
		throw new SchemaError('document');
	}
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== USAGE_SCHEMA_VERSION) {
		throw new SchemaError('schemaVersion');
	}
	if (typeof doc.bootId !== 'string' || !isFiniteNumber(doc.savedAtMs)) {
		throw new SchemaError('bootId|savedAtMs');
	}
	if (!Array.isArray(doc.slots)) {
		throw new SchemaError('slots');
	}
	return {
		schemaVersion: USAGE_SCHEMA_VERSION,
		bootId: doc.bootId,
		savedAtMs: doc.savedAtMs,
		slots: doc.slots.map(validateSlot),
	};
}

/** A schema violation naming only the offending FIELD (never file content). */
class SchemaError extends Error {
	constructor(field: string) {
		super(`schema-mismatch: ${field}`);
	}
}

/** Classify a load failure into a metadata-only reason string (no raw content). */
function classifyFailure(error: unknown): string {
	if (error instanceof SchemaError) {
		return error.message;
	}
	if (error instanceof SyntaxError) {
		const offset = /position (\d+)/.exec(error.message)?.[1];
		return offset !== undefined ? `invalid-json at offset ${offset}` : 'invalid-json';
	}
	return 'unreadable';
}

export function createUsageFileStore(options: UsageFileStoreOptions): UsageStore {
	const logger = options.logger ?? defaultLogger;
	const { path } = options;

	async function writeAtomic(state: PersistedUsage): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		await writeFile(tmp, JSON.stringify(state));
		// chmod AFTER the write (not an open flag) so mode is 0600 regardless of umask.
		await chmod(tmp, 0o600);
		await rename(tmp, path);
	}

	return {
		async load(currentBootId: string, nowMs: number): Promise<PersistedUsage> {
			let text: string;
			try {
				text = await readFile(path, 'utf8');
			} catch {
				// Absent (or unreadable) → start empty; the first save lays down a 0600 file.
				return freshState(currentBootId, nowMs);
			}
			try {
				return validate(JSON.parse(text));
			} catch (error) {
				logger({
					kind: 'corrupt-state',
					bytes: Buffer.byteLength(text, 'utf8'),
					reason: classifyFailure(error),
				});
				const fresh = freshState(currentBootId, nowMs);
				await writeAtomic(fresh);
				return fresh;
			}
		},
		save: writeAtomic,
	};
}
