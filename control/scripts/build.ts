/**
 * Build `@ceralive/modem-control` into `dist/`: ESM JavaScript + `.d.ts`, emitted by
 * `tsc`, then post-processed so every relative specifier is fully specified.
 *
 * WHY THE POST-PROCESS EXISTS. The package's sources use extensionless relative
 * specifiers (`moduleResolution: bundler`), which Node's ESM loader cannot resolve, and
 * `tsc` never rewrites a specifier — it emits what you wrote. So the emitted `./x`
 * becomes `./x.js` or `./x/index.js` here, resolved against the emit itself rather than
 * guessed. `verify()` then fails the build if a single extensionless specifier survives.
 *
 * WHY NOT A BUNDLER. `Bun.build --splitting` was the first attempt and it emitted an
 * entry chunk whose `export { … }` list named symbols the file never imported — Bun's
 * own loader accepts it, Node answers `SyntaxError: Export 'BigIntRequiredError' is not
 * defined in module`. Bundling without splitting avoids that but gives each subpath its
 * own copy of the shared modules, so `instanceof DomainError` stops working across two
 * subpaths of the same package. A 1:1 emit has one instance of every module, keeps
 * `dist` a readable mirror of `src`, and keeps each `.d.ts` beside the `.js` it describes.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PUBLIC_ENTRIES } from './entries';

const PACKAGE_DIR = resolve(import.meta.dir, '..');
const DIST_DIR = join(PACKAGE_DIR, 'dist');

/** `from './x'`, `export * from '../y'`, and bare side-effect `import './z'`. */
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]*)\2/g;
const ALREADY_SPECIFIED = /\.(js|json|mjs|cjs)$/;

async function emittedModules(): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(DIST_DIR, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) {
			found.push(join(entry.parentPath, entry.name));
		}
	}
	return found;
}

/**
 * Resolve one relative specifier against the emit.
 *
 * A declaration resolves against sibling declarations and a module against sibling
 * modules, so a `.d.ts` never ends up pointing at a file that only exists as JavaScript
 * (or the reverse).
 */
function fullySpecify(fromFile: string, specifier: string): string | null {
	const base = resolve(dirname(fromFile), specifier);
	const candidates: readonly (readonly [string, string])[] = fromFile.endsWith('.d.ts')
		? [
				[`${base}.d.ts`, `${specifier}.js`],
				[join(base, 'index.d.ts'), `${specifier}/index.js`],
			]
		: [
				[`${base}.js`, `${specifier}.js`],
				[join(base, 'index.js'), `${specifier}/index.js`],
			];
	for (const [probe, rewritten] of candidates) {
		if (existsSync(probe)) {
			return rewritten;
		}
	}
	return null;
}

async function fullySpecifyEmit(): Promise<void> {
	const unresolved: string[] = [];
	for (const file of await emittedModules()) {
		const source = await readFile(file, 'utf8');
		const rewritten = source.replace(
			RELATIVE_SPECIFIER,
			(match, keyword: string, quote: string, specifier: string) => {
				if (ALREADY_SPECIFIED.test(specifier)) {
					return match;
				}
				const next = fullySpecify(file, specifier);
				if (next === null) {
					unresolved.push(`${file}: ${specifier}`);
					return match;
				}
				return `${keyword}${quote}${next}${quote}`;
			},
		);
		if (rewritten !== source) {
			await writeFile(file, rewritten);
		}
	}
	if (unresolved.length > 0) {
		throw new Error(`unresolvable relative specifiers:\n  ${unresolved.join('\n  ')}`);
	}
}

async function verify(): Promise<void> {
	const missing: string[] = [];
	for (const entry of PUBLIC_ENTRIES) {
		for (const artifact of [entry.js, entry.types]) {
			const path = join(PACKAGE_DIR, artifact);
			if (!existsSync(path) || (await stat(path)).size === 0) {
				missing.push(`${entry.subpath} -> ${artifact}`);
			}
		}
	}
	if (missing.length > 0) {
		throw new Error(`build produced no artifact for:\n  ${missing.join('\n  ')}`);
	}

	const leftovers: string[] = [];
	for (const file of await emittedModules()) {
		const contents = await readFile(file, 'utf8');
		for (const found of contents.matchAll(RELATIVE_SPECIFIER)) {
			const specifier = found[3] as string;
			if (!ALREADY_SPECIFIED.test(specifier)) {
				leftovers.push(`${file}: ${specifier}`);
			}
		}
	}
	if (leftovers.length > 0) {
		throw new Error(`emit kept extensionless specifiers:\n  ${leftovers.join('\n  ')}`);
	}
}

await rm(DIST_DIR, { recursive: true, force: true });
await mkdir(DIST_DIR, { recursive: true });

// Bun hoists the workspace's `typescript` to the repo root, but a non-hoisted install
// puts it in the package. Probe both rather than assume one layout.
const tscBin = [
	join(PACKAGE_DIR, 'node_modules', '.bin', 'tsc'),
	join(PACKAGE_DIR, '..', 'node_modules', '.bin', 'tsc'),
].find((candidate) => existsSync(candidate));
if (tscBin === undefined) {
	throw new Error(
		'tsc not found in control/node_modules or the workspace root — run `bun install`',
	);
}

const tsc = Bun.spawnSync([tscBin, '-p', 'tsconfig.build.json'], {
	cwd: PACKAGE_DIR,
	stdout: 'inherit',
	stderr: 'inherit',
});
if (tsc.exitCode !== 0) {
	throw new Error(`tsc failed with exit code ${tsc.exitCode}`);
}

await fullySpecifyEmit();
await verify();

console.error(`built ${PUBLIC_ENTRIES.length} public entries into dist/`);
