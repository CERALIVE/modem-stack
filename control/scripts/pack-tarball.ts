/**
 * Pack `@ceralive/modem-control` with `bun pm pack` and extract the result.
 *
 * `bun pm pack` runs the package's own `prepack` (`bun run build`), so what is
 * inspected here is always a freshly built artifact rather than whatever happened to
 * be lying in `dist/`.
 *
 * Output lands in the gitignored, package-local `test-results/pack/`, which `files:
 * ["dist"]` keeps out of the tarball — the shape gate re-proves that every run.
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readExtractedTarball, type TarballShape } from './tarball-shape';

const PACKAGE_DIR = resolve(import.meta.dir, '..');

export type PackedTarball = {
	/** Absolute path of the `.tgz`. */
	readonly tarball: string;
	/** `tar -tf` output, verbatim, one entry per line (`package/...`). */
	readonly listing: readonly string[];
	/** The extracted artifact, ready for the shape rules. */
	readonly shape: TarballShape;
};

function run(command: string[], cwd: string): string {
	const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
	if (result.exitCode !== 0) {
		throw new Error(
			`${command.join(' ')} failed (${result.exitCode}):\n${result.stderr.toString()}`,
		);
	}
	return result.stdout.toString();
}

/** Pack, list and extract. `workDir` defaults to the package-local `test-results/pack`. */
export async function packTarball(workDir?: string): Promise<PackedTarball> {
	const dir = workDir ?? join(PACKAGE_DIR, 'test-results', 'pack');
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });

	run(['bun', 'pm', 'pack', '--destination', dir], PACKAGE_DIR);

	const packed = (await readdir(dir)).filter((name) => name.endsWith('.tgz'));
	if (packed.length !== 1) {
		throw new Error(`expected exactly one .tgz in ${dir}, found ${packed.length}`);
	}
	const tarball = join(dir, packed[0] as string);

	const listing = run(['tar', '-tf', tarball], dir)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const extracted = join(dir, 'extracted');
	await mkdir(extracted, { recursive: true });
	run(['tar', '-xzf', tarball, '-C', extracted], dir);

	return { tarball, listing, shape: await readExtractedTarball(join(extracted, 'package')) };
}
