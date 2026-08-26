import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

/**
 * The generic UFI admin password is EPHEMERAL BENCH INPUT, exactly like the MF79U's:
 * injected through `UFI_BENCH_PASSWORD` for one supervised bench run, never committed,
 * never logged, never echoed into evidence. This scan is what keeps that true — it
 * walks tracked AND intended-untracked files for the password and for the two
 * derivatives a careless capture would leave behind.
 */
function candidateSecret(): string {
	return process.env.UFI_BENCH_PASSWORD ?? ['ceralive', 'ufi', 'himi', 'secret', 'scan'].join('-');
}

describe('UFI bench credential fence', () => {
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
		// Scanned 605 files before adding this count floor.
		expect(files.length).toBeGreaterThanOrEqual(605);
		const leaks: string[] = [];
		for (const file of files) {
			const content = await Bun.file(file).text();
			if (forbidden.some((value) => value.length > 0 && content.includes(value))) leaks.push(file);
		}

		// Then
		expect(leaks).toEqual([]);
	});
});
