// Persistence contract — mode 0600 (real fs.stat), fail-soft corruption recovery
// with METADATA-ONLY logging, and the no-PII guarantee on the serialized bytes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createUsageFileStore,
	type PersistedUsage,
	USAGE_SCHEMA_VERSION,
	type UsageLogEvent,
} from './store';

let dir: string;
let path: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'usage-store-'));
	path = join(dir, 'usage.json');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const sample: PersistedUsage = {
	schemaVersion: USAGE_SCHEMA_VERSION,
	bootId: 'boot-uuid-1',
	savedAtMs: 1_700_000_000_000,
	slots: [
		{ logicalSlotId: 'slot-a', cycleBytes: 1234, cycleStartMs: 1_699_000_000_000 },
		{
			logicalSlotId: 'slot-b',
			cycleBytes: 42,
			cycleStartMs: 1_699_000_000_000,
			mappingGeneration: 2,
			ifname: 'wwan0',
			lastObserved: 999,
		},
	],
};

describe('UsageStore — versioned round-trip', () => {
	test('save then load returns identical, schema-versioned state', async () => {
		const store = createUsageFileStore({ path });
		await store.save(sample);
		const loaded = await store.load('boot-uuid-1', 1_700_000_100_000);
		expect(loaded.schemaVersion).toBe(USAGE_SCHEMA_VERSION);
		expect(loaded).toEqual(sample);
	});

	test('an absent file loads as fresh empty state (no write, no warning)', async () => {
		const events: UsageLogEvent[] = [];
		const store = createUsageFileStore({ path, logger: (e) => events.push(e) });
		const loaded = await store.load('boot-uuid-9', 5);
		expect(loaded.slots).toEqual([]);
		expect(loaded.bootId).toBe('boot-uuid-9');
		expect(events).toHaveLength(0);
	});
});

describe('UsageStore — mode 0600 via chmod-after-write', () => {
	test('the persisted file ends up owner-read/write only (real fs.stat)', async () => {
		const store = createUsageFileStore({ path });
		await store.save(sample);
		const info = await stat(path);
		expect(info.mode & 0o777).toBe(0o600);
	});
});

describe('UsageStore — fail-soft corruption recovery', () => {
	test('a corrupt file logs METADATA ONLY and recreates a fresh 0600 file', async () => {
		// Corrupt content carrying a secret-looking token we must never echo in the log.
		const corrupt = '{ this is not json ICCID=8988211000000123456 }';
		await writeFile(path, corrupt);
		const events: UsageLogEvent[] = [];
		const store = createUsageFileStore({ path, logger: (e) => events.push(e) });

		const loaded = await store.load('boot-uuid-2', 77);

		// Exactly one metadata-only warning.
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event?.kind).toBe('corrupt-state');
		expect(event?.bytes).toBe(Buffer.byteLength(corrupt, 'utf8'));
		expect(typeof event?.reason).toBe('string');
		// The log NEVER contains the raw content (no secret token leak).
		expect(JSON.stringify(event)).not.toContain('ICCID');
		expect(JSON.stringify(event)).not.toContain('8988211000000123456');

		// Fail-soft: fresh empty state returned and the file recreated at mode 0600.
		expect(loaded.slots).toEqual([]);
		expect(loaded.bootId).toBe('boot-uuid-2');
		const info = await stat(path);
		expect(info.mode & 0o777).toBe(0o600);

		// The recreated file is now valid — a second load is clean (no new warning).
		const reloaded = await store.load('boot-uuid-2', 78);
		expect(reloaded.slots).toEqual([]);
		expect(events).toHaveLength(1);
	});

	test('an incompatible schema version is treated as corruption and recreated', async () => {
		await writeFile(
			path,
			JSON.stringify({ schemaVersion: 999, bootId: 'x', savedAtMs: 0, slots: [] }),
		);
		const events: UsageLogEvent[] = [];
		const store = createUsageFileStore({ path, logger: (e) => events.push(e) });
		const loaded = await store.load('boot-uuid-3', 1);
		expect(events).toHaveLength(1);
		expect(events[0]?.reason).toContain('schemaVersion');
		expect(loaded.slots).toEqual([]);
	});
});

describe('UsageStore — no PII in the persisted bytes', () => {
	test('the serialized file contains only opaque ids and numbers', async () => {
		const store = createUsageFileStore({ path });
		await store.save(sample);
		const raw = await readFile(path, 'utf8');

		// No subscriber/device-identifying fields, by construction. Word-bounded so a
		// benign key like `mappingGeneration` (contains "pin") is not a false positive.
		expect(raw).not.toMatch(
			/\b(iccid|imsi|imei|eid|msisdn|operator|manufacturer|subscriber|pin|puk|password)\b/i,
		);

		// Every slot object exposes only the allowed keys; ids are opaque strings.
		const parsed = JSON.parse(raw) as PersistedUsage;
		const allowed = new Set([
			'logicalSlotId',
			'cycleBytes',
			'cycleStartMs',
			'mappingGeneration',
			'ifname',
			'lastObserved',
		]);
		for (const slot of parsed.slots) {
			for (const keyName of Object.keys(slot)) {
				expect(allowed.has(keyName)).toBe(true);
			}
			expect(typeof slot.logicalSlotId).toBe('string');
			expect(typeof slot.cycleBytes).toBe('number');
		}
	});
});
