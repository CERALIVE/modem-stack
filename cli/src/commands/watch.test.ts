import { afterEach, expect, test } from 'bun:test';
import type { StackContext } from '../context';
import { capturingIo } from '../io';
import { runWatch } from './watch';

type Observer = (list: never) => void;

const context = (
	start: () => Promise<void>,
	observer: (callback: Observer) => () => void,
): StackContext => ({ backend: { start, observe: observer } }) as unknown as StackContext;

const baseline = (): number => process.listenerCount('SIGINT');

afterEach(() => {
	expect(process.listenerCount('SIGINT')).toBe(0);
});

test('start rejection cleans every watch handle', async () => {
	const before = baseline();
	const failure = new Error('start failed');
	const promise = runWatch(
		context(
			async () => {
				throw failure;
			},
			() => () => undefined,
		),
		capturingIo(),
		{ durationMs: 60_000 },
	);

	await expect(promise).rejects.toBe(failure);
	expect(process.listenerCount('SIGINT')).toBe(before);
});

test('observer callback failure cleans every watch handle', async () => {
	const before = baseline();
	const failure = new Error('observer failed');
	let callback: Observer | undefined;
	const promise = runWatch(
		context(
			async () => {
				callback?.(undefined as never);
			},
			(_next) => {
				callback = () => {
					throw failure;
				};
				return () => undefined;
			},
		),
		capturingIo(),
		{ durationMs: 60_000 },
	);

	await expect(promise).rejects.toThrow(failure.message);
	expect(process.listenerCount('SIGINT')).toBe(before);
});

test('abort during pending start still removes SIGINT and timer handles', async () => {
	const before = baseline();
	const controller = new AbortController();
	let releaseStart: (() => void) | undefined;
	const promise = runWatch(
		context(
			() =>
				new Promise<void>((resolve) => {
					releaseStart = resolve;
				}),
			() => () => undefined,
		),
		capturingIo(),
		{ signal: controller.signal, durationMs: 60_000 },
	);

	controller.abort();
	releaseStart?.();
	expect(await promise).toBe(0);
	expect(process.listenerCount('SIGINT')).toBe(before);
});
