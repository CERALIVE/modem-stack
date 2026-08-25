import { afterEach, describe, expect, test } from 'bun:test';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlockResourceOwnershipPort } from './flock-resource-ownership';

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

async function helperPid(pidPath: string): Promise<number> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		try {
			return Number.parseInt((await readFile(pidPath, 'utf8')).trim(), 10);
		} catch (error) {
			if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
				throw error;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('helper did not record its process id');
}

async function expectHelperReaped(pid: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`helper ${pid} was not reaped`);
}

async function writeFlockHelper(
	directory: string,
	name: string,
	body: string,
): Promise<{ readonly flockBinary: string; readonly pidPath: string }> {
	const flockBinary = join(directory, name);
	const pidPath = join(directory, `${name}.pid`);
	await writeFile(flockBinary, `#!/bin/sh\necho $$ > ${pidPath}\n${body}\n`, { mode: 0o755 });
	await chmod(flockBinary, 0o755);
	return { flockBinary, pidPath };
}

function acquisitionFailure(acquisition: Promise<unknown>): Promise<Error> {
	return acquisition.then(
		() => new Error('expected acquisition to reject'),
		(error: unknown) =>
			error instanceof Error ? error : new Error('acquisition rejected with a non-error value'),
	);
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
	test('Given a flock wrapper that rejects evaluator arguments, When ownership is acquired, Then the adapter uses a passive holder', async () => {
		const path = await lockPath();
		const fakeFlock = join(path, '..', 'fake-flock');
		await writeFile(
			fakeFlock,
			'#!/bin/sh\nfor argument in "$@"; do\n  if [ "$argument" = "-e" ]; then exit 1; fi\ndone\ncat\n',
		);
		await chmod(fakeFlock, 0o755);

		const result = await createFlockResourceOwnershipPort({
			lockPath: path,
			flockBinary: fakeFlock,
		}).acquire({ resource: 'usb-hub' });

		expect(result.status).toBe('acquired');
		if (result.status === 'acquired') await result.lease.release();
	});

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

	test('Given a holder-file write failure, When the helper stays alive, Then acquisition rejects and reaps the helper', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'modem-control-flock-write-failure-'));
		tempPaths.push(directory);
		const { flockBinary, pidPath } = await writeFlockHelper(
			directory,
			'write-failure-flock',
			'fifo="$0.fifo"\nmkfifo "$fifo"\nIFS= read -r line\nprintf \'%s\\n\' "$line"\nexec /bin/cat "$fifo"',
		);

		const acquisition = createFlockResourceOwnershipPort({
			lockPath: directory,
			flockBinary,
		}).acquire({ resource: 'usb-hub' });
		const failed = acquisitionFailure(acquisition);
		const pid = await helperPid(pidPath);

		expect((await failed).message).toContain('EISDIR');
		await expectHelperReaped(pid);
	});

	test('Given a helper that never acknowledges the pipe round-trip, When startup reaches its deadline, Then acquisition rejects and reaps the helper', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'modem-control-flock-hang-'));
		tempPaths.push(directory);
		const { flockBinary, pidPath } = await writeFlockHelper(
			directory,
			'hanging-flock',
			'fifo="$0.fifo"\nmkfifo "$fifo"\nexec /bin/cat "$fifo"',
		);

		const acquisition = createFlockResourceOwnershipPort({
			lockPath: join(directory, 'ownership.lock'),
			flockBinary,
		}).acquire({ resource: 'usb-hub' });
		const failed = acquisitionFailure(acquisition);
		const pid = await helperPid(pidPath);

		expect((await failed).message).toContain('startup deadline');
		await expectHelperReaped(pid);
	});

	test('Given a helper that floods startup stdout, When output exceeds 64 KiB, Then acquisition rejects and reaps the helper', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'modem-control-flock-flood-'));
		tempPaths.push(directory);
		const { flockBinary, pidPath } = await writeFlockHelper(
			directory,
			'flooding-flock',
			'fifo="$0.fifo"\nmkfifo "$fifo"\nhead -c 65537 /dev/zero | tr \'\\000\' x\nexec /bin/cat "$fifo"',
		);

		const acquisition = createFlockResourceOwnershipPort({
			lockPath: join(directory, 'ownership.lock'),
			flockBinary,
		}).acquire({ resource: 'usb-hub' });
		const failed = acquisitionFailure(acquisition);
		const pid = await helperPid(pidPath);

		expect((await failed).message).toContain('startup output limit');
		await expectHelperReaped(pid);
	});
});
