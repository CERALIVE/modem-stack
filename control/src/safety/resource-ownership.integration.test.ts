import { afterEach, describe, expect, test } from 'bun:test';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type RootMessage =
	| { readonly type: 'acquired'; readonly holderPid: number }
	| { readonly type: 'refused'; readonly reason: 'already-owned'; readonly holderPid?: number }
	| { readonly type: 'expired' }
	| { readonly type: 'released' };

const children: ChildProcessWithoutNullStreams[] = [];
const tempPaths: string[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.stdin.end('release\n');
			await new Promise<void>((resolve) => child.once('exit', () => resolve()));
		}
	}
	for (const path of tempPaths.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

async function lockPath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'modem-control-lock-'));
	tempPaths.push(directory);
	return join(directory, 'ownership.lock');
}

function spawnRoot(path: string): ChildProcessWithoutNullStreams {
	const child = spawn(process.execPath, ['control/test-support/ownership-root-fixture.ts', path], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	children.push(child);
	return child;
}

function nextMessage(child: ChildProcessWithoutNullStreams): Promise<RootMessage> {
	return new Promise((resolve, reject) => {
		let buffer = '';
		const onData = (chunk: Buffer): void => {
			buffer += chunk.toString('utf8');
			const newline = buffer.indexOf('\n');
			if (newline < 0) return;
			cleanup();
			resolve(JSON.parse(buffer.slice(0, newline)) as RootMessage);
		};
		const onExit = (code: number | null): void => {
			cleanup();
			reject(new Error(`ownership fixture exited before a message (code ${code})`));
		};
		const cleanup = (): void => {
			child.stdout.off('data', onData);
			child.off('exit', onExit);
		};
		child.stdout.on('data', onData);
		child.once('exit', onExit);
	});
}

describe('flock resource ownership across composition roots', () => {
	test('Given two roots and one lock path, When both acquire, Then exactly one acquires and one refuses without queueing', async () => {
		const path = await lockPath();
		const roots = [spawnRoot(path), spawnRoot(path)];
		const results = await Promise.all(roots.map(nextMessage));

		expect(results.filter((result) => result.type === 'acquired')).toHaveLength(1);
		expect(results.filter((result) => result.type === 'refused')).toHaveLength(1);
	});

	test('Given a live holder, When its lock process is killed, Then no successor steals before PID expiry and one acquires after expiry', async () => {
		const path = await lockPath();
		const holderRoot = spawnRoot(path);
		const acquired = await nextMessage(holderRoot);
		expect(acquired.type).toBe('acquired');
		if (acquired.type !== 'acquired') return;

		const liveContender = spawnRoot(path);
		expect(await nextMessage(liveContender)).toMatchObject({
			type: 'refused',
			reason: 'already-owned',
			holderPid: acquired.holderPid,
		});

		process.kill(acquired.holderPid, 'SIGKILL');
		expect(await nextMessage(holderRoot)).toEqual({ type: 'expired' });

		const successor = spawnRoot(path);
		expect(await nextMessage(successor)).toMatchObject({ type: 'acquired' });
	});
});
