// Guard: no port interface may ever declare a bearer / connect method.
//
// The single most safety-critical constraint in the package (Must-NOT-Have: "no MM
// Simple.Connect / CreateBearer / Bearer.Connect calls ever"). Interfaces are
// erased at runtime, so the enforcement is a source scan: every port `.ts` file is
// stripped of comments (so prose mentions of "bearer" never trip it) and checked
// for a method declaration whose name is `connect`, `simpleConnect`, or contains
// "bearer". Adding such a method to any port fails this test — and therefore CI.

import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const portsDir = import.meta.dir;

function isForbiddenMethodName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === 'connect' || lower === 'simpleconnect' || lower.includes('bearer');
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function declaredMemberNames(source: string): string[] {
	const names: string[] = [];
	const methodDecl = /(?:^|\n)\s*([a-zA-Z_$][\w$]*)\s*[<(]/g;
	let match = methodDecl.exec(source);
	while (match !== null) {
		const name = match[1];
		if (name !== undefined) {
			names.push(name);
		}
		match = methodDecl.exec(source);
	}
	return names;
}

function portSourceFiles(): string[] {
	return readdirSync(portsDir)
		.filter((file) => file.endsWith('.ts'))
		.filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.type-test.ts'));
}

test('no port source declares a bearer / connect method', async () => {
	for (const file of portSourceFiles()) {
		const source = stripComments(await Bun.file(join(portsDir, file)).text());
		const forbidden = declaredMemberNames(source).filter(isForbiddenMethodName);
		expect(forbidden, `forbidden method(s) in ${file}: ${forbidden.join(', ')}`).toEqual([]);
	}
});

test('the ModemManager port source declares the expected non-bearer mutations', async () => {
	const source = stripComments(await Bun.file(join(portsDir, 'modem-manager.ts')).text());
	const names = declaredMemberNames(source);
	for (const expected of [
		'setRadioModes',
		'setPrimarySimSlot',
		'sendPin',
		'sendPuk',
		'scanNetworks',
		'inhibit',
		'uninhibit',
	]) {
		expect(names).toContain(expected);
	}
});

test('the detector actually catches a bearer / connect method (self-test)', () => {
	const rogue = `
		export interface Rogue {
			connect(): Promise<void>;
			createBearer(): Promise<void>;
			bearerConnect(): Promise<void>;
			setRadioModes(): Promise<void>;
		}
	`;
	const flagged = declaredMemberNames(stripComments(rogue)).filter(isForbiddenMethodName).sort();
	expect(flagged).toEqual(['bearerConnect', 'connect', 'createBearer']);
});
