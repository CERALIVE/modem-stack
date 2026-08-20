import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type {
	ResourceOwnershipHolder,
	ResourceOwnershipLease,
	ResourceOwnershipPort,
	ResourceOwnershipResult,
} from '../ports';

const LOCK_HELPER = String.raw`
import { writeFileSync } from 'node:fs';
const lockPath = process.env.CERALIVE_MODEM_CONTROL_LOCK_PATH;
if (!lockPath) process.exit(64);
const holder = { pid: process.pid, startedAtEpochMs: Date.now() };
writeFileSync(lockPath, JSON.stringify(holder) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ type: 'acquired', holder }) + '\n');
process.stdin.resume();
`;

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

export function createFlockResourceOwnershipPort(
	options: FlockResourceOwnershipOptions,
): ResourceOwnershipPort {
	return {
		async acquire(): Promise<ResourceOwnershipResult> {
			const child = spawn(
				options.flockBinary ?? 'flock',
				[
					'--exclusive',
					'--nonblock',
					'--no-fork',
					options.lockPath,
					process.execPath,
					'-e',
					LOCK_HELPER,
				],
				{
					env: {
						...process.env,
						CERALIVE_MODEM_CONTROL_LOCK_PATH: options.lockPath,
					},
					stdio: ['pipe', 'pipe', 'pipe'],
				},
			);
			const closed = childClosed(child);
			const started = await childStarted(child);
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

function childStarted(child: ChildProcessWithoutNullStreams): Promise<ChildStart> {
	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (result: ChildStart): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
			const newline = stdout.indexOf('\n');
			if (newline < 0) return;
			const holder = parseAcquiredLine(stdout.slice(0, newline));
			if (holder !== undefined) finish({ status: 'acquired', holder });
		});
		child.once('close', (code) => finish({ status: 'closed', code, stderr: stderr.trim() }));
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
