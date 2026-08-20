import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN =
	/(?:Bun\.spawn|child_process|execFile|spawn)\s*\([^\n]*(?:mmcli|qmicli|mbimcli)|(?:mmcli|qmicli|mbimcli)["'`]/i;

function productionSources(dir: string): string[] {
	const paths: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			paths.push(...productionSources(path));
		} else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
			paths.push(path);
		}
	}
	return paths;
}

describe('ModemManagerProvider subprocess fence', () => {
	test('the detector is non-vacuous for every forbidden diagnostic binary', () => {
		for (const binary of ['mmcli', 'qmicli', 'mbimcli']) {
			expect(FORBIDDEN.test(`Bun.spawn(["${binary}", "--help"])`)).toBe(true);
		}
	});

	test('no provider production source shells out to a modem diagnostic CLI', () => {
		const files = productionSources(import.meta.dir);
		expect(files.length).toBeGreaterThan(0);
		const violations = files.filter((path) => FORBIDDEN.test(readFileSync(path, 'utf8')));
		expect(violations).toEqual([]);
	});
});
