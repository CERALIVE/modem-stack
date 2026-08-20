import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	createFccUnlockPolicyFileStore,
	enabledFccUnlockKeys,
	FCC_UNLOCK_POLICY_PATH,
	FCC_UNLOCK_SCHEMA_VERSION,
	type FccUnlockLogEvent,
	isFccUnlockEnabled,
} from './policy-store';
import { setFccUnlockPolicy } from './policy-write';

const dirs: string[] = [];

async function scratch(): Promise<string> {
	// mkdtemp, not a fixed path: two checkouts of this repo may run the suite at once.
	const dir = await mkdtemp(join(tmpdir(), 'ceralive-fcc-'));
	dirs.push(dir);
	return join(dir, 'fcc-unlock-policy.json');
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('the policy of record', () => {
	it('Given the pinned path, When it is read, Then it is under /data so a slot swap cannot take it', () => {
		expect(FCC_UNLOCK_POLICY_PATH.startsWith('/data/')).toBe(true);
	});

	it('Given no file at all, When the policy loads, Then it is empty and nothing is enabled', async () => {
		const path = await scratch();
		const state = await createFccUnlockPolicyFileStore({ path }).load(1);
		expect(state.unlock).toEqual({});
		expect(enabledFccUnlockKeys(state)).toEqual([]);
		expect(isFccUnlockEnabled(state, '2c7c:0801')).toBe(false);
	});

	it('Given a saved policy, When it is reloaded, Then it round-trips at mode 0600', async () => {
		const path = await scratch();
		const store = createFccUnlockPolicyFileStore({ path });
		await store.save({
			schemaVersion: FCC_UNLOCK_SCHEMA_VERSION,
			savedAtMs: 7,
			unlock: { '2c7c:0801': true, '1199:9079': false },
		});
		const state = await store.load(9);
		expect(state.savedAtMs).toBe(7);
		expect(enabledFccUnlockKeys(state)).toEqual(['2c7c:0801']);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	// Whole-document rejection, matching the shell reconciler's own judgement: a
	// half-applied regulatory-unlock policy is a policy nobody wrote.
	it.each([
		['invalid JSON', '{ not json'],
		['a wrong schema version', '{"schemaVersion":99,"savedAtMs":1,"unlock":{}}'],
		['a vendor-only key', '{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c":true}}'],
		['a non-boolean answer', '{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c:0801":"yes"}}'],
		['an array for unlock', '{"schemaVersion":1,"savedAtMs":1,"unlock":[]}'],
	])(
		'Given %s, When the policy loads, Then it reads as empty and the damaged bytes are KEPT',
		async (_name, body) => {
			const path = await scratch();
			await writeFile(path, body);
			const events: FccUnlockLogEvent[] = [];
			const state = await createFccUnlockPolicyFileStore({
				path,
				logger: (event) => events.push(event),
			}).load(1);

			expect(state.unlock).toEqual({});
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('corrupt-policy');
			// Metadata only — the reason names a field or an offset, never content.
			expect(events[0]?.reason).not.toContain('2c7c');
			// The evidence stays on disk for whoever has to diagnose it.
			expect(await readFile(path, 'utf8')).toBe(body);
		},
	);
});

describe('setFccUnlockPolicy', () => {
	it('Given a covered model, When it is enabled, Then it is persisted and reported as changed', async () => {
		const path = await scratch();
		const store = createFccUnlockPolicyFileStore({ path });
		const result = await setFccUnlockPolicy(
			{ vid: '2C7C', pid: '0801', enabled: true },
			{ store, now: () => 42 },
		);

		expect(result).toMatchObject({ status: 'applied', key: '2c7c:0801', changed: true });
		expect(enabledFccUnlockKeys(await store.load(0))).toEqual(['2c7c:0801']);
	});

	// An unchanged write must not cost a modem re-probe.
	it('Given an already-enabled model, When it is enabled again, Then changed is false', async () => {
		const path = await scratch();
		const store = createFccUnlockPolicyFileStore({ path });
		await setFccUnlockPolicy({ vid: '2c7c', pid: '0801', enabled: true }, { store });
		const again = await setFccUnlockPolicy({ vid: '2c7c', pid: '0801', enabled: true }, { store });
		expect(again).toMatchObject({ status: 'applied', changed: false });
	});

	// The whole point of the coverage gate: an enabled toggle that provably cannot do
	// anything is worse than a refusal the operator can read.
	it('Given a model ModemManager ships no procedure for, When it is enabled, Then it is rejected not-covered', async () => {
		const path = await scratch();
		const store = createFccUnlockPolicyFileStore({ path });
		const result = await setFccUnlockPolicy({ vid: '12d1', pid: '14dc', enabled: true }, { store });
		expect(result).toEqual({ status: 'rejected', reason: 'not-covered' });
		expect((await store.load(0)).unlock).toEqual({});
	});

	// A fail-closed opt-OUT is not a thing.
	it('Given an uncovered model, When it is DISABLED, Then the write is accepted', async () => {
		const path = await scratch();
		const store = createFccUnlockPolicyFileStore({ path });
		const result = await setFccUnlockPolicy(
			{ vid: '12d1', pid: '14dc', enabled: false },
			{ store },
		);
		expect(result).toMatchObject({ status: 'applied', enabled: false });
	});

	it('Given a malformed id, When it is written, Then it is rejected before any disk write', async () => {
		const path = await scratch();
		const store = createFccUnlockPolicyFileStore({ path });
		const result = await setFccUnlockPolicy({ vid: 'nope', pid: '0801', enabled: true }, { store });
		expect(result).toEqual({ status: 'rejected', reason: 'invalid-vid-pid' });
		expect((await store.load(0)).unlock).toEqual({});
	});

	it('Given two enabled models, When one is disabled, Then the other survives and the opt-out is recorded', async () => {
		const path = await scratch();
		const store = createFccUnlockPolicyFileStore({ path });
		await setFccUnlockPolicy({ vid: '2c7c', pid: '0801', enabled: true }, { store });
		await setFccUnlockPolicy({ vid: '1199', pid: '9079', enabled: true }, { store });
		await setFccUnlockPolicy({ vid: '2c7c', pid: '0801', enabled: false }, { store });

		const state = await store.load(0);
		expect(enabledFccUnlockKeys(state)).toEqual(['1199:9079']);
		expect(state.unlock['2c7c:0801']).toBe(false);
	});
});
