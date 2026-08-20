// The "no code path at all" half of the fence.
//
// prohibition-fence.test.ts proves the forbidden operations are REFUSED. This file
// proves something stronger and different: that no function capable of performing one
// exists in the shipped provider. It scans the comment-stripped production source for
// the constructs such a function would need — a subprocess, a raw socket, a shell
// fallback binary, a DIAG device node, a mutating HTTP verb, or a HIMI command outside
// the frozen read vocabulary — and every detector has a non-vacuity control.

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { UFI_COMMANDS, UFI_READ_COMMANDS, UFI_SESSION_COMMANDS } from './transport';

const DIR = import.meta.dir;

const DETECTORS = [
	{
		label: 'subprocess',
		re: /(?:Bun\.spawn|execFileSync?|spawnSync|execSync)\s*\(|node:child_process/,
		sample: "Bun.spawn(['adb', 'shell'])",
	},
	{
		label: 'raw-socket',
		re: /node:(?:net|dgram|tls)|createConnection\s*\(/,
		sample: "import { createConnection } from 'node:net';",
	},
	{
		label: 'shell-fallback-binary',
		re: /(['"`])(?:adb|ssh|telnet|qcsuper|edl|fastboot|firehose|sahara)\1/i,
		sample: "const tool = 'qcsuper';",
	},
	{
		label: 'diag-device-node',
		re: /\/dev\/diag|\/dev\/ttyUSB\d/,
		sample: "open('/dev/diag')",
	},
	{
		label: 'mutating-http-verb',
		re: /(['"`])(?:PUT|PATCH|DELETE)\1/,
		sample: "method: 'PUT'",
	},
	{
		// In a read-only provider a bare write-shaped literal is a review trigger by
		// itself: it is either a HIMI write command or a descriptor claiming a write
		// impact, and neither may exist here.
		label: 'write-shaped-literal',
		re: /(['"`])(?:set|write|upgrade|reboot|reset|restore|erase|flash)[a-z_]*\1/i,
		sample: "cmdid: 'setnetworkmode'",
	},
] as const;

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.split('\n')
		.filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
		.join('\n');
}

const CODE = new Map<string, string>();
for (const name of readdirSync(DIR)) {
	if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
	CODE.set(name, stripComments(await Bun.file(join(DIR, name)).text()));
}

describe('the UFI/HIMI provider has no write path to have', () => {
	test('scans the whole shipped provider, so the gate cannot pass vacuously', () => {
		// Given / When / Then
		expect([...CODE.keys()].sort()).toEqual([
			'index.ts',
			'operations.ts',
			'prohibitions.ts',
			'provider.ts',
			'qualcomm-evidence.ts',
			'session.ts',
			'transport.ts',
		]);
	});

	test.each(DETECTORS.map((detector) => [detector.label, detector] as const))(
		'the %s detector fires on a synthetic violation',
		(_label, detector) => {
			// Given / When / Then
			expect(detector.re.test(stripComments(detector.sample))).toBe(true);
		},
	);

	test.each(DETECTORS.map((detector) => [detector.label, detector] as const))(
		'no production source contains a %s construct',
		(_label, detector) => {
			// Given / When
			const violations = [...CODE.entries()]
				.filter(([, source]) => detector.re.test(source))
				.map(([name]) => name);

			// Then
			expect(violations).toEqual([]);
		},
	);
});

describe('the HIMI command vocabulary is closed and read-only', () => {
	test('every command is a read or the session login, and nothing else', () => {
		// Given / When
		const nonRead = UFI_COMMANDS.filter(
			(command) => !command.startsWith('get') && command !== 'login',
		);

		// Then
		expect(nonRead).toEqual([]);
		expect(UFI_SESSION_COMMANDS).toEqual(['login']);
		expect(UFI_READ_COMMANDS.every((command) => command.startsWith('get'))).toBe(true);
	});

	test('every cmdid literal in the shipped source names a member of that vocabulary', () => {
		// Given
		const allowed = new Set<string>(UFI_COMMANDS);

		// When
		const literals = [...CODE.values()].flatMap((source) =>
			[...source.matchAll(/cmdid['"]?\s*:\s*['"]([a-zA-Z_]+)['"]/g)].map((match) => match[1] ?? ''),
		);

		// Then
		expect(literals.length).toBeGreaterThan(0);
		expect(literals.filter((literal) => !allowed.has(literal))).toEqual([]);
	});
});
