import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import type {
	ResourceOwnershipHolder,
	ResourceOwnershipLease,
	ResourceOwnershipPort,
	ResourceOwnershipResult,
} from '../ports';

export type FlockResourceOwnershipOptions = {
	readonly lockPath: string;
	readonly flockBinary?: string;
};

export class FlockResourceOwnershipError extends Error {
	override readonly name = 'FlockResourceOwnershipError';

	constructor(readonly detail: string) {
		super(`flock ownership failed: ${detail}`);
	}
}

type ChildStart =
	| { readonly status: 'acquired'; readonly holder: ResourceOwnershipHolder }
	| { readonly status: 'closed'; readonly code: number | null; readonly stderr: string };

const STARTUP_DEADLINE_MS = 1_000;
const STARTUP_OUTPUT_LIMIT_BYTES = 64 * 1024;

export function createFlockResourceOwnershipPort(
	options: FlockResourceOwnershipOptions,
): ResourceOwnershipPort {
	return {
		async acquire(): Promise<ResourceOwnershipResult> {
			const child = spawn(
				options.flockBinary ?? 'flock',
				['--exclusive', '--nonblock', '--no-fork', options.lockPath, '/bin/cat'],
				{ stdio: ['pipe', 'pipe', 'pipe'] },
			);
			const closed = childClosed(child);
			if (child.pid === undefined) {
				await reapChild(child, closed);
				throw new FlockResourceOwnershipError('helper started without a process id');
			}
			const holder = { pid: child.pid, startedAtEpochMs: Date.now() };
			let started: ChildStart;
			try {
				started = await childStarted(child, options.lockPath, holder);
			} catch (error) {
				await reapChild(child, closed);
				throw error;
			}
			if (started.status === 'closed') {
				if (started.code === 1) {
					const holder = await readHolder(options.lockPath);
					return {
						status: 'refused',
						reason: 'already-owned',
						...(holder !== undefined && pidIsAlive(holder.pid) ? { holder } : {}),
					};
				}
				throw new FlockResourceOwnershipError(
					`helper exited ${started.code ?? 'by signal'}${started.stderr ? `: ${started.stderr}` : ''}`,
				);
			}

			return {
				status: 'acquired',
				lease: createLease(child, closed, started.holder),
			};
		},
	};
}

function createLease(
	child: ChildProcessWithoutNullStreams,
	closed: Promise<void>,
	holder: ResourceOwnershipHolder,
): ResourceOwnershipLease {
	let released = false;
	return {
		holder,
		lost: closed.then(() => ({ reason: 'holder-exited' }) as const),
		async release(): Promise<void> {
			if (released) return;
			released = true;
			if (child.exitCode === null && child.signalCode === null) {
				child.stdin.end();
			}
			await closed;
		},
	};
}

function childClosed(child: ChildProcessWithoutNullStreams): Promise<void> {
	return new Promise((resolve) => child.once('close', () => resolve()));
}

async function reapChild(
	child: ChildProcessWithoutNullStreams,
	closed: Promise<void>,
): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill('SIGKILL');
	}
	await closed;
}

function childStarted(
	child: ChildProcessWithoutNullStreams,
	lockPath: string,
	holder: ResourceOwnershipHolder,
): Promise<ChildStart> {
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let acknowledged = false;
		let settled = false;
		const startupDeadline = setTimeout(
			() => fail(new FlockResourceOwnershipError('helper startup deadline exceeded')),
			STARTUP_DEADLINE_MS,
		);
		const cleanup = (): void => {
			clearTimeout(startupDeadline);
			child.stdout.off('data', onStdout);
			child.stderr.off('data', onStderr);
			child.off('close', onClose);
			child.off('error', fail);
			child.stdin.off('error', fail);
		};
		const finish = (result: ChildStart): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onStderr = (chunk: Buffer): void => {
			stderrBytes += chunk.length;
			if (stderrBytes > STARTUP_OUTPUT_LIMIT_BYTES) {
				fail(new FlockResourceOwnershipError('helper startup output limit exceeded on stderr'));
				return;
			}
			stderr += chunk.toString('utf8');
		};
		const onStdout = (chunk: Buffer): void => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > STARTUP_OUTPUT_LIMIT_BYTES) {
				fail(new FlockResourceOwnershipError('helper startup output limit exceeded on stdout'));
				return;
			}
			stdout += chunk.toString('utf8');
			const newline = stdout.indexOf('\n');
			if (newline < 0) return;
			const acquired = parseAcquiredLine(stdout.slice(0, newline));
			if (acquired === undefined || acknowledged) return;
			acknowledged = true;
			void writeFile(lockPath, `${JSON.stringify(holder)}\n`, { mode: 0o600 }).then(
				() => finish({ status: 'acquired', holder }),
				fail,
			);
		};
		const onClose = (code: number | null): void =>
			finish({ status: 'closed', code, stderr: stderr.trim() });
		child.stderr.on('data', onStderr);
		child.stdout.on('data', onStdout);
		child.once('close', onClose);
		child.once('error', fail);
		child.stdin.once('error', fail);
		try {
			child.stdin.write(`${JSON.stringify({ type: 'acquired', holder })}\n`, (error) => {
				if (error !== null) fail(error);
			});
		} catch (error) {
			if (error instanceof Error) {
				fail(error);
				return;
			}
			fail(new FlockResourceOwnershipError('helper stdin failed with a non-error value'));
		}
	});
}

function parseAcquiredLine(line: string): ResourceOwnershipHolder | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== 'object' || parsed === null || !('holder' in parsed)) return undefined;
		return parseHolder(parsed.holder);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

async function readHolder(lockPath: string): Promise<ResourceOwnershipHolder | undefined> {
	try {
		return parseHolder(JSON.parse(await readFile(lockPath, 'utf8')));
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function parseHolder(value: unknown): ResourceOwnershipHolder | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	if (!('pid' in value) || !('startedAtEpochMs' in value)) return undefined;
	if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
		return undefined;
	}
	if (typeof value.startedAtEpochMs !== 'number' || !Number.isFinite(value.startedAtEpochMs)) {
		return undefined;
	}
	return { pid: value.pid, startedAtEpochMs: value.startedAtEpochMs };
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
		return true;
	}
}
