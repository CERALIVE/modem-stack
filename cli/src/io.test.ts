import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { stdioIo } from './io';

test('EOF before newline removes the stdin data listener', async () => {
	const original = process.stdin;
	const stdin = new PassThrough();
	Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
	try {
		const reading = stdioIo().promptSecret('');
		stdin.end('partial');
		expect(await reading).toBe('partial');
		expect(stdin.listenerCount('data')).toBe(0);
	} finally {
		Object.defineProperty(process, 'stdin', { configurable: true, value: original });
	}
});
