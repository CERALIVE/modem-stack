import { describe, expect, test } from 'bun:test';

import {
	CAPABILITY_MODULES,
	type CapabilityModule,
	mayClaimSupport,
	mayRenderModule,
	resolveCapabilityMatrix,
	resolveSupportClaim,
	SUPPORT_CLAIM_STATES,
} from './support-claim';

const ALL: readonly CapabilityModule[] = CAPABILITY_MODULES;

describe('the support-claim ladder', () => {
	test('a module this build does not ship is unavailable, gate or no gate', () => {
		for (const gateEnabled of [false, true]) {
			expect(
				resolveSupportClaim({
					implemented: false,
					gateEnabled,
					capability: 'present',
					certified: true,
				}),
			).toBe('unavailable');
		}
	});

	test('each rung requires the one below it', () => {
		const base = { implemented: true, certified: false } as const;
		expect(resolveSupportClaim({ ...base, gateEnabled: false, capability: 'present' })).toBe(
			'implemented',
		);
		expect(resolveSupportClaim({ ...base, gateEnabled: true, capability: 'unknown' })).toBe(
			'enabled',
		);
		expect(resolveSupportClaim({ ...base, gateEnabled: true, capability: 'present' })).toBe(
			'capable',
		);
		expect(
			resolveSupportClaim({
				...base,
				gateEnabled: true,
				capability: 'present',
				certified: true,
			}),
		).toBe('certified');
	});

	test('a modem that positively LACKS the capability is unavailable, never enabled', () => {
		expect(
			resolveSupportClaim({
				implemented: true,
				gateEnabled: true,
				capability: 'absent',
				certified: true,
			}),
		).toBe('unavailable');
	});

	test('only capable/certified may be surfaced; only certified may be claimed', () => {
		expect(SUPPORT_CLAIM_STATES.filter(mayRenderModule)).toEqual(['capable', 'certified']);
		expect(SUPPORT_CLAIM_STATES.filter(mayClaimSupport)).toEqual(['certified']);
	});
});

describe('the seven-module matrix', () => {
	test('OFF BY DEFAULT: no gates leaves every shipped module at implemented', () => {
		const claims = resolveCapabilityMatrix({ implemented: ALL, gates: {}, capability: {} });
		for (const module of ALL) {
			expect(claims[module]).toBe('implemented');
			expect(mayRenderModule(claims[module])).toBe(false);
		}
	});

	test('an enabled gate on an INCAPABLE modem resolves unavailable', () => {
		const claims = resolveCapabilityMatrix({
			implemented: ALL,
			gates: { 'band-lock': true },
			capability: { 'band-lock': 'absent' },
		});
		expect(claims['band-lock']).toBe('unavailable');
	});

	test('the matrix is TOTAL — an unmentioned module still gets a state', () => {
		const claims = resolveCapabilityMatrix({ implemented: [], gates: {}, capability: {} });
		for (const module of ALL) {
			expect(claims[module]).toBe('unavailable');
		}
	});
});
