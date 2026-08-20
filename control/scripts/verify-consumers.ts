#!/usr/bin/env bun
/**
 * Run the standalone consumer fixtures against the PACKED tarball.
 *
 * Both fixtures are real, separate projects: each gets its own directory, installs
 * `@ceralive/modem-control` from the `.tgz` with its own package manager, and imports
 * every public subpath by specifier. Nothing in them resolves through this workspace —
 * no `paths` mapping, no `link:`, no relative reach into `control/src`. That is the
 * point: the repo's own tsconfig maps the package back to source for development, so
 * the built artifact would otherwise never be executed by anything.
 *
 * The Node fixture asserts its own runtime major is 26 before it runs, so a green
 * result cannot come from an older Node that happens to be first on `PATH`.
 *
 * Fixtures are COPIED into `test-results/consumers/<name>/` and installed there, so
 * `control/fixtures/` never grows a `node_modules` or a lockfile.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { packTarball } from './pack-tarball';

const PACKAGE_DIR = resolve(import.meta.dir, '..');
const FIXTURES_DIR = join(PACKAGE_DIR, 'fixtures');
const WORK_DIR = join(PACKAGE_DIR, 'test-results', 'consumers');

const REQUIRED_NODE_MAJOR = 26;

type Fixture = {
	readonly name: string;
	readonly runtime: string;
	readonly install: (tarball: string) => string[];
	readonly run: string[];
};

/** Resolve the Node binary the fixture must run under. */
const NODE_BIN = process.env.CERALIVE_NODE_BIN ?? 'node';

const FIXTURES: readonly Fixture[] = [
	{
		name: 'consumer-node',
		runtime: NODE_BIN,
		install: (tarball) => ['npm', 'install', '--no-audit', '--no-fund', tarball],
		run: [NODE_BIN, './check.mjs'],
	},
	{
		name: 'consumer-bun',
		runtime: 'bun',
		install: (tarball) => ['bun', 'add', tarball],
		run: ['bun', './check.mjs'],
	},
];

function run(command: string[], cwd: string, env?: Record<string, string>): string {
	const result = Bun.spawnSync(command, {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		...(env === undefined ? {} : { env: { ...process.env, ...env } }),
	});
	const output = `${result.stdout.toString()}${result.stderr.toString()}`;
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(' ')} failed (${result.exitCode}) in ${cwd}:\n${output}`);
	}
	return output;
}

function assertNodeMajor(): string {
	const version = run([NODE_BIN, '--version'], PACKAGE_DIR).trim();
	const major = Number(version.replace(/^v/, '').split('.')[0]);
	if (major !== REQUIRED_NODE_MAJOR) {
		throw new Error(
			`the Node fixture requires Node ${REQUIRED_NODE_MAJOR}.x, found ${version}. ` +
				`Set CERALIVE_NODE_BIN to a Node ${REQUIRED_NODE_MAJOR} binary.`,
		);
	}
	return version;
}

const nodeVersion = assertNodeMajor();
console.log(`node: ${nodeVersion}`);
console.log(`bun:  v${Bun.version}`);

const packed = await packTarball();
console.log(`tarball: ${packed.tarball}\n`);

await rm(WORK_DIR, { recursive: true, force: true });
await mkdir(WORK_DIR, { recursive: true });

for (const fixture of FIXTURES) {
	const dir = join(WORK_DIR, fixture.name);
	await cp(join(FIXTURES_DIR, fixture.name), dir, { recursive: true });
	await cp(join(FIXTURES_DIR, 'check-public-surface.mjs'), join(dir, 'check.mjs'));

	run(fixture.install(packed.tarball), dir);
	const output = run(fixture.run, dir).trim();
	console.log(`${fixture.name} (${fixture.runtime}): ${output}`);
}

console.log('\nboth standalone consumers import every public subpath from the packed tarball');
