import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { physicalModemId } from '../domain';
import {
	decodeLegacyCeraUiEntry,
	LEGACY_CERAUI_MUTATION_STATES,
	legacyMutationSlotName,
	legacyOperationRecord,
	readLegacyCeraUiJournal,
} from './legacy-ceraui';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'ceraui-journal-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const STABLE_KEY = 'usb-pci-0000:00:14.0-usb-0:2:1.0';

function legacyDocument(overrides: Record<string, unknown> = {}): string {
	// Byte-faithful to what CeraUI writes: one JSON object plus a trailing newline.
	return `${JSON.stringify({
		version: 1,
		stableKey: STABLE_KEY,
		kind: 'usb-mode',
		state: 'executing',
		attemptId: 'attempt-abc',
		startedAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_500,
		preState: { mode: 'rndis' },
		history: [{ state: 'armed', at: 1_700_000_000_000 }],
		...overrides,
	})}\n`;
}

async function writeSlot(key: string, body: string): Promise<string> {
	const name = `${legacyMutationSlotName(key)}.json`;
	await writeFile(join(dir, name), body);
	return name;
}

describe('the legacy slot filename convention is mirrored, not guessed', () => {
	test('the slot name is lowercase-hex sha256 of the stable key', () => {
		const name = legacyMutationSlotName(STABLE_KEY);
		expect(name).toMatch(/^[0-9a-f]{64}$/);
		expect(name).toBe(legacyMutationSlotName(STABLE_KEY));
		expect(name).not.toBe(legacyMutationSlotName(`${STABLE_KEY}x`));
	});

	test('the stable key never appears in the filename in plaintext', () => {
		expect(legacyMutationSlotName(STABLE_KEY)).not.toContain('usb');
	});
});

describe('an existing CeraUI journal file is still readable', () => {
	test('a real-shaped slot decodes with every field preserved', async () => {
		const decoded = decodeLegacyCeraUiEntry(legacyDocument());
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value).toEqual({
			version: 1,
			stableKey: STABLE_KEY,
			kind: 'usb-mode',
			state: 'executing',
			attemptId: 'attempt-abc',
			startedAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_500,
			preState: { mode: 'rndis' },
			history: [{ state: 'armed', at: 1_700_000_000_000 }],
		});
	});

	test('the opaque preState rollback payload survives the read verbatim', async () => {
		await writeSlot(
			STABLE_KEY,
			legacyDocument({ preState: { mode: 'rndis', nested: { a: [1] } } }),
		);
		const read = await readLegacyCeraUiJournal({ dir });
		expect(read.entries[0]?.preState).toEqual({ mode: 'rndis', nested: { a: [1] } });
	});

	test('the trailing newline CeraUI writes is accepted', async () => {
		expect(decodeLegacyCeraUiEntry(legacyDocument()).ok).toBe(true);
		expect(decodeLegacyCeraUiEntry(legacyDocument().trimEnd()).ok).toBe(true);
	});

	test('optional detail and acknowledgedMode round-trip when present', () => {
		const decoded = decodeLegacyCeraUiEntry(
			legacyDocument({
				state: 'acknowledged',
				detail: 'rolled back',
				acknowledgedMode: 'force-rebaseline',
			}),
		);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.detail).toBe('rolled back');
		expect(decoded.value.acknowledgedMode).toBe('force-rebaseline');
	});

	test('an unmentioned optional key is ABSENT, not undefined-valued', () => {
		const decoded = decodeLegacyCeraUiEntry(legacyDocument());
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect('detail' in decoded.value).toBe(false);
		expect('acknowledgedMode' in decoded.value).toBe(false);
	});
});

describe('the legacy vocabulary maps onto the shared recovery model', () => {
	test('every state has a disposition, so no state can fall through', () => {
		for (const state of LEGACY_CERAUI_MUTATION_STATES) {
			const decoded = decodeLegacyCeraUiEntry(legacyDocument({ state }));
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) continue;
			expect(legacyOperationRecord(decoded.value).disposition).toBeDefined();
		}
	});

	test('armed is pending but executing is unknown-outcome', () => {
		const armed = decodeLegacyCeraUiEntry(legacyDocument({ state: 'armed' }));
		const executing = decodeLegacyCeraUiEntry(legacyDocument({ state: 'executing' }));
		expect(armed.ok && legacyOperationRecord(armed.value).disposition).toBe('pending');
		expect(executing.ok && legacyOperationRecord(executing.value).disposition).toBe(
			'unknown-outcome',
		);
	});

	test('an unknown-outcome legacy record claims NO reason it cannot know', () => {
		const executing = decodeLegacyCeraUiEntry(legacyDocument({ state: 'executing' }));
		expect(executing.ok).toBe(true);
		if (!executing.ok) return;
		const record = legacyOperationRecord(executing.value);
		expect(record.disposition).toBe('unknown-outcome');
		expect('outcome' in record).toBe(false);
	});

	test('operator-blocked states are blocked, never resolved and never unknown', () => {
		for (const state of [
			'failed',
			'device-absent-quarantine',
			'decommissioned',
			'recommission-pending',
		] as const) {
			const decoded = decodeLegacyCeraUiEntry(legacyDocument({ state }));
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) continue;
			expect(legacyOperationRecord(decoded.value).disposition).toBe('blocked');
		}
	});

	test('a legacy record carries CeraUI stableKey and is labelled legacy-ceraui', () => {
		const decoded = decodeLegacyCeraUiEntry(legacyDocument());
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		const record = legacyOperationRecord(decoded.value);
		expect(record.origin).toBe('legacy-ceraui');
		expect(record.physicalModemId).toBe(STABLE_KEY);
		// The identity is deliberately NOT laundered into a branded PhysicalModemId:
		// the constructor refuses it, which is exactly why the record keeps text.
		expect(() => physicalModemId(record.physicalModemId)).toThrow();
	});

	test('the descriptor evidence states what the file cannot supply', () => {
		const decoded = decodeLegacyCeraUiEntry(legacyDocument({ kind: 'sim-unlock' }));
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(legacyOperationRecord(decoded.value).descriptor).toEqual({
			descriptorId: 'sim-unlock',
			provider: 'ceraui-legacy',
			authority: 'controller',
			mutationImpact: 'write',
			profiles: [],
			firmware: [],
			confidence: 'unknown',
		});
	});

	test('an unknown future mutation kind is ACCEPTED, not refused', () => {
		// CeraUI spreads its capability-module kinds into the runtime enum, so a
		// frozen copy here would reject a valid file the day a module is added.
		const decoded = decodeLegacyCeraUiEntry(legacyDocument({ kind: 'some-future-module' }));
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(legacyOperationRecord(decoded.value).descriptor.descriptorId).toBe('some-future-module');
	});
});

describe('reading a whole legacy directory', () => {
	test('pending and unknown-outcome slots enumerate for reconciliation', async () => {
		await writeSlot('modem-armed', legacyDocument({ stableKey: 'modem-armed', state: 'armed' }));
		await writeSlot(
			'modem-executing',
			legacyDocument({ stableKey: 'modem-executing', state: 'executing' }),
		);
		await writeSlot('modem-done', legacyDocument({ stableKey: 'modem-done', state: 'completed' }));
		await writeSlot('modem-failed', legacyDocument({ stableKey: 'modem-failed', state: 'failed' }));

		const { recovery } = await readLegacyCeraUiJournal({ dir });
		expect(recovery.records).toHaveLength(4);
		expect(recovery.pending.map((record) => record.physicalModemId)).toEqual(['modem-armed']);
		expect(recovery.unknownOutcome.map((record) => record.physicalModemId)).toEqual([
			'modem-executing',
		]);
		expect(recovery.blocked.map((record) => record.physicalModemId)).toEqual(['modem-failed']);
		expect(recovery.reconciliationRequired).toEqual(['modem-armed', 'modem-executing']);
	});

	test('a blocked slot is NOT folded into reconciliation', async () => {
		await writeSlot('modem-failed', legacyDocument({ stableKey: 'modem-failed', state: 'failed' }));
		const { recovery } = await readLegacyCeraUiJournal({ dir });
		expect(recovery.reconciliationRequired).toEqual([]);
	});

	test('a corrupt slot is reported and the readable ones still come back', async () => {
		await writeSlot('modem-good', legacyDocument({ stableKey: 'modem-good' }));
		const badName = await writeSlot('modem-bad', '{not json');

		const { recovery, entries } = await readLegacyCeraUiJournal({ dir });
		expect(entries.map((entry) => entry.stableKey)).toEqual(['modem-good']);
		expect(recovery.damage).toHaveLength(1);
		expect(recovery.damage[0]?.location).toEqual({ kind: 'slot', slot: badName });
		expect(recovery.damage[0]?.failure.code).toBe('invalid-json');
	});

	test('a corrupt slot is LEFT IN PLACE, exactly as CeraUI leaves it', async () => {
		const badName = await writeSlot('modem-bad', '{not json');
		await readLegacyCeraUiJournal({ dir });
		expect(await readFile(join(dir, badName), 'utf8')).toBe('{not json');
	});

	test('non-json files in the directory are ignored', async () => {
		await writeFile(join(dir, 'README.txt'), 'not a slot');
		await writeSlot('modem-good', legacyDocument({ stableKey: 'modem-good' }));
		const { recovery } = await readLegacyCeraUiJournal({ dir });
		expect(recovery.records).toHaveLength(1);
		expect(recovery.damage).toEqual([]);
	});

	test('an absent directory reads as empty, not as damaged', async () => {
		const { recovery, entries } = await readLegacyCeraUiJournal({ dir: join(dir, 'nope') });
		expect(entries).toEqual([]);
		expect(recovery.records).toEqual([]);
		expect(recovery.damage).toEqual([]);
	});

	test('a wrong-version document is typed as a version mismatch', async () => {
		await writeSlot('modem-v2', legacyDocument({ version: 2 }));
		const { recovery } = await readLegacyCeraUiJournal({ dir });
		expect(recovery.damage[0]?.failure).toEqual({ code: 'unsupported-schema-version' });
	});

	test('a history array over the cap is refused by field name', async () => {
		await writeSlot(
			'modem-history',
			legacyDocument({
				history: Array.from({ length: 33 }, () => ({ state: 'armed', at: 1 })),
			}),
		);
		const { recovery } = await readLegacyCeraUiJournal({ dir });
		expect(recovery.damage[0]?.failure).toEqual({ code: 'schema-mismatch', field: 'history' });
	});
});
