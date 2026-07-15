// The command seam the `certify` capture shells out through.
//
// `certify` reads `lsusb -v`, `usb-devices`, and `mmcli -K` — none of which have a
// D-Bus or library API, so they are captured by running the tool. Every run goes
// through `CommandRunner` rather than touching `Bun.spawn` directly, so the
// synthetic-fixture tests feed canned tool output with no real hardware (this is Phase
// A bench iteration — no real modem exists yet). The production `SpawnCommandRunner`
// runs the real binaries.

/** The result of running one capture command. */
export interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/** Runs a capture command and returns its output — the mockable capture seam. */
export interface CommandRunner {
	run(command: string, args: readonly string[]): Promise<CommandResult>;
}

/** The production runner: spawns the real binary and collects its output. */
export class SpawnCommandRunner implements CommandRunner {
	async run(command: string, args: readonly string[]): Promise<CommandResult> {
		const proc = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}
}
