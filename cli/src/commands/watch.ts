// `modem-control watch` — a live event stream over the epoch-scoped observer.
//
// It subscribes BEFORE `start()` (the observer does not replay on subscribe), then
// prints each authoritative change as it happens. The safety-critical distinction the
// stream makes visible is the A3.1 epoch-authority one: a bus drop or MM restart marks
// modems `SOURCE-UNAVAILABLE` with their rows RETAINED (never a removal), whereas a real
// removal is an omission from a live snapshot and prints `REMOVED`. It exits after a
// bounded `--duration`/`--events` (for CI), or on Ctrl-C.

import type { StackContext } from '../context';
import type { CliIo } from '../io';

/** Bounded-run options so the stream terminates in CI. */
export interface WatchOptions {
	/** Stop after this many milliseconds. */
	readonly durationMs?: number;
	/** Stop after this many change events. */
	readonly events?: number;
	/** Stop when this signal aborts (SIGINT wiring, deterministic test teardown). */
	readonly signal?: AbortSignal;
}

/** Tallies printed at exit, and asserted by the smoke. */
export interface WatchSummary {
	readonly events: number;
	readonly unavailable: number;
	readonly removed: number;
}

/** Stream observation changes to `io` until the bound is reached. Returns an exit code. */
export async function runWatch(
	ctx: StackContext,
	io: CliIo,
	options: WatchOptions,
): Promise<number> {
	let events = 0;
	let unavailable = 0;
	let removed = 0;
	let previous = new Map<string, string>();

	let resolveDone: () => void = () => undefined;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});

	const unsubscribe = ctx.backend.observe((list) => {
		const current = new Map<string, string>();
		for (const row of list.rows) {
			current.set(String(row.identity.runtimePath), row.sourceHealth);
		}
		for (const [path, health] of current) {
			const before = previous.get(path);
			if (before === undefined) {
				io.out(`+ ADDED ${path} health=${health}`);
				events += 1;
			} else if (before !== health) {
				io.out(`~ CHANGED ${path} health=${health}`);
				events += 1;
			}
		}
		// A removal is ONLY an omission from a live authoritative snapshot — a retained
		// row on an `ok:false` list is NOT a removal (epoch authority, A3.1).
		for (const path of previous.keys()) {
			if (!current.has(path)) {
				io.out(`- REMOVED ${path}`);
				events += 1;
				removed += 1;
			}
		}
		if (!list.ok) {
			io.out(`! SOURCE-UNAVAILABLE reason=${list.reason} retained=${list.rows.length}`);
			unavailable += 1;
		}
		previous = current;
		if (options.events !== undefined && events >= options.events) {
			resolveDone();
		}
	});

	const timer =
		options.durationMs !== undefined
			? setTimeout(() => resolveDone(), options.durationMs)
			: undefined;
	const onSigint = (): void => resolveDone();
	const onAbort = (): void => resolveDone();
	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		if (timer !== undefined) clearTimeout(timer);
		process.off('SIGINT', onSigint);
		options.signal?.removeEventListener('abort', onAbort);
		unsubscribe();
	};
	process.on('SIGINT', onSigint);
	if (options.signal !== undefined) {
		if (options.signal.aborted) {
			resolveDone();
		} else {
			options.signal.addEventListener('abort', onAbort, { once: true });
		}
	}
	if (
		options.durationMs === undefined &&
		options.events === undefined &&
		options.signal === undefined
	) {
		io.err('watch: streaming changes — press Ctrl-C to stop');
	}

	try {
		await ctx.backend.start();
		await done;
	} finally {
		cleanup();
	}
	io.out(`WATCH DONE: events=${events}, unavailable=${unavailable}, removed=${removed}`);
	return 0;
}
