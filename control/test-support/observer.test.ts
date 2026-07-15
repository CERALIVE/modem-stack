// Epoch-scoped observer — lifecycle correctness against the A2.3 fake MM service.
//
// Proves the safety-critical contract (draft §Oracle round-3 #5): a modem is REMOVED
// only by omission from a current-epoch authoritative snapshot; owner loss, bus epoch
// change, and old-epoch straggler signals only ever mark it `sourceUnavailable`, never
// remove it. Runs under `dbus-run-session -- bun test control/test-support`.

import { afterEach, describe, expect, test } from 'bun:test';
import { createMmDbusObserver, type MmDbusObserver } from '../src/backend';
import type { CellularSnapshot } from '../src/domain';
import type { ObservationList } from '../src/ports';
import { createDbusTransport, type DbusTransport } from '../src/transport';
import { FakeModemManager, MODEM_IFACE, type ModemSpec, modemPath } from './fake-mm';
import { hasSessionBus, sessionBusAddress, warnSkippedWithoutBus } from './session-bus';

warnSkippedWithoutBus('epoch-scoped MM observer');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('waitFor timed out');
		}
		await sleep(5);
	}
}

const spec = (index: number): ModemSpec => ({
	index,
	sims: [
		{
			index,
			iccid: `890000000000000000${index}`,
			imsi: `00101000000000${index}`,
			active: true,
		},
	],
});

const rowFor = (list: ObservationList | undefined, index: number): CellularSnapshot | undefined =>
	list?.rows.find((row) => row.identity.runtimePath === modemPath(index));

const hasRow = (list: ObservationList | undefined, index: number): boolean =>
	rowFor(list, index) !== undefined;

describe.skipIf(!hasSessionBus())('MmDbusObserver — epoch-scoped lifecycle', () => {
	let fake: FakeModemManager;
	let transport: DbusTransport;
	let observer: MmDbusObserver;
	let lists: ObservationList[];

	const latest = (): ObservationList | undefined => lists.at(-1);

	async function boot(modems: readonly ModemSpec[]): Promise<void> {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, modems });
		transport = createDbusTransport({ busAddress });
		observer = createMmDbusObserver({ transport });
		lists = [];
		observer.observe((list) => lists.push(list));
	}

	afterEach(async () => {
		await observer.stop();
		await transport.disconnect();
		await fake.stop();
	});

	test('start() returns the first authoritative list; revisions are monotonic', async () => {
		await boot([spec(0)]);
		const first = await observer.start();
		expect(first.ok).toBe(true);
		expect(hasRow(first, 0)).toBe(true);
		const row = rowFor(first, 0);
		expect(row?.presence).toBe('present');
		expect(row?.sourceHealth).toBe('live');
		expect(row?.revision).toBeGreaterThan(0);
	});

	test('churn ×50 add/remove cycles keep the base modem; revisions never regress', async () => {
		await boot([spec(0)]);
		await observer.start();
		await waitFor(() => hasRow(latest(), 0));

		for (let cycle = 0; cycle < 50; cycle += 1) {
			fake.addModem(spec(1));
			await waitFor(() => hasRow(latest(), 1));
			fake.removeModem(1);
			await waitFor(() => !hasRow(latest(), 1));
			// The base modem is NEVER removed by the churn of its neighbour.
			expect(hasRow(latest(), 0)).toBe(true);
		}

		const lastRevByPath = new Map<string, number>();
		for (const list of lists) {
			for (const r of list.rows) {
				const prev = lastRevByPath.get(r.identity.runtimePath) ?? 0;
				expect(r.revision).toBeGreaterThanOrEqual(prev);
				lastRevByPath.set(r.identity.runtimePath, r.revision);
			}
		}
		expect(hasRow(latest(), 0)).toBe(true);
		expect(hasRow(latest(), 1)).toBe(false);
	}, 30_000);

	test('owner loss → sourceUnavailable (rows retained), reclaim → restored; zero removals', async () => {
		await boot([spec(0)]);
		await observer.start();
		await waitFor(() => hasRow(latest(), 0));

		await fake.dropName();
		await waitFor(() => latest()?.ok === false);
		const dropped = latest();
		expect(dropped?.ok).toBe(false);
		// The whole point: the modem is RETAINED, just stale — never removed.
		expect(hasRow(dropped, 0)).toBe(true);
		expect(rowFor(dropped, 0)?.sourceHealth).toBe('sourceUnavailable');

		await fake.reclaimName();
		await waitFor(() => latest()?.ok === true && rowFor(latest(), 0)?.sourceHealth === 'live');
		expect(hasRow(latest(), 0)).toBe(true);
	});

	test('restart mid-poll → zero removals, exactly one unavailable→restored cycle', async () => {
		await boot([spec(0)]);
		await observer.start();
		await waitFor(() => hasRow(latest(), 0));
		const startLen = lists.length;

		await fake.restart();
		// The unavailable state is transient — assert it appeared in the emission history,
		// then wait for the restore. (Polling `latest()` can skip a fast transient.)
		await waitFor(() =>
			lists.slice(startLen).some((l) => rowFor(l, 0)?.sourceHealth === 'sourceUnavailable'),
		);
		await waitFor(() => latest()?.ok === true && rowFor(latest(), 0)?.sourceHealth === 'live');

		// The modem is present in every emission after the restart — never removed.
		for (const list of lists.slice(startLen)) {
			expect(hasRow(list, 0)).toBe(true);
		}
		const healths = lists.slice(startLen).map((l) => rowFor(l, 0)?.sourceHealth);
		expect(healths).toContain('sourceUnavailable');
		expect(healths.at(-1)).toBe('live');
	});

	test('an invalidated PropertiesChanged is reconciled, not dropped', async () => {
		await boot([spec(0)]);
		await observer.start();
		await waitFor(() => hasRow(latest(), 0));

		// replaceSim changes the SERVED tree (new ICCID) and emits an invalidated
		// PropertiesChanged on the modem's `Sim` — the observer must re-read and reconcile.
		const newIccid = '8900000000000000999';
		fake.replaceSim(0, { index: 0, iccid: newIccid, imsi: '001010000000999', active: true });
		await waitFor(() => String(rowFor(latest(), 0)?.identity.subscriptionId) === newIccid);
		expect(hasRow(latest(), 0)).toBe(true);

		// A pure invalidated-only signal is handled gracefully: no removal, still ok.
		fake.invalidateProperties(modemPath(0), MODEM_IFACE, ['State']);
		await sleep(60);
		expect(hasRow(latest(), 0)).toBe(true);
		expect(latest()?.ok).toBe(true);
	});

	test('subscribe-before-snapshot race: a modem added during the initial poll is not lost', async () => {
		await boot([spec(0)]);
		fake.setReplyDelay(120);
		const starting = observer.start();
		await sleep(25);
		fake.addModem(spec(1));
		await starting;
		fake.setReplyDelay(0);
		await waitFor(() => hasRow(latest(), 0) && hasRow(latest(), 1));
		expect(latest()?.ok).toBe(true);
	});

	test('late reply from a superseded epoch is discarded, not applied', async () => {
		await boot([spec(0)]);
		await observer.start();
		await waitFor(() => hasRow(latest(), 0));

		fake.setReplyDelay(150);
		fake.changeProperties(modemPath(0), MODEM_IFACE, [['State', ['i', 7]]]);
		await sleep(25);
		const previous = await fake.restartRetainingPrevious();
		fake.setReplyDelay(0);

		await waitFor(() => rowFor(latest(), 0)?.sourceHealth === 'sourceUnavailable');
		await waitFor(() => latest()?.ok === true && rowFor(latest(), 0)?.sourceHealth === 'live');
		await sleep(200);
		// The old-epoch late reply must not have removed or corrupted the modem.
		expect(hasRow(latest(), 0)).toBe(true);
		expect(latest()?.ok).toBe(true);
		await previous.stop();
	});

	test('order 1 — removed-then-restart: removal sticks, survivor restores, no resurrection', async () => {
		await boot([spec(0), spec(1)]);
		await observer.start();
		await waitFor(() => hasRow(latest(), 0) && hasRow(latest(), 1));

		fake.removeModem(1);
		await waitFor(() => !hasRow(latest(), 1));
		const startLen = lists.length;

		await fake.restart();
		await waitFor(() =>
			lists.slice(startLen).some((l) => rowFor(l, 0)?.sourceHealth === 'sourceUnavailable'),
		);
		await waitFor(() => latest()?.ok === true && rowFor(latest(), 0)?.sourceHealth === 'live');

		expect(hasRow(latest(), 0)).toBe(true);
		// The legitimately-removed modem is NOT resurrected by the restart.
		expect(hasRow(latest(), 1)).toBe(false);
	});

	test('order 2 — restart-then-late-old-owner-removed: stale removal is IGNORED', async () => {
		await boot([spec(0)]);
		await observer.start();
		await waitFor(() => hasRow(latest(), 0));

		const previous = await fake.restartRetainingPrevious();
		await waitFor(() => latest()?.ok === true && rowFor(latest(), 0)?.sourceHealth === 'live');
		expect(hasRow(latest(), 0)).toBe(true);

		// An InterfacesRemoved from the OLD owner arrives late — it must be ignored.
		previous.removeModem(0);
		await sleep(150);
		expect(hasRow(latest(), 0)).toBe(true);
		expect(rowFor(latest(), 0)?.sourceHealth).toBe('live');
		await previous.stop();
	});
});
