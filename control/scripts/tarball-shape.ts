/**
 * The tarball-shape gate for `@ceralive/modem-control`.
 *
 * `@ceralive/modem-control` is a LIBRARY. It ships built ESM plus declarations and
 * nothing that could start: no `bin`, no systemd unit, no shebang, no listening
 * socket. That is a claim about a published artifact, so it is checked against the
 * artifact — the real `bun pm pack` output — rather than against the source tree.
 *
 * Every rule returns its violations instead of throwing, so a caller reports all of
 * them at once and a test can name each rule separately.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PUBLIC_ENTRIES } from './entries';

/** An extracted tarball: the `tar -tf` listing plus the packed manifest. */
export type TarballShape = {
	/** Paths relative to the tarball's `package/` root, e.g. `dist/index.js`. */
	readonly entries: readonly string[];
	/** The packed `package.json`, parsed. */
	readonly manifest: Record<string, unknown>;
	/** Absolute path of the extracted `package/` directory. */
	readonly root: string;
};

const SYSTEMD_UNIT_EXTENSIONS = [
	'.service',
	'.socket',
	'.target',
	'.timer',
	'.path',
	'.mount',
	'.automount',
	'.slice',
	'.swap',
	'.device',
	'.scope',
];

/** Constructs that would open a listening socket — a daemon's defining act. */
const LISTENING_SOCKET_PATTERNS = [
	/\bcreateServer\s*\(/,
	/\bBun\s*\.\s*serve\s*\(/,
	/\bnode:net\b/,
	/\bnode:http2?\b/,
	/\.\s*listen\s*\(/,
];

async function walk(dir: string, root: string, found: string[] = []): Promise<string[]> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(full, root, found);
		} else {
			found.push(relative(root, full));
		}
	}
	return found;
}

/** Read an already-extracted `package/` directory into a {@link TarballShape}. */
export async function readExtractedTarball(root: string): Promise<TarballShape> {
	const entries = (await walk(root, root)).sort();
	const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<
		string,
		unknown
	>;
	return { entries, manifest, root };
}

/** RULE 1 — nothing under `src/` may ship; the published surface is the BUILT output. */
export function rawSourceViolations(shape: TarballShape): readonly string[] {
	return shape.entries
		.filter((entry) => entry === 'src' || entry.startsWith('src/') || entry.includes('/src/'))
		.map((entry) => `raw source shipped: ${entry}`);
}

/** RULE 2 — the built artifacts a library is supposed to have are actually present. */
export function builtOutputViolations(shape: TarballShape): readonly string[] {
	const violations: string[] = [];
	const distFiles = shape.entries.filter((entry) => entry.startsWith('dist/'));
	if (distFiles.length === 0) {
		violations.push('no dist/ output in the tarball');
	}
	if (!distFiles.some((entry) => entry.endsWith('.js'))) {
		violations.push('no built JavaScript in dist/');
	}
	if (!distFiles.some((entry) => entry.endsWith('.d.ts'))) {
		violations.push('no declarations (.d.ts) in dist/');
	}
	return violations;
}

/**
 * RULE 3 — every declared public entry is in the exports map AND its files are packed.
 *
 * Driven by {@link PUBLIC_ENTRIES}, so a subpath cannot be dropped from `package.json`
 * without this failing.
 */
export function publicEntryViolations(shape: TarballShape): readonly string[] {
	const violations: string[] = [];
	const exportsMap = shape.manifest.exports;
	if (typeof exportsMap !== 'object' || exportsMap === null) {
		return ['package.json has no exports map'];
	}
	const map = exportsMap as Record<string, unknown>;
	const packed = new Set(shape.entries);

	for (const entry of PUBLIC_ENTRIES) {
		const condition = map[entry.subpath];
		if (condition === undefined) {
			violations.push(`exports map is missing the "${entry.subpath}" subpath`);
			continue;
		}
		if (typeof condition !== 'object' || condition === null) {
			violations.push(`exports["${entry.subpath}"] is not a conditions object`);
			continue;
		}
		const conditions = condition as Record<string, unknown>;
		if (conditions.import !== `./${entry.js}`) {
			violations.push(
				`exports["${entry.subpath}"].import is ${String(conditions.import)}, expected ./${entry.js}`,
			);
		}
		if (conditions.types !== `./${entry.types}`) {
			violations.push(
				`exports["${entry.subpath}"].types is ${String(conditions.types)}, expected ./${entry.types}`,
			);
		}
		for (const artifact of [entry.js, entry.types]) {
			if (!packed.has(artifact)) {
				violations.push(`exports["${entry.subpath}"] target ${artifact} is not in the tarball`);
			}
		}
	}
	return violations;
}

/** RULE 4 — no subpath beyond the declared set; internal barrels stay internal. */
export function undeclaredExportViolations(shape: TarballShape): readonly string[] {
	const exportsMap = shape.manifest.exports;
	if (typeof exportsMap !== 'object' || exportsMap === null) {
		return ['package.json has no exports map'];
	}
	const allowed = new Set<string>([
		...PUBLIC_ENTRIES.map((entry) => entry.subpath),
		'./package.json',
	]);
	return Object.keys(exportsMap as Record<string, unknown>)
		.filter((subpath) => !allowed.has(subpath))
		.map((subpath) => `undeclared public subpath: ${subpath}`);
}

/** RULE 5 — no exports target, nor `main`/`types`, may point outside `./dist/`. */
export function exportTargetViolations(shape: TarballShape): readonly string[] {
	const violations: string[] = [];
	const check = (label: string, value: unknown): void => {
		if (typeof value !== 'string') {
			return;
		}
		if (value === './package.json') {
			return;
		}
		if (!value.startsWith('./dist/')) {
			violations.push(`${label} points outside ./dist/: ${value}`);
		}
	};

	check('main', shape.manifest.main);
	check('types', shape.manifest.types);
	const exportsMap = shape.manifest.exports;
	if (typeof exportsMap === 'object' && exportsMap !== null) {
		for (const [subpath, condition] of Object.entries(exportsMap as Record<string, unknown>)) {
			if (typeof condition === 'string') {
				check(`exports["${subpath}"]`, condition);
				continue;
			}
			if (typeof condition === 'object' && condition !== null) {
				for (const [name, value] of Object.entries(condition as Record<string, unknown>)) {
					check(`exports["${subpath}"].${name}`, value);
				}
			}
		}
	}
	return violations;
}

/**
 * RULE 6 — the library-only proof: nothing in this artifact can be STARTED.
 *
 * No `bin` entry, no systemd unit, no shebang, no listening-socket construct. Each is
 * a separate way the same mistake gets made, so each is checked rather than assumed
 * away by the others.
 */
export async function serviceArtifactViolations(shape: TarballShape): Promise<readonly string[]> {
	const violations: string[] = [];

	if (shape.manifest.bin !== undefined) {
		violations.push(`package.json declares a bin entry: ${JSON.stringify(shape.manifest.bin)}`);
	}
	const directories = shape.manifest.directories;
	if (typeof directories === 'object' && directories !== null) {
		if ((directories as Record<string, unknown>).bin !== undefined) {
			violations.push('package.json declares directories.bin');
		}
	}

	for (const entry of shape.entries) {
		const lower = entry.toLowerCase();
		if (SYSTEMD_UNIT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
			violations.push(`systemd unit file shipped: ${entry}`);
		}
		if (lower.includes('systemd')) {
			violations.push(`systemd artifact shipped: ${entry}`);
		}
	}

	for (const entry of shape.entries) {
		const path = join(shape.root, entry);
		if ((await stat(path)).size === 0) {
			continue;
		}
		const contents = await readFile(path, 'utf8').catch(() => '');
		if (contents.startsWith('#!')) {
			violations.push(`executable entrypoint (shebang) shipped: ${entry}`);
		}
		if (!entry.endsWith('.js')) {
			continue;
		}
		for (const pattern of LISTENING_SOCKET_PATTERNS) {
			if (pattern.test(contents)) {
				violations.push(`daemon/socket construct ${String(pattern)} found in ${entry}`);
			}
		}
	}

	return violations;
}

/** Every rule, in order. An empty array is a passing artifact. */
export async function allViolations(shape: TarballShape): Promise<readonly string[]> {
	return [
		...rawSourceViolations(shape),
		...builtOutputViolations(shape),
		...publicEntryViolations(shape),
		...undeclaredExportViolations(shape),
		...exportTargetViolations(shape),
		...(await serviceArtifactViolations(shape)),
	];
}
