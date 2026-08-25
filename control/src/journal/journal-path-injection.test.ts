// The gate that keeps the journal path INJECTED.
//
// The whole point of this module is that `/data` policy belongs to the embedding
// process. A constant added "for convenience" is exactly how that ownership leaks
// back into the library, and a code review is a poor detector for one added
// months later. So the rule is a test over the shipped source.
//
// COMMENTS ARE STRIPPED FIRST, and that is load-bearing rather than tidy: the
// documentation in `legacy-ceraui.ts` and in this file has to be able to NAME the
// CeraUI convention it reads in order to explain itself. Prose naming a path stays
// legal; executable code producing one does not. (Same shape as the apt-worker
// count-literal gate and CeraUI's link-id authority gate.)

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JOURNAL_DIR = dirname(fileURLToPath(import.meta.url));

/** Remove block and line comments plus every string literal's interior. */
function executableSource(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('*'))
		.join('\n');
}

/**
 * An absolute POSIX path literal inside quotes or a template.
 *
 * `${}` is inside the character class on purpose: a template literal is the
 * obvious way to smuggle a hardcoded root back in (`` `/data/${name}` ``), and a
 * class that stopped at the interpolation would miss exactly that form.
 */
const ABSOLUTE_PATH_LITERAL = /(['"`])\/[A-Za-z][\w./${}-]*\1/g;
/** Any mention of the device data partition or CeraUI's journal directory name. */
const CERAUI_PATH_TOKENS = /\/data\b|ceralive\/modem-mutations|CERALIVE_MODEM_MUTATION_DIR/;

async function shippedSources(): Promise<readonly (readonly [string, string])[]> {
	const names = (await Array.fromAsync(new Bun.Glob('**/*.ts').scan({ cwd: JOURNAL_DIR, onlyFiles: true }))).filter(
		(name) => !name.endsWith('.test.ts'),
	);
	return Promise.all(
		names.map(async (name) => [name, await readFile(join(JOURNAL_DIR, name), 'utf8')] as const),
	);
}

describe('no journal source hardcodes a path', () => {
	test('the gate actually has files to scan', async () => {
		const sources = await shippedSources();
		// Scanned 7 files before directory-glob widening.
		expect(sources.length).toBeGreaterThanOrEqual(7);
		expect(sources.map(([name]) => name)).toContain('store.ts');
		expect(sources.map(([name]) => name)).toContain('legacy-ceraui.ts');
	});

	test('no executable line contains an absolute path literal', async () => {
		const violations: string[] = [];
		for (const [name, source] of await shippedSources()) {
			for (const match of executableSource(source).matchAll(ABSOLUTE_PATH_LITERAL)) {
				violations.push(`${name}: ${match[0]}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test('no executable line names /data or a CeraUI-specific journal location', async () => {
		const violations: string[] = [];
		for (const [name, source] of await shippedSources()) {
			if (CERAUI_PATH_TOKENS.test(executableSource(source))) violations.push(name);
		}
		expect(violations).toEqual([]);
	});

	test('the CeraUI convention IS documented in prose, so the strip is not vacuous', async () => {
		const sources = await shippedSources();
		const legacy = sources.find(([name]) => name === 'legacy-ceraui.ts')?.[1] ?? '';
		expect(legacy.length).toBeGreaterThan(0);
		// The comments explain the shape they read; only the executable strip is empty.
		expect(legacy).toContain('per-modem');
		expect(executableSource(legacy)).not.toContain('per-modem');
	});
});

describe('the gate is non-vacuous', () => {
	// The interpolating sample is ASSEMBLED at runtime rather than written as a
	// literal: spelling it inline is itself the lint violation the gate exists to
	// discourage, so the fabrication must not appear verbatim in this file.
	const INTERPOLATION = `\${name}`;
	const samples: string[] = [
		"const dir = '/data/ceralive/modem-mutations';",
		'const dir = "/var/lib/ceralive/journal";',
		`const dir = \`/data/${INTERPOLATION}\`;`,
	];

	test.each(samples)('a fabricated path literal is caught: %s', (sample) => {
		expect([...executableSource(sample).matchAll(ABSOLUTE_PATH_LITERAL)]).not.toEqual([]);
	});

	test('a fabricated /data reference is caught by the token scan', () => {
		expect(CERAUI_PATH_TOKENS.test(executableSource("const d = '/data/x';"))).toBe(true);
	});

	test('the same text inside a comment is NOT a violation', () => {
		const commented = '// CeraUI keeps this under /data/ceralive/modem-mutations.\nconst x = 1;';
		expect(CERAUI_PATH_TOKENS.test(executableSource(commented))).toBe(false);
		expect([...executableSource(commented).matchAll(ABSOLUTE_PATH_LITERAL)]).toEqual([]);
	});

	test('a relative path literal is legal — only absolute ones are refused', () => {
		expect([...executableSource("join(dir, 'slot.json')").matchAll(ABSOLUTE_PATH_LITERAL)]).toEqual(
			[],
		);
	});
});
