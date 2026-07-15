// The nmcli invocation seam. The shipping adapter spawns the real `nmcli`; tests
// inject A2.3's stateful in-memory runner (structurally the same `run(argv)`). The
// port never spawns directly — it only ever talks to an injected `NmcliRunner`, so
// the exact code path exercised under test is the one that runs on-device.

export interface NmcliResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/**
 * A runner over nmcli argv. `run` may be synchronous (the stateful test double) or
 * asynchronous (the real `Bun.spawn` adapter) — the port awaits either way.
 */
export interface NmcliRunner {
	run(argv: readonly string[]): NmcliResult | Promise<NmcliResult>;
}

/** Await a runner's result whether it returned synchronously or as a promise. */
export async function runNmcli(runner: NmcliRunner, argv: readonly string[]): Promise<NmcliResult> {
	return runner.run(argv);
}

/**
 * The device-exact runner: spawns the real `nmcli` via Bun. Every argv the port
 * builds is passed verbatim, so what the tests assert against the stateful stub is
 * byte-for-byte what runs on the device.
 */
export class SpawnNmcliRunner implements NmcliRunner {
	async run(argv: readonly string[]): Promise<NmcliResult> {
		const proc = Bun.spawn(['nmcli', ...argv], { stdout: 'pipe', stderr: 'pipe' });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}
}

/** Parse nmcli terse (`-t`) `key:value` lines into a map, splitting on the first `:`. */
export function parseTerse(stdout: string): Map<string, string> {
	const settings = new Map<string, string>();
	for (const line of stdout.split('\n')) {
		const separator = line.indexOf(':');
		if (separator >= 0) {
			settings.set(line.slice(0, separator), line.slice(separator + 1));
		}
	}
	return settings;
}
