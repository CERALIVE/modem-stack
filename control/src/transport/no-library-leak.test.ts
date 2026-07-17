// Guard: the `@httptoolkit/dbus-native` library must never surface in a public export.
//
// The package entry (`control/src/index.ts`) and the transport seam's own public entry
// (`./index.ts`) may reference the library only through the quarantined facade
// (`./dbus-native.ts`) — never re-export it. Swapping the underlying library (documented
// fallback `@particle/dbus-next`) must stay invisible to every caller.

import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as transportPublic from './index';

// A single-quoted module specifier — the shape of a real import/export, distinct from a
// prose mention of the library in a comment (those use backticks).
const LIBRARY_IMPORT = "'@httptoolkit/dbus-native'";
const transportDir = import.meta.dir;
const controlSrcDir = join(transportDir, '..');

test('the package entry does not import or re-export the D-Bus library', async () => {
	const source = await Bun.file(join(controlSrcDir, 'index.ts')).text();
	expect(source).not.toContain(LIBRARY_IMPORT);
});

test('the transport public entry does not import or re-export the D-Bus library', async () => {
	const source = await Bun.file(join(transportDir, 'index.ts')).text();
	expect(source).not.toContain(LIBRARY_IMPORT);
});

test('only the quarantined facade imports the D-Bus library from production modules', async () => {
	// Enumerate every non-test production module in transport/ dynamically, so a NEW module
	// (e.g. a future transport split) that imports the library directly is caught — the old
	// fixed list never knew about files it did not name. The importer set must be EXACTLY the
	// sanctioned facade, `dbus-native.ts`.
	const productionModules = readdirSync(transportDir).filter(
		(name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
	);
	const importers: string[] = [];
	for (const moduleName of productionModules) {
		const source = await Bun.file(join(transportDir, moduleName)).text();
		if (source.includes(LIBRARY_IMPORT)) {
			importers.push(moduleName);
		}
	}
	expect(importers.sort()).toEqual(['dbus-native.ts']);
});

test('the transport public surface exposes only the seam\u2019s own values', () => {
	const exported = Object.keys(transportPublic).sort();
	expect(exported).toEqual(
		[
			'BigIntRequiredError',
			'DisconnectedError',
			'SixtyFourBitRangeError',
			'TransportError',
			'UnsupportedSignatureError',
			'createDbusTransport',
			'isVariant',
			'variant',
		].sort(),
	);
});
