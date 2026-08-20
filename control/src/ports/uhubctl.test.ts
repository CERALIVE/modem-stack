import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('Given the control package, When its source is inspected, Then no concrete uhubctl invocation ships', async () => {
	const backend = join(import.meta.dir, '..', 'backend');
	const files = (await readdir(backend)).filter((name) => name.endsWith('.ts'));
	const forbidden = ['create', 'Uhubctl', 'PowerHook'].join('');
	const spawn = ['Spawn', 'Uhubctl', 'Runner'].join('');
	for (const file of files) {
		const source = await readFile(join(backend, file), 'utf8');
		expect(source.includes(forbidden)).toBeFalse();
		expect(source.includes(spawn)).toBeFalse();
	}
});
