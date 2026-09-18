import { test } from 'bun:test';

const FIRST_PARTY_PACKAGE_PATHS = [
	'package.json',
	'control/package.json',
	'cli/package.json',
] as const;

type PackageVersion = {
	readonly path: string;
	readonly version: string;
};

async function readPackageVersion(path: string): Promise<PackageVersion> {
	const manifest: unknown = await Bun.file(path).json();
	if (typeof manifest !== 'object' || manifest === null) {
		throw new Error(`${path} must contain a JSON object`);
	}

	const version = Reflect.get(manifest, 'version');
	if (typeof version !== 'string') {
		throw new Error(`${path} must contain a string version`);
	}

	return { path, version };
}

test('first-party workspace package versions stay unified', async () => {
	const packageVersions = await Promise.all(FIRST_PARTY_PACKAGE_PATHS.map(readPackageVersion));
	const root = packageVersions[0];
	if (root === undefined) {
		throw new Error('first-party package version list is unexpectedly empty');
	}

	for (const packageVersion of packageVersions.slice(1)) {
		if (packageVersion.version !== root.version) {
			throw new Error(
				`${packageVersion.path} version ${packageVersion.version} does not match ${root.path} version ${root.version}`,
			);
		}
	}
});
