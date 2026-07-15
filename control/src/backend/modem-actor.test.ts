// The shared per-modem disruptive actor — pure, deterministic serialization proof.
//
// Same stable key ⇒ strict serialization (no interleave); different keys ⇒
// independent (overlap); a rejected task never stalls the queue; and a quiesce lease
// is always acquired around and released after a runQuiesced task, even on throw.

import { describe, expect, test } from 'bun:test';
import {
	ModemActor,
	type QuiesceHook,
	type QuiesceLeaseHandle,
	type QuiesceTarget,
} from './modem-actor';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const worker = (log: string[], name: string) => async (): Promise<void> => {
	log.push(`${name}:start`);
	await sleep(15);
	log.push(`${name}:end`);
};

describe('ModemActor — per-key serialization', () => {
	test('two tasks on the SAME key run strictly in order, never interleaved', async () => {
		const actor = new ModemActor();
		const log: string[] = [];
		await Promise.all([
			actor.run('slot:a', worker(log, 'a')),
			actor.run('slot:a', worker(log, 'b')),
		]);
		expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
	});

	test('tasks on DIFFERENT keys run independently (they overlap)', async () => {
		const actor = new ModemActor();
		const log: string[] = [];
		await Promise.all([
			actor.run('slot:a', worker(log, 'a')),
			actor.run('slot:b', worker(log, 'b')),
		]);
		const lastStart = Math.max(log.indexOf('a:start'), log.indexOf('b:start'));
		const firstEnd = Math.min(log.indexOf('a:end'), log.indexOf('b:end'));
		// Both started before either finished → the two keys did not serialize.
		expect(lastStart).toBeLessThan(firstEnd);
	});

	test('a rejected task does not stall the queue', async () => {
		const actor = new ModemActor();
		await expect(actor.run('slot:a', () => Promise.reject(new Error('boom')))).rejects.toThrow(
			'boom',
		);
		await expect(actor.run('slot:a', () => Promise.resolve('ok'))).resolves.toBe('ok');
	});

	test('an idle key drops its queue entry (bounded map)', async () => {
		const actor = new ModemActor();
		await actor.run('slot:a', () => Promise.resolve(1));
		await sleep(0);
		expect(actor.activeKeyCount).toBe(0);
	});
});

describe('ModemActor — quiesce lease', () => {
	function recordingHook(events: string[]): QuiesceHook {
		return {
			acquire(target: QuiesceTarget): Promise<QuiesceLeaseHandle> {
				events.push(`acquire:${target.stableKey}`);
				return Promise.resolve({
					release(): Promise<void> {
						events.push('release');
						return Promise.resolve();
					},
				});
			},
		};
	}

	test('runQuiesced acquires before, releases after the task', async () => {
		const events: string[] = [];
		const actor = new ModemActor(recordingHook(events));
		await actor.runQuiesced({ stableKey: 'slot:a' }, async () => {
			events.push('task');
		});
		expect(events).toEqual(['acquire:slot:a', 'task', 'release']);
	});

	test('the lease is released even when the task throws', async () => {
		const events: string[] = [];
		const actor = new ModemActor(recordingHook(events));
		await expect(
			actor.runQuiesced({ stableKey: 'slot:a' }, () => Promise.reject(new Error('x'))),
		).rejects.toThrow('x');
		expect(events).toEqual(['acquire:slot:a', 'release']);
	});
});
