import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

function candidateSecret(): string {
	return process.env.MF79U_BENCH_PASSWORD ?? ['ceralive', 'mf79u', 'secret', 'scan'].join('-');
}

describe('MF79U credential fence', () => {
	test('keeps the ephemeral password and its derivatives out of tracked or intended files', async () => {
		// Given
		const password = candidateSecret();
		const forbidden = [
			password,
			Buffer.from(password).toString('base64'),
			createHash('sha256').update(password).digest('hex'),
		];
		const tracked = Bun.spawn(
			['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
			{ stdout: 'pipe', stderr: 'pipe' },
		);

		// When
		const [exitCode, names] = await Promise.all([
			tracked.exited,
			new Response(tracked.stdout).text(),
		]);
		expect(exitCode).toBe(0);
		const files = names.split('\0').filter((name) => name.length > 0);
		const leaks: string[] = [];
		for (const file of files) {
			const content = await Bun.file(file).text();
			if (forbidden.some((value) => value.length > 0 && content.includes(value))) leaks.push(file);
		}

		// Then
		expect(leaks).toEqual([]);
	});
});
