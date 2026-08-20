// The provider-matching conformance MATRIX.
//
// `conformance.test.ts` (todo 5) proves the matcher against a synthetic fixture provider;
// each provider suite (todos 22/24/25/26) proves one real provider in a registry
// containing only itself. Neither can answer the question a fleet actually poses: with
// ModemManager, Huawei HiLink, ZTE goform and UFI/HIMI ALL registered, does every device
// still reach exactly the provider and profile it is entitled to — and, more importantly,
// does no device reach one it is not?
//
// Every case here registers all four. The three providers a device does not belong to are
// scripted as devices that answer nothing they understand, which is what a real board
// looks like. The expectation is the exact decision — provider, profile, writability and
// evidence score — because a shape assertion cannot see a provider quietly claiming a
// neighbour's hardware.
//
// The matrix summary artifact is written from this file (test-results/, gitignored).

import { beforeAll, describe, expect, test } from 'bun:test';
import {
	CONFORMANCE_CASES,
	CONFORMANCE_CREDENTIALS,
	CORPUS_BODIES,
	type ConformanceRun,
	goformId,
	HILINK_TWIN_INTERFACE,
	MATRIX_MARKDOWN_PATH,
	type MatrixRow,
	observedExpectation,
	type RecordedExchange,
	SANITIZED_SUBSCRIBER_IDENTIFIERS,
	writeMatrixArtifact,
} from '../../test-support/conformance';
import { HILINK_PATHS } from './huawei-hilink/provider';

const runs = new Map<string, ConformanceRun>();
let rows: readonly MatrixRow[] = [];
let artifact = '';

const runOf = (id: string): ConformanceRun => {
	const run = runs.get(id);
	if (run === undefined) throw new Error(`conformance case did not run: ${id}`);
	return run;
};

const allExchanges = (run: ConformanceRun): readonly RecordedExchange[] => [
	...run.transcripts.hilink,
	...run.transcripts.hilinkTwin,
	...run.transcripts.zte,
	...run.transcripts.ufi,
];

const hilinkLogins = (run: ConformanceRun): readonly RecordedExchange[] =>
	run.transcripts.hilink.filter(
		(exchange) => exchange.method === 'POST' && exchange.path === HILINK_PATHS.login,
	);

const zteLogins = (run: ConformanceRun): readonly RecordedExchange[] =>
	run.transcripts.zte.filter((exchange) => exchange.method === 'POST');

beforeAll(async () => {
	const collected: MatrixRow[] = [];
	for (const entry of CONFORMANCE_CASES) {
		const run = await entry.run();
		runs.set(entry.id, run);
		const actual = observedExpectation(run.result);
		collected.push({
			id: entry.id,
			kind: entry.kind,
			summary: entry.summary,
			expected: entry.expected,
			actual,
			agrees: JSON.stringify(entry.expected) === JSON.stringify(actual),
		});
	}
	rows = collected;
	artifact = writeMatrixArtifact(collected);
});

describe('provider-matching conformance matrix', () => {
	test.each(CONFORMANCE_CASES.map((entry) => [entry.id] as const))(
		'%s reaches exactly its entitled decision',
		(id) => {
			// Given
			const entry = CONFORMANCE_CASES.find((candidate) => candidate.id === id);

			// When
			const actual = observedExpectation(runOf(id).result);

			// Then
			expect(actual).toEqual(entry?.expected as never);
		},
	);

	test('every case is present in the matrix exactly once', () => {
		// Given / When
		const ids = rows.map((row) => row.id);

		// Then
		expect(new Set(ids).size).toBe(CONFORMANCE_CASES.length);
		expect(rows.every((row) => row.agrees)).toBe(true);
	});

	test('the matrix artifact lists every case with its expected and actual decision', () => {
		// Given / When
		const document = artifact;

		// Then
		expect(document).toContain('# Provider-matching conformance matrix');
		expect(document).toContain(`Cases: **${CONFORMANCE_CASES.length}**`);
		for (const entry of CONFORMANCE_CASES) expect(document).toContain(entry.id);
		expect(MATRIX_MARKDOWN_PATH.endsWith('provider-conformance-matrix.md')).toBe(true);
	});
});

describe('conformance safety invariants', () => {
	test('no unresolved, malformed, expired, locked-out or misrouted case is ever writable', () => {
		// Given
		const unsafeToWrite = rows.filter((row) => row.kind !== 'fleet-profile');

		// When
		const writable = unsafeToWrite.filter((row) => row.actual.writable);

		// Then
		expect(unsafeToWrite.length).toBeGreaterThan(0);
		expect(writable).toEqual([]);
	});

	test('an unresolved decision carries no provider, no profile and no operations surface', () => {
		// Given
		const unresolved = rows.filter((row) => row.actual.status !== 'selected');

		// Then
		expect(unresolved.length).toBeGreaterThan(0);
		for (const row of unresolved) {
			const result = runOf(row.id).result;
			expect(result.provider).toBeNull();
			expect(result.profile).toBeNull();
			expect(result.operations).toBeNull();
			expect(result.writable).toBe(false);
			expect(result.evidence.length).toBeGreaterThan(0);
		}
	});

	test('no matcher result carries the credential the wire carried', () => {
		// Given / When
		const serialized = rows.map((row) => JSON.stringify(runOf(row.id).result));

		// Then
		for (const document of serialized) {
			expect(document).not.toContain(CONFORMANCE_CREDENTIALS.password);
		}
	});
});

describe('ambiguous collision — a tie never yields a write-capable pick', () => {
	const id = 'ambiguity/colliding-write-capable-twins';

	test('two write-capable providers sharing one fingerprint resolve read-only', () => {
		// Given
		const run = runOf(id);

		// Then
		expect(run.result.status).toBe('ambiguous');
		expect(run.result.provider).toBeNull();
		expect(run.result.operations).toBeNull();
		expect(run.result.writable).toBe(false);
	});

	test('the tie is decided BEFORE authentication, so neither credential is spent', () => {
		// Given
		const run = runOf(id);

		// Then
		expect(run.twinAuthAttempts).toBe(0);
		expect(hilinkLogins(run)).toEqual([]);
		expect(run.transcripts.hilinkTwin.filter((exchange) => exchange.method === 'POST')).toEqual([]);
	});

	test('the evidence ledger exposes BOTH colliding providers rather than hiding the tie', () => {
		// Given
		const run = runOf(id);

		// When
		const claimants = new Set(
			run.result.evidence
				.filter((item) => item.stage === 'passive-facts' && item.signal === 'match')
				.map((item) => item.provider),
		);

		// Then
		expect([...claimants].sort()).toEqual(['huawei-hilink', 'huawei-hilink-twin']);
		expect(
			run.result.evidence.some(
				(item) => item.stage === 'unauthenticated-fingerprint' && item.signal === 'match',
			),
		).toBe(true);
	});
});

describe('bounded credential attempts', () => {
	test('a mid-login 125002 refuses after exactly one login POST', () => {
		// Given
		const run = runOf('auth-expired/hilink-mid-login');

		// Then
		expect(hilinkLogins(run)).toHaveLength(1);
		expect(run.result.status).toBe('ambiguous');
	});

	test('an MF79U lockout is refused on one attempt and never re-tried as another algorithm', () => {
		// Given
		const run = runOf('lockout-unknown/zte-mf79u');

		// When
		const posts = zteLogins(run);

		// Then
		expect(posts).toHaveLength(1);
		expect(posts.map(goformId)).toEqual(['LOGIN']);
	});

	test('MF266-shaped answers to an MF79U login never provoke a salted retry', () => {
		// Given
		const run = runOf('ambiguity/zte-cross-profile-refusal');

		// When
		const posts = zteLogins(run);

		// Then
		expect(posts).toHaveLength(1);
		expect(posts.map(goformId)).toEqual(['LOGIN']);
	});

	test('unknown ZTE firmware reaches its read-only profile without any login POST', () => {
		// Given
		const run = runOf('unknown-firmware/zte-read-only');

		// Then
		expect(zteLogins(run)).toEqual([]);
		expect(run.result.profile).toBe('zte-unknown-read-only');
	});

	test('a USB id that is not a HIMI id never spends the UFI login', () => {
		// Given
		const nonHimi = [
			'fleet/huawei-e3372h-22.200',
			'fleet/zte-mf79u',
			'unknown-firmware/zte-read-only',
		];

		// Then
		for (const id of nonHimi) expect(runOf(id).transcripts.ufi).toEqual([]);
		expect(runOf('fleet/ufi-himi-9024').transcripts.ufi.length).toBeGreaterThan(0);
	});
});

describe('interface and transport routing', () => {
	test('reaching the wrong duplicate-IP twin refuses before login, still bound to that interface', () => {
		// Given
		const run = runOf('wrong-interface/hilink-duplicate-ip-twin');

		// Then
		expect(run.result.status).toBe('ambiguous');
		expect(hilinkLogins(run)).toEqual([]);
		expect(run.transcripts.hilink.length).toBeGreaterThan(0);
		expect(
			run.transcripts.hilink.every((exchange) => exchange.interfaceName === HILINK_TWIN_INTERFACE),
		).toBe(true);
		expect(
			run.result.conflicts.some(
				(item) => item.stage === 'authenticated-profile' && item.detail === 'profile-mismatch',
			),
		).toBe(true);
	});

	test('an ineligible transport is refused before ANY device is contacted', () => {
		// Given
		const run = runOf('wrong-transport/usb-request-reaches-nobody');

		// Then
		expect(allExchanges(run)).toEqual([]);
		expect(run.mmCalls).toEqual([]);
		expect(
			run.result.evidence.filter(
				(item) => item.stage === 'transport-eligibility' && item.signal === 'mismatch',
			),
		).toHaveLength(4);
	});

	test('a ModemManager-managed modem is never offered to a router-dialect provider', () => {
		// Given
		const run = runOf('fleet/mm-fm350-usb');

		// When
		const ineligible = run.result.evidence
			.filter((item) => item.stage === 'transport-eligibility' && item.signal === 'mismatch')
			.map((item) => item.provider)
			.sort();

		// Then
		expect(ineligible).toEqual(['huawei-hilink', 'ufi-himi', 'zte-goform']);
		expect(allExchanges(run)).toEqual([]);
	});
});

describe('corpus sanitization', () => {
	const SUBSCRIBER_DIGIT_RUN = /\d{14,}/g;
	const allowed = new Set(SANITIZED_SUBSCRIBER_IDENTIFIERS.map((entry) => entry.value));

	const unlisted = (documents: readonly string[]): readonly string[] =>
		documents
			.flatMap((document) => [...document.matchAll(SUBSCRIBER_DIGIT_RUN)])
			.map((match) => match[0])
			.filter((value) => !allowed.has(value));

	test('every subscriber-scale identifier in the corpus is a declared synthetic value', () => {
		// Given / When
		const found = unlisted(CORPUS_BODIES);

		// Then
		expect(found).toEqual([]);
		expect(SANITIZED_SUBSCRIBER_IDENTIFIERS.length).toBeGreaterThan(0);
		for (const entry of SANITIZED_SUBSCRIBER_IDENTIFIERS) {
			expect(entry.provenance.length).toBeGreaterThan(0);
		}
	});

	test('the detector trips on an undeclared identifier — it is not vacuous', () => {
		// Given
		const pasted = '{"params":{"IMSI":"310150123456789"}}';

		// When
		const found = unlisted([pasted]);

		// Then
		expect(found).toEqual(['310150123456789']);
	});

	test('every recorded request body across the whole matrix is sanitized too', () => {
		// Given
		const wire = rows.flatMap((row) =>
			allExchanges(runOf(row.id)).map((exchange) => JSON.stringify(exchange)),
		);

		// Then
		expect(wire.length).toBeGreaterThan(0);
		expect(unlisted(wire)).toEqual([]);
	});

	test('the corpus credential is a declared fixture literal, never a bench environment secret', () => {
		// Given
		const benchSecrets = ['MF79U_BENCH_PASSWORD', 'UFI_BENCH_PASSWORD']
			.map((name) => process.env[name])
			.filter((value): value is string => value !== undefined && value.length > 0);

		// Then
		expect(CONFORMANCE_CREDENTIALS.password).toContain('not-a-real-secret');
		for (const secret of benchSecrets) {
			for (const document of CORPUS_BODIES) expect(document).not.toContain(secret);
		}
	});
});
