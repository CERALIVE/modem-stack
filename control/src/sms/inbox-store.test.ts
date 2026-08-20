// The two failures a signal-driven inbox produces on its own: a duplicated
// message, and an inbox that doubles after a source restart.

import { describe, expect, test } from 'bun:test';
import type { SmsMessage } from '../ports/sms';
import { createSmsInboxStore } from './inbox-store';

const message = (id: string, over: Partial<SmsMessage> = {}): SmsMessage => ({
	id,
	text: `body ${id}`,
	state: 'received',
	timestamp: `2025-08-2${id.length}T10:0${id.at(-1)}:00-05`,
	...over,
});

describe('duplicate suppression', () => {
	test('a repeated Added for an identical row changes nothing', () => {
		const store = createSmsInboxStore();
		expect(store.apply({ kind: 'added', message: message('1') })).toBe(true);
		expect(store.apply({ kind: 'added', message: message('1') })).toBe(false);
		expect(store.size()).toBe(1);
		expect(store.snapshot()).toHaveLength(1);
	});

	test('MM emits Added twice for one arrival (receiving, then received)', () => {
		// The real duplicate on the wire is not byte-identical: MM announces the
		// message while it is still receiving, then again once it is stored. The
		// row must UPDATE rather than accumulate.
		const store = createSmsInboxStore();
		store.apply({ kind: 'added', message: message('7', { state: 'receiving', text: '' }) });
		expect(store.apply({ kind: 'added', message: message('7') })).toBe(true);
		expect(store.size()).toBe(1);
		expect(store.snapshot()[0]?.state).toBe('received');
	});

	test('a Deleted for a row we never held is not a change', () => {
		const store = createSmsInboxStore();
		expect(store.apply({ kind: 'deleted', id: '404' })).toBe(false);
	});

	test('a Deleted retires the row', () => {
		const store = createSmsInboxStore();
		store.apply({ kind: 'added', message: message('1') });
		expect(store.apply({ kind: 'deleted', id: '1' })).toBe(true);
		expect(store.snapshot()).toEqual([]);
	});
});

describe('restart recovery', () => {
	test('a resync REPLACES the rows — a re-list never doubles the inbox', () => {
		const store = createSmsInboxStore();
		store.apply({ kind: 'added', message: message('1') });
		store.apply({ kind: 'added', message: message('2') });

		// The source came back and re-listed the SAME two messages.
		expect(store.apply({ kind: 'resynced', messages: [message('1'), message('2')] })).toBe(false);
		expect(store.size()).toBe(2);
		expect(
			store
				.snapshot()
				.map((entry) => entry.id)
				.sort(),
		).toEqual(['1', '2']);
	});

	test('a message deleted while the source was down is dropped, not kept', () => {
		// This is why a resync may not be folded as a series of Added events:
		// nothing would ever retire row 2.
		const store = createSmsInboxStore();
		store.apply({ kind: 'resynced', messages: [message('1'), message('2')] });
		expect(store.apply({ kind: 'resynced', messages: [message('1')] })).toBe(true);
		expect(store.snapshot().map((entry) => entry.id)).toEqual(['1']);
	});

	test('a message that ARRIVED while the source was down appears once', () => {
		const store = createSmsInboxStore();
		store.apply({ kind: 'added', message: message('1') });
		store.apply({ kind: 'resynced', messages: [message('1'), message('2')] });
		store.apply({ kind: 'added', message: message('2') });
		expect(store.size()).toBe(2);
	});

	test('an empty resync clears an inbox the operator emptied elsewhere', () => {
		const store = createSmsInboxStore();
		store.apply({ kind: 'added', message: message('1') });
		expect(store.apply({ kind: 'resynced', messages: [] })).toBe(true);
		expect(store.snapshot()).toEqual([]);
	});
});

describe('the snapshot obeys the shared ordering + cap', () => {
	test('newest first and capped', () => {
		const store = createSmsInboxStore(2);
		store.apply({ kind: 'added', message: message('1', { timestamp: '2025-08-21T10:00:00-05' }) });
		store.apply({ kind: 'added', message: message('2', { timestamp: '2025-08-23T10:00:00-05' }) });
		store.apply({ kind: 'added', message: message('3', { timestamp: '2025-08-22T10:00:00-05' }) });
		expect(store.snapshot().map((entry) => entry.id)).toEqual(['2', '3']);
		expect(store.size()).toBe(3);
	});
});
