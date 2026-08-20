import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_ENTRIES, PUBLIC_SUBPATHS } from './entries';
import { type PackedTarball, packTarball } from './pack-tarball';
import {
	allViolations,
	builtOutputViolations,
	exportTargetViolations,
	publicEntryViolations,
	rawSourceViolations,
	readExtractedTarball,
	serviceArtifactViolations,
	undeclaredExportViolations,
} from './tarball-shape';

/**
 * The frozen public surface, spelled out.
 *
 * This literal is the reason the gate cannot be satisfied by deleting a subpath: a
 * removal has to be made HERE too, which is a reviewable change to the package's
 * public contract rather than a silent edit to `package.json`.
 */
const EXPECTED_SUBPATHS = [
	'.',
	'./transport',
	'./domain',
	'./providers',
	'./capabilities',
	'./hardware',
	'./testing',
] as const;

let packed: PackedTarball;

beforeAll(async () => {
	packed = await packTarball();
}, 300_000);

describe('bun pm pack', () => {
	test('produces a tarball with a non-empty listing', () => {
		expect(packed.tarball).toEndWith('.tgz');
		expect(packed.listing.length).toBeGreaterThan(0);
	});

	test('the listing carries built JavaScript and declarations under dist/', () => {
		expect(packed.listing.some((entry) => /^package\/dist\/.*\.js$/.test(entry))).toBe(true);
		expect(packed.listing.some((entry) => /^package\/dist\/.*\.d\.ts$/.test(entry))).toBe(true);
		expect(builtOutputViolations(packed.shape)).toEqual([]);
	});

	test('the listing has NO src/ entry — the published surface is built output', () => {
		expect(packed.listing.filter((entry) => /(^|\/)src\//.test(entry))).toEqual([]);
		expect(rawSourceViolations(packed.shape)).toEqual([]);
	});

	test('nothing but package.json ships outside dist/', () => {
		const outside = packed.listing.filter(
			(entry) => !entry.startsWith('package/dist/') && entry !== 'package/package.json',
		);
		expect(outside.filter((entry) => !/^package\/(README|LICENSE)/i.test(entry))).toEqual([]);
	});
});

describe('the public exports map', () => {
	test('declares exactly the seven frozen subpaths, ./testing included', () => {
		expect([...PUBLIC_SUBPATHS]).toEqual([...EXPECTED_SUBPATHS]);

		const exportsMap = packed.shape.manifest.exports as Record<string, unknown>;
		for (const subpath of EXPECTED_SUBPATHS) {
			expect(Object.keys(exportsMap)).toContain(subpath);
		}
		expect(Object.keys(exportsMap).sort()).toEqual([...EXPECTED_SUBPATHS, './package.json'].sort());
	});

	test('the ./testing contract-fakes entry is exported and packed', () => {
		const exportsMap = packed.shape.manifest.exports as Record<string, Record<string, string>>;
		expect(exportsMap['./testing']).toEqual({
			types: './dist/testing/index.d.ts',
			import: './dist/testing/index.js',
		});
		expect(packed.listing).toContain('package/dist/testing/index.js');
		expect(packed.listing).toContain('package/dist/testing/index.d.ts');
	});

	test('every declared entry resolves to a packed artifact', () => {
		expect(publicEntryViolations(packed.shape)).toEqual([]);
		for (const entry of PUBLIC_ENTRIES) {
			expect(packed.listing).toContain(`package/${entry.js}`);
			expect(packed.listing).toContain(`package/${entry.types}`);
		}
	});

	test('exposes no undeclared subpath and points nowhere outside ./dist/', () => {
		expect(undeclaredExportViolations(packed.shape)).toEqual([]);
		expect(exportTargetViolations(packed.shape)).toEqual([]);
	});
});

describe('library-only proof', () => {
	test('no bin entry, no systemd unit, no shebang, no listening socket', async () => {
		expect(await serviceArtifactViolations(packed.shape)).toEqual([]);
	});

	test('the manifest declares no bin and no directories.bin', () => {
		expect(packed.shape.manifest.bin).toBeUndefined();
		expect(packed.shape.manifest.directories).toBeUndefined();
	});

	test('no packed path names a systemd unit or a socket/daemon entrypoint', () => {
		const suspicious = packed.listing.filter((entry) =>
			/(systemd|\.service$|\.socket$|\.timer$|\.target$|daemon)/i.test(entry),
		);
		expect(suspicious).toEqual([]);
	});

	test('the whole artifact is clean', async () => {
		expect(await allViolations(packed.shape)).toEqual([]);
	});
});

describe('the detectors are non-vacuous', () => {
	async function syntheticShape(build: (root: string) => Promise<void>) {
		const root = join(await mkdtemp(join(tmpdir(), 'modem-shape-')), 'package');
		await mkdir(join(root, 'dist'), { recursive: true });
		await build(root);
		return readExtractedTarball(root);
	}

	test('shipped raw source is caught', async () => {
		const shape = await syntheticShape(async (root) => {
			await writeFile(join(root, 'package.json'), '{"name":"x"}');
			await mkdir(join(root, 'src'), { recursive: true });
			await writeFile(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
			await writeFile(join(root, 'dist', 'index.js'), 'export const a = 1;\n');
		});
		expect(rawSourceViolations(shape)).toEqual(['raw source shipped: src/index.ts']);
	});

	test('a missing ./testing subpath is caught', async () => {
		const shape = await syntheticShape(async (root) => {
			const exportsMap = Object.fromEntries(
				PUBLIC_ENTRIES.filter((entry) => entry.subpath !== './testing').map((entry) => [
					entry.subpath,
					{ types: `./${entry.types}`, import: `./${entry.js}` },
				]),
			);
			await writeFile(join(root, 'package.json'), JSON.stringify({ exports: exportsMap }));
		});
		expect(publicEntryViolations(shape)).toContain(
			'exports map is missing the "./testing" subpath',
		);
	});

	test('an exports target still pointing at src/ is caught', async () => {
		const shape = await syntheticShape(async (root) => {
			await writeFile(
				join(root, 'package.json'),
				JSON.stringify({ exports: { '.': './src/index.ts' } }),
			);
		});
		expect(exportTargetViolations(shape)).toEqual([
			'exports["."] points outside ./dist/: ./src/index.ts',
		]);
	});

	test('an extra internal barrel exposed as a subpath is caught', async () => {
		const shape = await syntheticShape(async (root) => {
			await writeFile(
				join(root, 'package.json'),
				JSON.stringify({ exports: { './backend': { import: './dist/backend/index.js' } } }),
			);
		});
		expect(undeclaredExportViolations(shape)).toEqual(['undeclared public subpath: ./backend']);
	});

	test('a bin entry, a systemd unit, a shebang and a listener are each caught', async () => {
		const shape = await syntheticShape(async (root) => {
			await writeFile(
				join(root, 'package.json'),
				JSON.stringify({ bin: { 'modem-controld': './dist/daemon.js' } }),
			);
			await writeFile(join(root, 'dist', 'modem-control.service'), '[Unit]\n');
			await writeFile(join(root, 'dist', 'daemon.js'), '#!/usr/bin/env node\nexport {};\n');
			await writeFile(
				join(root, 'dist', 'listener.js'),
				'export const s = createServer(() => {});\n',
			);
		});
		const violations = await serviceArtifactViolations(shape);
		expect(violations.some((v) => v.includes('bin entry'))).toBe(true);
		expect(violations).toContain('systemd unit file shipped: dist/modem-control.service');
		expect(violations).toContain('executable entrypoint (shebang) shipped: dist/daemon.js');
		expect(violations.some((v) => v.includes('daemon/socket construct'))).toBe(true);
	});

	test('an empty dist is caught', async () => {
		const shape = await syntheticShape(async (root) => {
			await writeFile(join(root, 'package.json'), '{"name":"x"}');
		});
		expect(builtOutputViolations(shape)).toContain('no dist/ output in the tarball');
	});
});
