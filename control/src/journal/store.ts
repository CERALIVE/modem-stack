// The append-only journal store. THE PATH IS INJECTED AND HAS NO DEFAULT.
//
// This package never learns where a journal lives. The embedding process owns that
// decision because it owns the filesystem contract: on a CeraLive device the
// update-surviving partition is the right home, on a bench box a scratch directory
// is, and in a test a `mkdtemp` directory is. A default here would be a policy this
// library has no standing to set, and — worse — a default is what turns "the
// embedder forgot to configure it" into "we silently wrote somewhere plausible".
// `journal-path-injection.test.ts` fails the build if an absolute path literal ever
// appears in this directory's executable source.
//
// THREE PROPERTIES THIS STORE GUARANTEES, ALL LOAD-BEARING:
//
//  1. APPEND-ONLY. There is no verb here that rewrites or truncates the file.
//     A rewrite is the one operation that can lose a fact that was already
//     durable, and a journal that can lose a fact answers nothing after a crash.
//
//  2. A DAMAGED RECORD NEVER DISCARDS ITS NEIGHBOURS. `read()` decodes every line
//     independently and returns the survivors alongside a typed damage report.
//     Stopping at the first bad line — the natural thing a `for` loop with a throw
//     does — silently truncates the journal to its first corruption, which is
//     exactly the failure mode this store exists to make impossible.
//
//  3. A TORN TRAILING LINE IS CLOSED BEFORE THE NEXT APPEND. A process killed
//     mid-write leaves a final line with no terminator. Appending straight onto it
//     would glue the new entry to the garbage and corrupt a SECOND record — one
//     that was never in flight when the crash happened. The store probes the last
//     byte once and emits a leading terminator when the file does not end in one,
//     so the damage stays confined to the record that actually tore.

import { appendFile, chmod, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { decodeJournalEntry, encodeJournalEntry, type JournalDecodeFailure } from './codec';
import type { JournalEntry } from './entry';

const NEWLINE = 0x0a;

/** Default file mode. `0600` for the same reason the two policy stores use it. */
export const JOURNAL_FILE_MODE = 0o600;

/** Where a damaged record was found. Line-based, slot-based, or the whole file. */
export type JournalDamageLocation =
	| { readonly kind: 'line'; readonly line: number; readonly trailing: boolean }
	| { readonly kind: 'slot'; readonly slot: string }
	| { readonly kind: 'file' };

/** One record that could not be read, reported rather than dropped. */
export interface JournalDamageRecord {
	readonly location: JournalDamageLocation;
	readonly bytes: number;
	readonly failure: JournalDecodeFailure;
}

/** One decoded entry with the 1-based line it came from. */
export interface JournalLineRecord {
	readonly line: number;
	readonly entry: JournalEntry;
}

export interface JournalReadResult {
	readonly entries: readonly JournalLineRecord[];
	readonly damage: readonly JournalDamageRecord[];
}

export interface JournalStore {
	/** The injected path, echoed back so a caller can report where it recovered from. */
	readonly path: string;
	append(entry: JournalEntry): Promise<void>;
	read(): Promise<JournalReadResult>;
}

export interface FileJournalStoreOptions {
	/** REQUIRED. There is no default and no fallback. */
	readonly path: string;
	readonly mode?: number;
}

export class JournalPathError extends Error {
	override readonly name = 'JournalPathError';

	constructor() {
		super('journal path refused: an explicit, non-empty path must be injected');
	}
}

/**
 * Decode a whole journal document.
 *
 * Exported because the corruption fixtures assert against it directly — proving
 * the "survivors are kept" property without needing a filesystem to prove it.
 * Blank lines carry no record and are skipped rather than reported: a trailing
 * newline is how every line ends, so the final split member is always empty.
 */
export function decodeJournalText(text: string): JournalReadResult {
	const lines = text.split('\n');
	let lastPopulated = -1;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if ((lines[index] ?? '').trim().length > 0) {
			lastPopulated = index;
			break;
		}
	}

	const entries: JournalLineRecord[] = [];
	const damage: JournalDamageRecord[] = [];
	for (const [index, raw] of lines.entries()) {
		if (raw.trim().length === 0) continue;
		const decoded = decodeJournalEntry(raw);
		if (decoded.ok) {
			entries.push({ line: index + 1, entry: decoded.value });
			continue;
		}
		damage.push({
			location: { kind: 'line', line: index + 1, trailing: index === lastPopulated },
			bytes: Buffer.byteLength(raw, 'utf8'),
			failure: decoded.failure,
		});
	}
	return { entries, damage };
}

class FileJournalStore implements JournalStore {
	readonly path: string;
	readonly #mode: number;
	#tail: Promise<void> = Promise.resolve();
	/** Undefined until the first append probes the existing file's final byte. */
	#terminated: boolean | undefined;

	constructor(options: FileJournalStoreOptions) {
		if (typeof options.path !== 'string' || options.path.trim().length === 0) {
			throw new JournalPathError();
		}
		this.path = options.path;
		this.#mode = options.mode ?? JOURNAL_FILE_MODE;
	}

	append(entry: JournalEntry): Promise<void> {
		// Chained so two concurrent appends cannot interleave, and recovered from so
		// one failed append does not poison every later one with its rejection.
		const next = this.#tail.catch(() => undefined).then(() => this.#appendNow(entry));
		this.#tail = next.catch(() => undefined);
		return next;
	}

	async read(): Promise<JournalReadResult> {
		let text: string;
		try {
			text = await readFile(this.path, 'utf8');
		} catch (error) {
			// An ABSENT journal is an empty one — nothing was ever written. Anything
			// else (permissions, a directory in the way) is reported as damage: a
			// journal we could not open is not evidence that no mutation was pending.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { entries: [], damage: [] };
			}
			return {
				entries: [],
				damage: [{ location: { kind: 'file' }, bytes: 0, failure: { code: 'unreadable' } }],
			};
		}
		return decodeJournalText(text);
	}

	async #appendNow(entry: JournalEntry): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		this.#terminated ??= await this.#probeTerminated();
		const line = `${this.#terminated ? '' : '\n'}${encodeJournalEntry(entry)}\n`;
		await appendFile(this.path, line, { mode: this.#mode });
		// chmod AFTER the write, not as an open flag, so the mode holds regardless of
		// umask — the same reason the usage and FCC policy stores do it this way.
		await chmod(this.path, this.#mode);
		this.#terminated = true;
	}

	async #probeTerminated(): Promise<boolean> {
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(this.path, 'r');
		} catch {
			// No file yet: the first line starts the document, nothing to close.
			return true;
		}
		try {
			const { size } = await handle.stat();
			if (size === 0) return true;
			const tail = Buffer.alloc(1);
			await handle.read(tail, 0, 1, size - 1);
			return tail[0] === NEWLINE;
		} finally {
			await handle.close();
		}
	}
}

export function createFileJournalStore(options: FileJournalStoreOptions): JournalStore {
	return new FileJournalStore(options);
}
