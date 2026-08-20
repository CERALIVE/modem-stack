// EXPLICIT no-SIM evidence — the regression this suite locks down.
//
// "There is no SIM" and "we could not tell" are read off the SAME empty fields, and
// only the evidence separates them. The failure mode is silent and expensive: an
// operator is told to re-seat a SIM that is already seated, or a slot switch in
// flight is reported as a missing card. So `absent` is reachable through exactly ONE
// evidence kind here, and the control cases below prove nothing else produces it.

import { describe, expect, test } from 'bun:test';
import {
	fixtureContext,
	HILINK_FIXTURE,
	MM_FIXTURE,
	UFI_FIXTURE,
	ZTE_FIXTURE,
} from '../../test-support/observation-fixtures';
import { decodeStateFailedReason } from '../domain';
import { deriveSimPresence, readSimPresence } from '../hardware/router-parsers';
import { viewEnvelope } from './envelope';
import type { NormalizedModemObservation } from './model';
import { normalizeHilinkObservation } from './sources/hilink';
import { normalizeModemManagerObservation } from './sources/modemmanager';
import { normalizeUfiObservation } from './sources/ufi';
import { normalizeZteObservation } from './sources/zte';

const SIM_PATH = '/org/freedesktop/ModemManager1/SIM/0';

/** A modem with no SIM, exactly as ModemManager 1.24 reports one: `/` plus a `u` reason. */
const NO_SIM_MODEM = {
	Model: 'RM530N-GL',
	Manufacturer: 'Quectel',
	State: -1,
	StateFailedReason: 2,
	Sim: '/',
	SimSlots: ['/'],
};

/** The SAME modem before it failed: blank SIM path, and NO failure reason at all. */
const BLANK_SIM_MODEM = {
	Model: 'RM530N-GL',
	Manufacturer: 'Quectel',
	State: 1,
	Sim: '/',
	SimSlots: ['/'],
};

/** The normalized value, or a hard failure — an unavailable envelope answers nothing here. */
function valued(
	envelope: ReturnType<typeof normalizeModemManagerObservation>,
): NormalizedModemObservation {
	const view = viewEnvelope(envelope);
	if (view.kind !== 'valued' || view.freshness.state !== 'fresh') {
		throw new Error('expected a fresh, valued observation');
	}
	return view.value;
}

const observe = (modem: Record<string, unknown>) =>
	normalizeModemManagerObservation({ modem: modem as never, sim: {} }, fixtureContext());

const simOf = (modem: Record<string, unknown>) => valued(observe(modem)).sim;

describe('the presence rule itself', () => {
	test('`absent` comes from the failure reason and from nothing else', () => {
		expect(readSimPresence({ failedReason: 'sim-missing' })).toEqual({
			presence: 'absent',
			evidence: { kind: 'state-failed-reason', field: 'failedReason', value: 'sim-missing' },
		});
	});

	test('a blank SIM path with no reason is UNKNOWN, never absent', () => {
		expect(readSimPresence({ sim: '/', simSlots: ['/'] })).toEqual({
			presence: 'unknown',
			evidence: { kind: 'no-evidence', inspected: ['sim', 'simSlots', 'failedReason'] },
		});
	});

	test('a completely empty fact set is UNKNOWN, never absent', () => {
		expect(readSimPresence({}).presence).toBe('unknown');
	});

	test('a failure reason that is not `sim-missing` proves nothing about the SIM', () => {
		for (const failedReason of ['sim-error', 'unknown-capabilities', 'esim-without-profiles']) {
			expect(readSimPresence({ sim: '/', failedReason }).presence).toBe('unknown');
		}
	});

	test('presence is proven by an object path, and the path is named as the evidence', () => {
		expect(readSimPresence({ sim: SIM_PATH })).toEqual({
			presence: 'present',
			evidence: { kind: 'sim-object-path', field: 'sim', value: SIM_PATH },
		});
		expect(readSimPresence({ sim: '/', simSlots: ['/', SIM_PATH] })).toEqual({
			presence: 'present',
			evidence: { kind: 'sim-slot-object-path', field: 'simSlots', value: SIM_PATH },
		});
	});

	test('an active SIM outranks a `sim-missing` reason left over from an earlier failure', () => {
		expect(readSimPresence({ sim: SIM_PATH, failedReason: 'sim-missing' }).presence).toBe(
			'present',
		);
	});

	test('the migrated `deriveSimPresence` answers identically', () => {
		for (const facts of [
			{ failedReason: 'sim-missing' },
			{ sim: '/', simSlots: ['/'] },
			{ sim: SIM_PATH },
			{},
		]) {
			expect(deriveSimPresence(facts)).toBe(readSimPresence(facts).presence);
		}
	});
});

describe('the D-Bus numeric failure reason is decoded, which is what makes absence readable', () => {
	test('MMModemStateFailedReason 2 is `sim-missing`', () => {
		expect(decodeStateFailedReason(2)).toBe('sim-missing');
	});

	test('the other members decode to themselves and none of them is `sim-missing`', () => {
		expect(decodeStateFailedReason(0)).toBe('none');
		expect(decodeStateFailedReason(1)).toBe('unknown-reason');
		expect(decodeStateFailedReason(3)).toBe('sim-error');
		expect(decodeStateFailedReason(4)).toBe('unknown-capabilities');
		expect(decodeStateFailedReason(5)).toBe('esim-without-profiles');
	});

	test('a value this build cannot place proves nothing', () => {
		expect(decodeStateFailedReason(99)).toBeUndefined();
		expect(decodeStateFailedReason(undefined)).toBeUndefined();
	});
});

describe('ModemManager observation — the no-SIM regression', () => {
	test('a `u` StateFailedReason of 2 yields an EXPLICIT absent reading', () => {
		const sim = simOf(NO_SIM_MODEM);
		expect(sim.presence).toEqual({
			state: 'known',
			value: 'absent',
			provenance: expect.objectContaining({ source: 'modemmanager' }),
		});
		expect(sim.presenceEvidence).toEqual({
			kind: 'state-failed-reason',
			field: 'failedReason',
			value: 'sim-missing',
		});
	});

	test('THE CONTROL: the same blank fields WITHOUT the reason are never absent', () => {
		const sim = simOf(BLANK_SIM_MODEM);
		expect(sim.presence.state).toBe('unknown');
		expect(sim.presenceEvidence.kind).toBe('no-evidence');
		if (sim.presence.state !== 'unknown') return;
		expect(sim.presence.reason).toBe('not-reported');
	});

	test('an unknown presence carries a READ-class reason, so a control is not hidden', () => {
		const sim = simOf(BLANK_SIM_MODEM);
		if (sim.presence.state !== 'unknown') throw new Error('expected unknown');
		expect(sim.presence.reason).not.toBe('unsupported');
	});

	test('the raw failure reason is retained verbatim in the diagnostics block', () => {
		const envelope = observe(NO_SIM_MODEM);
		expect(valued(envelope).diagnostics.raw['Modem.StateFailedReason']).toBe(2);
	});

	test('a present SIM names the object path that proved it', () => {
		const sim = simOf(MM_FIXTURE.modem as Record<string, unknown>);
		expect(sim.presence).toMatchObject({ state: 'known', value: 'present' });
		expect(sim.presenceEvidence).toEqual({
			kind: 'sim-object-path',
			field: 'sim',
			value: SIM_PATH,
		});
	});
});

describe('router sources never claim a presence and say which code they left alone', () => {
	test('HiLink names its own `SimStatus` without decoding it', () => {
		const envelope = normalizeHilinkObservation(HILINK_FIXTURE, fixtureContext());
		expect(valued(envelope).sim.presence.state).toBe('unknown');
		expect(valued(envelope).sim.presenceEvidence).toEqual({
			kind: 'vendor-code-unclaimed',
			field: 'monitoring-status.SimStatus',
		});
	});

	test('a vendor code that is named is still UNMAPPED — retained, not consumed', () => {
		const envelope = normalizeHilinkObservation(HILINK_FIXTURE, fixtureContext());
		expect(valued(envelope).diagnostics.unmapped).toContain('monitoring-status.SimStatus');
		expect(valued(envelope).diagnostics.consumed).not.toContain('monitoring-status.SimStatus');
	});

	test('ZTE and UFI report an unknown presence with no evidence of absence', () => {
		for (const envelope of [
			normalizeZteObservation(ZTE_FIXTURE, fixtureContext()),
			normalizeUfiObservation(UFI_FIXTURE, fixtureContext()),
		]) {
			expect(valued(envelope).sim.presence.state).toBe('unknown');
			expect(valued(envelope).sim.presenceEvidence.kind).not.toBe('state-failed-reason');
		}
	});

	test('NO source can produce `absent` from a router payload', () => {
		for (const envelope of [
			normalizeHilinkObservation(HILINK_FIXTURE, fixtureContext()),
			normalizeZteObservation(ZTE_FIXTURE, fixtureContext()),
			normalizeUfiObservation(UFI_FIXTURE, fixtureContext()),
		]) {
			expect(valued(envelope).sim.presence).not.toMatchObject({ value: 'absent' });
		}
	});
});

describe('signal normalization is finalized on the same layer', () => {
	test('ModemManager`s `(ub)` SignalQuality decodes BOTH members', () => {
		const envelope = normalizeModemManagerObservation(
			{ modem: { SignalQuality: [71, true] } },
			fixtureContext(),
		);
		expect(valued(envelope).signal.quality).toMatchObject({ state: 'known', value: 71 });
		expect(valued(envelope).signal.qualityRecent).toMatchObject({ state: 'known', value: true });
	});

	test('the `(ub)` pair is retained VERBATIM in the diagnostics block', () => {
		const envelope = normalizeModemManagerObservation(
			{ modem: { SignalQuality: [71, false] } },
			fixtureContext(),
		);
		expect(valued(envelope).diagnostics.raw['Modem.SignalQuality']).toEqual([71, false]);
		expect(valued(envelope).signal.qualityRecent).toMatchObject({ state: 'known', value: false });
	});

	test('a flattened percentage still decodes, and the flag reads as a READ-class unknown', () => {
		const envelope = normalizeModemManagerObservation(
			{ modem: { SignalQuality: 71 } },
			fixtureContext(),
		);
		expect(valued(envelope).signal.quality).toMatchObject({ state: 'known', value: 71 });
		expect(valued(envelope).signal.qualityRecent).toMatchObject({
			state: 'unknown',
			reason: 'not-reported',
		});
	});

	test('`CurrentModes` decodes from its `(uu)` pair as well as from a flat mask', () => {
		for (const currentModes of [[(1 << 3) | (1 << 4), 0], (1 << 3) | (1 << 4)]) {
			const envelope = normalizeModemManagerObservation(
				{ modem: { CurrentModes: currentModes as never } },
				fixtureContext(),
			);
			expect(valued(envelope).radio.modeLabel).toMatchObject({ state: 'known', value: '5g4g' });
		}
	});

	test('the router sources state they have no recency flag at all', () => {
		for (const envelope of [
			normalizeHilinkObservation(HILINK_FIXTURE, fixtureContext()),
			normalizeZteObservation(ZTE_FIXTURE, fixtureContext()),
			normalizeUfiObservation(UFI_FIXTURE, fixtureContext()),
		]) {
			expect(valued(envelope).signal.qualityRecent).toMatchObject({
				state: 'unknown',
				reason: 'unsupported',
			});
		}
	});
});
