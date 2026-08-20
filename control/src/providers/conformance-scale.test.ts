// SOFTWARE UPPER-BOUND fixture — 16 concurrently attached modems.
//
// READ THIS BEFORE QUOTING THE NUMBER. Sixteen is a FIXTURE result and nothing else: it
// says the observation, epoch, `Signal.Setup` and matching paths hold their shape at that
// count, measured against an in-memory ModemManager. It is NOT a bench measurement and
// must never be reported as one.
//
// The HARDWARE-VERIFIED figure remains the 8-device bench fleet from the predecessor
// evidence. Nothing here raises it; a hardware claim comes from the bench certification
// (todo 42), from a real board, with real modems attached.
//
// What the fixture is actually good for is the resource shape, which is where a fleet
// stack usually goes wrong: subscriptions must be FLEET-WIDE (four, forever) rather than
// per modem, `Signal.Setup` must be issued exactly once per (epoch, modem) rather than
// once per refresh, and sixteen concurrent matches must each answer about their OWN
// modem rather than a cached neighbour's.

import { afterEach, describe, expect, test } from 'bun:test';
import { FakeMmTransport } from '../../test-support/conformance';
import type { ModemSpec } from '../../test-support/fake-mm/object-model';
import { modemPath } from '../../test-support/fake-mm/object-model';
import { deviceGeneration, physicalModemId } from '../domain';
import { createProviderMatcher } from './matcher';
import { createModemManagerProvider, type ModemManagerProvider } from './modem-manager';
import { createProviderRegistry } from './registry';

/** Fixture-only. See the file header: the bench-verified fleet size is 8. */
const SOFTWARE_UPPER_BOUND_MODEMS = 16;
/** The figure that IS hardware-verified, kept here so the two are never conflated. */
const HARDWARE_VERIFIED_BENCH_FLEET = 8;

/** The four fleet-wide subscriptions the observer takes: three OM/props + NameOwnerChanged. */
const FLEET_WIDE_SUBSCRIPTIONS = 4;

const FIRST_INDEX = 101;

function fleet(count: number): readonly ModemSpec[] {
	return Array.from({ length: count }, (_, offset) => {
		const index = FIRST_INDEX + offset;
		return {
			index,
			manufacturer: 'Fake Modems Inc.',
			model: `Scale-${index}`,
			revision: '1.0-fixture',
			signalQuality: 40 + (offset % 50),
			sims: [
				{
					index,
					iccid: `890000000000000${String(index)}`,
					imsi: `00101000000${String(index)}`,
					active: true,
				},
			],
		} satisfies ModemSpec;
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('waitFor timed out');
		await Bun.sleep(5);
	}
}

describe('16 concurrently attached modems (VALIDATED UPPER BOUND — fixture, not hardware)', () => {
	let provider: ModemManagerProvider | undefined;

	afterEach(async () => {
		await provider?.stop();
		provider = undefined;
	});

	test('the fixture bound is declared as software-only and exceeds the bench-verified fleet', () => {
		// Given / When / Then
		expect(SOFTWARE_UPPER_BOUND_MODEMS).toBe(16);
		expect(HARDWARE_VERIFIED_BENCH_FLEET).toBe(8);
		expect(SOFTWARE_UPPER_BOUND_MODEMS).toBeGreaterThan(HARDWARE_VERIFIED_BENCH_FLEET);
	});

	test('all sixteen are observed, and the subscription count stays fleet-wide', async () => {
		// Given
		const transport = new FakeMmTransport({ modems: fleet(SOFTWARE_UPPER_BOUND_MODEMS) });
		provider = createModemManagerProvider({ transport });

		// When
		const list = await provider.start();

		// Then
		expect(list.ok).toBe(true);
		expect(list.rows).toHaveLength(SOFTWARE_UPPER_BOUND_MODEMS);
		expect(transport.subscriptionCount()).toBe(FLEET_WIDE_SUBSCRIPTIONS);
	});

	test('Signal.Setup is issued exactly once per modem for the epoch — never once per refresh', async () => {
		// Given
		const specs = fleet(SOFTWARE_UPPER_BOUND_MODEMS);
		const transport = new FakeMmTransport({ modems: specs });
		provider = createModemManagerProvider({ transport });

		// When
		await provider.start();
		await waitFor(() => transport.signalSetupCalls.length >= SOFTWARE_UPPER_BOUND_MODEMS);
		await Bun.sleep(20);

		// Then
		const paths = transport.signalSetupCalls.map((call) => call.path);
		expect(paths).toHaveLength(SOFTWARE_UPPER_BOUND_MODEMS);
		expect(new Set(paths).size).toBe(SOFTWARE_UPPER_BOUND_MODEMS);
		expect([...paths].sort()).toEqual(specs.map((spec) => modemPath(spec.index)).sort());
	});

	test('a burst of sixteen attachments is coalesced instead of refreshing once per event', async () => {
		// Given
		const specs = fleet(SOFTWARE_UPPER_BOUND_MODEMS);
		const transport = new FakeMmTransport();
		provider = createModemManagerProvider({ transport });
		await provider.start();
		const beforeBurst = transport.managedObjectsCalls.length;

		// When
		for (const spec of specs) transport.addModem(spec);
		await waitFor(() => transport.signalSetupCalls.length >= SOFTWARE_UPPER_BOUND_MODEMS);

		// Then
		const refreshes = transport.managedObjectsCalls.length - beforeBurst;
		expect(refreshes).toBeGreaterThan(0);
		expect(refreshes).toBeLessThan(SOFTWARE_UPPER_BOUND_MODEMS);
		expect(transport.subscriptionCount()).toBe(FLEET_WIDE_SUBSCRIPTIONS);
	});

	test('sixteen concurrent matches each answer about their OWN modem', async () => {
		// Given
		const specs = fleet(SOFTWARE_UPPER_BOUND_MODEMS);
		const transport = new FakeMmTransport({ modems: specs });
		provider = createModemManagerProvider({ transport });
		const registry = createProviderRegistry();
		registry.register(provider.definition);
		const matcher = createProviderMatcher(registry);

		// When
		const results = await Promise.all(
			specs.map((spec) =>
				matcher.match({
					physicalModemId: physicalModemId(`serial:fake-device-${spec.index}`),
					generation: deviceGeneration(1),
					transport: 'modemmanager',
					passiveFacts: [],
					composition: 'scale-fixture',
				}),
			),
		);

		// Then
		expect(results).toHaveLength(SOFTWARE_UPPER_BOUND_MODEMS);
		for (const [offset, result] of results.entries()) {
			expect(result.status).toBe('selected');
			expect(result.provider).toBe('modemmanager');
			expect(result.profile).toBe('generic-mm');
			expect(String(result.physicalModemId)).toBe(`serial:fake-device-${specs[offset]?.index}`);
		}
	});

	test('detaching and re-attaching modems grows no per-modem resource, and stop releases everything', async () => {
		// Given
		const specs = fleet(SOFTWARE_UPPER_BOUND_MODEMS);
		const transport = new FakeMmTransport({ modems: specs });
		provider = createModemManagerProvider({ transport });
		await provider.start();
		await waitFor(() => transport.signalSetupCalls.length >= SOFTWARE_UPPER_BOUND_MODEMS);

		// When
		for (const spec of specs.slice(0, 4)) transport.removeModem(spec.index);
		await Bun.sleep(20);
		for (const spec of specs.slice(0, 4)) transport.addModem(spec);
		await Bun.sleep(20);

		// Then
		expect(transport.subscriptionCount()).toBe(FLEET_WIDE_SUBSCRIPTIONS);
		// TOTAL, not a distinct count: churn inside ONE epoch re-drives the manager, and a
		// distinct-path assertion cannot tell a de-duped re-apply from sixteen extra calls.
		expect(transport.signalSetupCalls).toHaveLength(SOFTWARE_UPPER_BOUND_MODEMS);
		expect(
			transport.calls.some((call) => /Connect|CreateBearer|Disconnect/.test(call.member)),
		).toBe(false);

		await provider.stop();
		provider = undefined;
		expect(transport.subscriptionCount()).toBe(0);
	});

	test('a new daemon epoch re-applies Signal.Setup to every one of the sixteen survivors', async () => {
		// Given
		const transport = new FakeMmTransport({ modems: fleet(SOFTWARE_UPPER_BOUND_MODEMS) });
		provider = createModemManagerProvider({ transport });
		await provider.start();
		await waitFor(() => transport.signalSetupCalls.length >= SOFTWARE_UPPER_BOUND_MODEMS);

		// When
		transport.takeOverAs(':1.99');
		await waitFor(() => transport.signalSetupCalls.length >= SOFTWARE_UPPER_BOUND_MODEMS * 2);
		await Bun.sleep(20);

		// Then
		expect(transport.signalSetupCalls).toHaveLength(SOFTWARE_UPPER_BOUND_MODEMS * 2);
		expect(transport.subscriptionCount()).toBe(FLEET_WIDE_SUBSCRIPTIONS);
	});
});
