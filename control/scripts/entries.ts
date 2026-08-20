/**
 * The PUBLIC entry map of `@ceralive/modem-control`.
 *
 * This is the single source of truth the build, the exports map and the tarball-shape
 * gate all read. A subpath that is not listed here is not published, and a subpath
 * listed here that is missing from `package.json` `exports` fails the shape gate — so
 * the two cannot drift.
 *
 * Adding a row is a deliberate widening of the public surface: it exposes a module to
 * every consumer forever. Internal barrels (`src/backend`, `src/ports`, `src/sms`,
 * `src/ussd`, `src/location`, `src/fcc`, `src/redact`) are reachable only through the
 * root entry and are deliberately absent.
 */
export type PublicEntry = {
	/** The `exports` specifier, e.g. `.` or `./testing`. */
	readonly subpath: string;
	/** Source entry point, relative to the package directory. */
	readonly source: string;
	/** Built ESM output, relative to the package directory. */
	readonly js: string;
	/** Emitted declaration, relative to the package directory. */
	readonly types: string;
};

export const PUBLIC_ENTRIES: readonly PublicEntry[] = [
	{ subpath: '.', source: 'src/index.ts', js: 'dist/index.js', types: 'dist/index.d.ts' },
	{
		subpath: './transport',
		source: 'src/transport/index.ts',
		js: 'dist/transport/index.js',
		types: 'dist/transport/index.d.ts',
	},
	{
		subpath: './domain',
		source: 'src/domain/index.ts',
		js: 'dist/domain/index.js',
		types: 'dist/domain/index.d.ts',
	},
	{
		subpath: './providers',
		source: 'src/providers/index.ts',
		js: 'dist/providers/index.js',
		types: 'dist/providers/index.d.ts',
	},
	{
		subpath: './capabilities',
		source: 'src/capability/index.ts',
		js: 'dist/capability/index.js',
		types: 'dist/capability/index.d.ts',
	},
	{
		subpath: './hardware',
		source: 'src/hardware/index.ts',
		js: 'dist/hardware/index.js',
		types: 'dist/hardware/index.d.ts',
	},
	{
		subpath: './testing',
		source: 'src/testing/index.ts',
		js: 'dist/testing/index.js',
		types: 'dist/testing/index.d.ts',
	},
] as const;

/** Every published specifier, in declaration order. */
export const PUBLIC_SUBPATHS: readonly string[] = PUBLIC_ENTRIES.map((entry) => entry.subpath);
