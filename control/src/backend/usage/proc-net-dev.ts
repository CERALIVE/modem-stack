// Our own `/proc/net/dev` parser over the kernel's CUMULATIVE byte counters.
//
// `/proc/net/dev` is a fixed-format text file: two header lines, then one row per
// interface. Each row is `<ifname>: <16 numeric columns>` — the first 8 are the
// Receive block (bytes packets errs drop fifo frame compressed multicast) and the
// next 8 are the Transmit block in the same order. We read the ever-increasing
// rx-bytes (column 0) + tx-bytes (column 8) as ONE cumulative total per interface.
//
// This is deliberately NOT a rate/bitrate signal: it is the raw monotonic kernel
// counter (it only decreases on a counter reset / interface re-creation, which the
// accounting layer clamps). We parse the proc text ourselves rather than shelling
// out to `ip`/`ifconfig` because the raw file is the most reliable, consistent
// source and matches exactly what the plan names.

/** A source of cumulative rx+tx byte counters keyed by interface name. */
export interface CounterSource {
	/** Read the current cumulative rx+tx byte total for every interface. */
	read(): Promise<ReadonlyMap<string, number>>;
}

const HEADER_LINE_COUNT = 2;
const RX_BYTES_COLUMN = 0;
const TX_BYTES_COLUMN = 8;
const MIN_COLUMNS = TX_BYTES_COLUMN + 1;

/**
 * Parse `/proc/net/dev` text into a map of interface name → cumulative rx+tx bytes.
 * The two-line header is skipped; malformed or short rows are ignored rather than
 * throwing, so a single odd line can never break sampling.
 */
export function parseProcNetDev(text: string): Map<string, number> {
	const counters = new Map<string, number>();
	const lines = text.split('\n').slice(HEADER_LINE_COUNT);
	for (const line of lines) {
		const colon = line.indexOf(':');
		if (colon < 0) {
			continue;
		}
		const ifname = line.slice(0, colon).trim();
		if (ifname.length === 0) {
			continue;
		}
		const columns = line
			.slice(colon + 1)
			.trim()
			.split(/\s+/);
		if (columns.length < MIN_COLUMNS) {
			continue;
		}
		const rx = Number(columns[RX_BYTES_COLUMN]);
		const tx = Number(columns[TX_BYTES_COLUMN]);
		if (!Number.isFinite(rx) || !Number.isFinite(tx) || rx < 0 || tx < 0) {
			continue;
		}
		counters.set(ifname, rx + tx);
	}
	return counters;
}

/**
 * The production counter source: reads and parses the real `/proc/net/dev`. The
 * path is injectable so tests can point at a fixture, but the default is the live
 * kernel file. A missing/unreadable file yields an empty map (fail-soft — a read
 * error never crashes the sampler; that pass simply attributes no new bytes).
 */
export function procNetDevCounterSource(path = '/proc/net/dev'): CounterSource {
	return {
		async read(): Promise<ReadonlyMap<string, number>> {
			try {
				const text = await Bun.file(path).text();
				return parseProcNetDev(text);
			} catch {
				return new Map();
			}
		},
	};
}
