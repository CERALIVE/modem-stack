// Terminal I/O seam for the bench CLI.
//
// Every command writes through a `CliIo` rather than touching `console` / `stdin`
// directly, so harness-driven tests capture output and feed canned secrets without a
// real TTY. The production `stdioIo()` writes to stdout/stderr and reads PIN / PUK
// secrets with terminal echo DISABLED — the secret is never rendered back to the
// screen (a hard requirement: redacted prompts).

/** The output + prompt surface every command depends on. */
export interface CliIo {
	/** Write a line to standard output. */
	out(line: string): void;
	/** Write a line to standard error (diagnostics, prompts). */
	err(line: string): void;
	/**
	 * Prompt for a SECRET (PIN / PUK) with NO terminal echo. The typed characters
	 * are never shown and the secret is never written back to any stream.
	 */
	promptSecret(label: string): Promise<string>;
}

/** Read one line from stdin with echo suppressed on an interactive TTY. */
async function readSecret(label: string): Promise<string> {
	process.stderr.write(label);
	const stdin = process.stdin;
	const isTty = Boolean((stdin as { isTTY?: boolean }).isTTY);
	if (!isTty) {
		// Non-interactive (piped) stdin: read a line as-is — nothing is echoed anyway.
		const line = await readLine(stdin);
		process.stderr.write('\n');
		return line;
	}
	const setRawMode = (stdin as { setRawMode?: (mode: boolean) => void }).setRawMode;
	setRawMode?.call(stdin, true);
	try {
		return await new Promise<string>((resolve, reject) => {
			let secret = '';
			const onData = (chunk: Buffer): void => {
				for (const byte of chunk) {
					if (byte === 0x03) {
						cleanup();
						reject(new Error('aborted'));
						return;
					}
					if (byte === 0x0d || byte === 0x0a) {
						cleanup();
						resolve(secret);
						return;
					}
					if (byte === 0x7f || byte === 0x08) {
						secret = secret.slice(0, -1);
						continue;
					}
					secret += String.fromCharCode(byte);
				}
			};
			const cleanup = (): void => {
				stdin.off('data', onData);
				setRawMode?.call(stdin, false);
				process.stderr.write('\n');
			};
			stdin.on('data', onData);
		});
	} finally {
		setRawMode?.call(stdin, false);
	}
}

/** Read a single newline-terminated line from a stream (non-TTY path). */
function readLine(stdin: NodeJS.ReadStream): Promise<string> {
	return new Promise<string>((resolve) => {
		let buffer = '';
		const onData = (chunk: Buffer): void => {
			buffer += chunk.toString('utf8');
			const newline = buffer.indexOf('\n');
			if (newline >= 0) {
				stdin.off('data', onData);
				resolve(buffer.slice(0, newline).replace(/\r$/, ''));
			}
		};
		stdin.on('data', onData);
		stdin.on('end', () => {
			stdin.off('data', onData);
			resolve(buffer.replace(/\r$/, ''));
		});
	});
}

/** The production I/O: stdout / stderr + a no-echo secret prompt. */
export function stdioIo(): CliIo {
	return {
		out(line: string): void {
			process.stdout.write(`${line}\n`);
		},
		err(line: string): void {
			process.stderr.write(`${line}\n`);
		},
		promptSecret(label: string): Promise<string> {
			return readSecret(label);
		},
	};
}

/** A buffered I/O for tests: captures output and returns queued secrets. */
export interface CapturingIo extends CliIo {
	readonly stdout: string[];
	readonly stderr: string[];
}

/** Create a capturing I/O that yields `secrets` in order from `promptSecret`. */
export function capturingIo(secrets: readonly string[] = []): CapturingIo {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const queue = [...secrets];
	return {
		stdout,
		stderr,
		out(line: string): void {
			stdout.push(line);
		},
		err(line: string): void {
			stderr.push(line);
		},
		promptSecret(): Promise<string> {
			return Promise.resolve(queue.shift() ?? '');
		},
	};
}
