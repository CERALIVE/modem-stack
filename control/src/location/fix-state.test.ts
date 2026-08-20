// The GNSS display state machine — the two dishonest renders it makes impossible.
//
// These are the paths that are FULLY verifiable with no antenna and no sky, which
// is the whole point: the no-fix bound and the stale-fix drop are exactly what an
// operator with an unconnected GNSS connector will actually experience.

import { describe, expect, test } from 'bun:test';
import { epochMillis } from '../domain';
import type { FixRead, GnssFix } from '../ports';
import {
	advanceGnssFixState,
	DEFAULT_FIX_STATE_CONFIG,
	GNSS_OFF,
	type GnssFixState,
	type GnssFixStateConfig,
	isAcquiring,
	renderableFix,
} from './fix-state';

const CONFIG: GnssFixStateConfig = { acquireTimeoutMs: 10_000, fixTtlMs: 5_000 };

function fixAt(ms: number): GnssFix {
	return { latitude: 4.60971, longitude: -74.08175, observedAt: epochMillis(ms) };
}

const FIX_READ = (ms: number): FixRead => ({ outcome: 'fix', fix: fixAt(ms) });
const NO_FIX_READ: FixRead = { outcome: 'no-fix', reason: 'still searching' };

function run(events: readonly Parameters<typeof advanceGnssFixState>[1][]): GnssFixState {
	return events.reduce<GnssFixState>(
		(state, event) => advanceGnssFixState(state, event, CONFIG),
		GNSS_OFF,
	);
}

describe('bounded acquisition — the spinner always ends', () => {
	test('enabling starts a bounded wait, not an open-ended one', () => {
		const state = run([{ kind: 'gnss-enabled', at: epochMillis(0) }]);
		expect(state.kind).toBe('acquiring');
		expect(isAcquiring(state)).toBe(true);
	});

	test('a modem reporting no-fix INSIDE the bound is still legitimately acquiring', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'read', at: epochMillis(4_000), read: NO_FIX_READ },
			{ kind: 'read', at: epochMillis(9_999), read: NO_FIX_READ },
		]);
		expect(state.kind).toBe('acquiring');
	});

	test('at the bound the wait becomes an honest terminal no-fix — never a spinner', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'tick', at: epochMillis(10_000) },
		]);
		expect(state).toEqual({
			kind: 'no-fix',
			since: epochMillis(10_000),
			reason: 'acquire-timeout',
		});
		expect(isAcquiring(state)).toBe(false);
	});

	test('a read that lands exactly at the bound also ends the wait', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'read', at: epochMillis(10_000), read: NO_FIX_READ },
		]);
		expect(state.kind).toBe('no-fix');
	});

	test('an antenna-less modem NEVER reaches a renderable fix, however long it runs', () => {
		let state: GnssFixState = advanceGnssFixState(
			GNSS_OFF,
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			CONFIG,
		);
		for (let at = 1_000; at <= 600_000; at += 1_000) {
			state = advanceGnssFixState(
				state,
				{ kind: 'read', at: epochMillis(at), read: NO_FIX_READ },
				CONFIG,
			);
			state = advanceGnssFixState(state, { kind: 'tick', at: epochMillis(at) }, CONFIG);
			expect(renderableFix(state)).toBeUndefined();
		}
		expect(state.kind).toBe('no-fix');
	});
});

describe('stale-fix clearing — a coordinate is never shown past its life', () => {
	test('a fresh fix is renderable', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'read', at: epochMillis(1_000), read: FIX_READ(1_000) },
		]);
		expect(renderableFix(state)?.latitude).toBe(4.60971);
	});

	test('a fix older than its TTL is DROPPED, not merely marked stale', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'read', at: epochMillis(1_000), read: FIX_READ(1_000) },
			{ kind: 'tick', at: epochMillis(6_000) },
		]);
		expect(state).toEqual({ kind: 'no-fix', since: epochMillis(6_000), reason: 'fix-expired' });
		expect(renderableFix(state)).toBeUndefined();
		expect(JSON.stringify(state)).not.toContain('4.60971');
	});

	test('the modem losing its fix drops the held coordinates immediately', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'read', at: epochMillis(1_000), read: FIX_READ(1_000) },
			{ kind: 'read', at: epochMillis(2_000), read: NO_FIX_READ },
		]);
		expect(state).toEqual({ kind: 'no-fix', since: epochMillis(2_000), reason: 'reported-no-fix' });
		expect(renderableFix(state)).toBeUndefined();
	});

	test('a newer fix replaces an older one and restarts its life', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'read', at: epochMillis(1_000), read: FIX_READ(1_000) },
			{ kind: 'read', at: epochMillis(4_000), read: FIX_READ(4_000) },
			{ kind: 'tick', at: epochMillis(6_000) },
		]);
		expect(renderableFix(state)?.observedAt).toBe(epochMillis(4_000));
	});
});

describe('disable clears everything', () => {
	test('disabling drops a held fix and returns to off', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'read', at: epochMillis(1_000), read: FIX_READ(1_000) },
			{ kind: 'gnss-disabled' },
		]);
		expect(state).toEqual({ kind: 'off' });
		expect(renderableFix(state)).toBeUndefined();
		expect(JSON.stringify(state)).not.toContain('74.08175');
	});

	test('a read reporting the source is off also clears a held fix', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'read', at: epochMillis(1_000), read: FIX_READ(1_000) },
			{ kind: 'read', at: epochMillis(2_000), read: { outcome: 'disabled', reason: 'off' } },
		]);
		expect(state).toEqual({ kind: 'off' });
	});

	test('disabling from a timed-out wait also returns to off', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'tick', at: epochMillis(20_000) },
			{ kind: 'gnss-disabled' },
		]);
		expect(state).toEqual({ kind: 'off' });
	});
});

describe('unavailable is distinct from no-fix', () => {
	test('an unsupported modem is unavailable, never a no-fix wait', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{ kind: 'read', at: epochMillis(1_000), read: { outcome: 'unsupported', reason: 'no GNSS' } },
		]);
		expect(state).toEqual({ kind: 'unavailable', reason: 'no GNSS' });
	});

	test('a bus error is unavailable and carries its reason', () => {
		const state = run([
			{ kind: 'gnss-enabled', at: epochMillis(0) },
			{
				kind: 'read',
				at: epochMillis(1_000),
				read: { outcome: 'error', reason: 'GetLocation failed' },
			},
		]);
		expect(state).toEqual({ kind: 'unavailable', reason: 'GetLocation failed' });
	});
});

describe('the shipped defaults are bounded', () => {
	test('both bounds are finite and positive, so neither can hang a render', () => {
		expect(DEFAULT_FIX_STATE_CONFIG.acquireTimeoutMs).toBeGreaterThan(0);
		expect(Number.isFinite(DEFAULT_FIX_STATE_CONFIG.acquireTimeoutMs)).toBe(true);
		expect(DEFAULT_FIX_STATE_CONFIG.fixTtlMs).toBeGreaterThan(0);
		expect(Number.isFinite(DEFAULT_FIX_STATE_CONFIG.fixTtlMs)).toBe(true);
	});

	test('the machine is pure — advancing never mutates the state it was given', () => {
		const before: GnssFixState = { kind: 'fix', fix: fixAt(1_000) };
		const snapshot = JSON.stringify(before);
		advanceGnssFixState(before, { kind: 'tick', at: epochMillis(99_000) }, CONFIG);
		expect(JSON.stringify(before)).toBe(snapshot);
	});
});
