// Guard: no port interface may ever declare a bearer / connect method.
//
// The single most safety-critical constraint in the package (Must-NOT-Have: "no MM
// Simple.Connect / CreateBearer / Bearer.Connect calls ever"). Interfaces are
// erased at runtime, so the enforcement is a source scan: every port `.ts` file is
// parsed with the TypeScript compiler API and each DECLARED member of an interface,
// type literal, or class is checked for a name that is `connect`, `simpleConnect`,
// or contains "bearer". Adding such a member to any port fails this test — and CI.
//
// The detector walks the real AST rather than the source text, so it catches shapes
// a naive regex cannot: method signatures, property signatures typed as function
// types, get/set accessors, optional members, and quoted or computed string-literal
// member names (`'connect'()`, `['connect']()`) all resolve to their true name. It
// only ever inspects member NAMES on those three declaration kinds — never string
// literal values, value-position object-literal keys, comments, local variables, or
// call expressions — so prose mentions of "bearer" and value keys never trip it.

import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const portsDir = import.meta.dir;

function isForbiddenMethodName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === 'connect' || lower === 'simpleconnect' || lower.includes('bearer');
}

/**
 * Resolve a declared member's name node to its static string name, or `undefined`
 * when the name is not statically knowable (e.g. a computed `[Symbol.iterator]` or a
 * computed reference to a non-literal identifier). Plain identifiers, private names,
 * string / numeric literals, and computed names wrapping a string / numeric literal
 * (`['connect']`) all resolve to their real text.
 */
function resolveMemberName(name: ts.Node): string | undefined {
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
		return name.text;
	}
	if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	if (ts.isComputedPropertyName(name)) {
		const { expression } = name;
		if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
			return expression.text;
		}
	}
	return undefined;
}

/**
 * Every DECLARED member name of an interface, type literal, or class in `source`,
 * parsed via the TypeScript compiler API. Value-position object-literal keys, string
 * literal values, comments, local variables, and call expressions are all excluded —
 * only the port's actual type surface is inspected. Method signatures, property
 * signatures (including arrow-typed properties), get/set accessors, optional members,
 * and quoted / computed string-literal member names are all resolved to their name.
 */
function declaredMemberNames(source: string): string[] {
	const sourceFile = ts.createSourceFile(
		'port.ts',
		source,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
	);
	const names: string[] = [];

	const collectMembers = (members: readonly (ts.TypeElement | ts.ClassElement)[]): void => {
		for (const member of members) {
			if (member.name === undefined) {
				continue;
			}
			const resolved = resolveMemberName(member.name);
			if (resolved !== undefined) {
				names.push(resolved);
			}
		}
	};

	const visit = (node: ts.Node): void => {
		if (
			ts.isInterfaceDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isClassExpression(node) ||
			ts.isTypeLiteralNode(node)
		) {
			collectMembers(node.members);
		}
		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return names;
}

// The retired regex detector — kept ONLY so the differential test below can prove,
// by running it, that the AST rebuild is a strict improvement (it caught just one of
// the seven forbidden shapes). Not used by any real-port scan; do not reintroduce.
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function legacyRegexMemberNames(source: string): string[] {
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
		const source = await Bun.file(join(portsDir, file)).text();
		const forbidden = declaredMemberNames(source).filter(isForbiddenMethodName);
		expect(forbidden, `forbidden member(s) in ${file}: ${forbidden.join(', ')}`).toEqual([]);
	}
});

test('the ModemManager port source declares the expected non-bearer mutations', async () => {
	const source = await Bun.file(join(portsDir, 'modem-manager.ts')).text();
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

test('the detector catches every forbidden member shape (self-test)', () => {
	// Each line is a DISTINCT declaration shape the AST resolver must catch: a plain
	// method, a computed string-literal method, a quoted string-literal method, an
	// optional method, a get accessor, a set accessor, and an arrow-typed property.
	// `setRadioModes` is a legitimate mutation that must pass through unflagged.
	const rogue = `
		export interface RogueSurface {
			connect(): Promise<void>;
			['simpleConnect'](): void;
			'createBearer'(): void;
			bearerReset?(): void;
			get bearerState(): number;
			set bearerTarget(value: number);
			bearerHook: () => Promise<void>;
			setRadioModes(): Promise<void>;
		}
	`;
	const flagged = declaredMemberNames(rogue).filter(isForbiddenMethodName).sort();
	expect(flagged).toEqual([
		'bearerHook',
		'bearerReset',
		'bearerState',
		'bearerTarget',
		'connect',
		'createBearer',
		'simpleConnect',
	]);
	// The acceptance bar for the rebuild: at least seven distinct forbidden shapes.
	expect(flagged.length).toBeGreaterThanOrEqual(7);
});

test('the detector ignores string values, value-position keys, and non-forbidden members', () => {
	// Three negative fixtures that must NOT trip the detector:
	//   1. `reconnectPolicy` — a real interface member whose name merely CONTAINS the
	//      substring "connect"; the predicate matches "connect" exactly, not as a
	//      substring, so it must pass (proves the predicate is not overly broad).
	//   2. `description: '…bearer…'` — a member whose string-literal VALUE contains
	//      "bearer"; only member NAMES are inspected, never string content.
	//   3. `bearerConnect: true` — a key in a value-position object literal, not a
	//      type-level member declaration; the AST never walks object-literal keys.
	const negative = `
		interface LegitPort {
			reconnectPolicy: RetryPolicy;
			setRadioModes(): Promise<void>;
			description: 'manages bearer state internally';
		}
		const runtimeConfig = {
			bearerConnect: true,
			description: 'manages bearer state internally',
		};
	`;
	const members = declaredMemberNames(negative);
	expect(members).toContain('reconnectPolicy');
	expect(members).not.toContain('bearerConnect');
	expect(members.filter(isForbiddenMethodName)).toEqual([]);
});

test('the AST detector catches member shapes the legacy regex missed (differential)', () => {
	// The same rogue surface, run through BOTH detectors. The retired regex only ever
	// matched an identifier immediately followed by `(` or `<` at a line start, so it
	// caught the single plain method and missed the other six shapes. The AST walk
	// catches all seven — the strict improvement the rebuild delivers.
	const rogue = `
		export interface RogueSurface {
			connect(): Promise<void>;
			['simpleConnect'](): void;
			'createBearer'(): void;
			bearerReset?(): void;
			get bearerState(): number;
			set bearerTarget(value: number);
			bearerHook: () => Promise<void>;
		}
	`;
	const legacyFlagged = legacyRegexMemberNames(stripComments(rogue))
		.filter(isForbiddenMethodName)
		.sort();
	const astFlagged = declaredMemberNames(rogue).filter(isForbiddenMethodName).sort();

	// The regex caught only the plain method.
	expect(legacyFlagged).toEqual(['connect']);
	// The AST catches every shape the regex missed, and then some.
	for (const missed of [
		'bearerHook',
		'bearerReset',
		'bearerState',
		'bearerTarget',
		'createBearer',
		'simpleConnect',
	]) {
		expect(legacyFlagged).not.toContain(missed);
		expect(astFlagged).toContain(missed);
	}
});
