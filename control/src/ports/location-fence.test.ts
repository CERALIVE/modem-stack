// Guard: the GPS module may never grow history, tracking, persistence, or upload.
//
// This is a PRODUCT fence, not a phase limitation — "we only read the current fix"
// is a promise made to the operator, and a promise held by convention is a promise
// already broken. It is enforced the same way the bearer invariant is: an AST scan
// of the declared type surface, plus a source scan of the implementation for the
// I/O primitives a leak would have to go through.

import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as ts from '@typescript/typescript6';
import { MODEM_LOCATION_IFACE } from '../backend/constants';
import { LOCATION_IFACE } from '../capability/detect';

const srcDir = dirname(import.meta.dir);
const portFile = join(import.meta.dir, 'location.ts');

/** A member name implying the fix outlives the moment it was read. */
const FORBIDDEN_MEMBER = /histor|track|breadcrumb|waypoint|trail|upload|persist|archive|replay/i;

/** Primitives a fix would have to travel through to leave the process. */
const FORBIDDEN_IO = [
	'writeFile',
	'appendFile',
	'writeFileSync',
	'appendFileSync',
	'createWriteStream',
	'fetch(',
	'XMLHttpRequest',
	'localStorage',
	'Bun.write',
];

function declaredMemberNames(source: string): string[] {
	const sourceFile = ts.createSourceFile('port.ts', source, ts.ScriptTarget.Latest, true);
	const names: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isInterfaceDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isClassExpression(node) ||
			ts.isTypeLiteralNode(node)
		) {
			for (const member of node.members) {
				if (member.name !== undefined && ts.isIdentifier(member.name)) {
					names.push(member.name.text);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return names;
}

function gpsSourceFiles(): string[] {
	const files = [portFile, join(srcDir, 'backend', 'mm-location.ts')];
	for (const entry of readdirSync(join(srcDir, 'location'))) {
		if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
			files.push(join(srcDir, 'location', entry));
		}
	}
	return files;
}

test('the location port declares no history / tracking / persistence member', async () => {
	const source = await Bun.file(portFile).text();
	const forbidden = declaredMemberNames(source).filter((name) => FORBIDDEN_MEMBER.test(name));
	expect(forbidden, `forbidden member(s): ${forbidden.join(', ')}`).toEqual([]);
});

test('the location port declares exactly the four current-fix verbs', async () => {
	const source = await Bun.file(portFile).text();
	const sourceFile = ts.createSourceFile('port.ts', source, ts.ScriptTarget.Latest, true);
	let members: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isInterfaceDeclaration(node) && node.name.text === 'ModemLocationPort') {
			members = node.members
				.map((member) => (member.name && ts.isIdentifier(member.name) ? member.name.text : ''))
				.filter((name) => name !== '');
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	expect(members.sort()).toEqual(['disableGnss', 'enableGnss', 'getLocationStatus', 'readFix']);
});

test('no GPS source file reaches a filesystem, a network, or a browser store', async () => {
	for (const file of gpsSourceFiles()) {
		const source = await Bun.file(file).text();
		for (const primitive of FORBIDDEN_IO) {
			expect(source.includes(primitive), `${file} must not use ${primitive}`).toBe(false);
		}
	}
});

test('no GPS source file declares a history / tracking member', async () => {
	for (const file of gpsSourceFiles()) {
		const source = await Bun.file(file).text();
		const forbidden = declaredMemberNames(source).filter((name) => FORBIDDEN_MEMBER.test(name));
		expect(forbidden, `forbidden member(s) in ${file}: ${forbidden.join(', ')}`).toEqual([]);
	}
});

test('the detector is not vacuous — it flags a history surface if one is added', () => {
	const rogue = `
		export interface RogueLocation {
			readFix(): Promise<void>;
			fixHistory(): Promise<void>;
			startTracking(): void;
			uploadTrack(): Promise<void>;
			persistFix(): Promise<void>;
		}
	`;
	expect(
		declaredMemberNames(rogue)
			.filter((name) => FORBIDDEN_MEMBER.test(name))
			.sort(),
	).toEqual(['fixHistory', 'persistFix', 'startTracking', 'uploadTrack']);
});

test('the capability probe and the adapter agree on the Location interface name', () => {
	expect(LOCATION_IFACE).toBe(MODEM_LOCATION_IFACE);
});
