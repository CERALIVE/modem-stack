// Deriving the registration facts the USSD classifier needs.
//
// ModemManager publishes no "is a CS domain available" property, so this is the
// derivation that decides whether a refusal may be reported as a carrier policy
// rather than a device limit — and it must never over-claim.

import { expect, test } from 'bun:test';
import { MODEM_IFACE, MODEM3GPP_IFACE } from '../backend/constants';
import type { DecodedManagedObjects } from '../backend/managed-objects';
import { decodeAccessTechnologies, registrationFactsFromTree } from './registration';

const MODEM = '/org/freedesktop/ModemManager1/Modem/0';

const LTE_BIT = 1 << 14;
const NR_BIT = 1 << 15;
const UMTS_BIT = 1 << 5;
const GSM_BIT = 1 << 1;

function tree(options: {
	registrationState?: number;
	accessTechnologies?: number;
}): DecodedManagedObjects {
	const modemProps: Array<readonly [string, { signature: string; value: number }]> = [];
	if (options.accessTechnologies !== undefined) {
		modemProps.push(['AccessTechnologies', { signature: 'u', value: options.accessTechnologies }]);
	}
	const threeGppProps: Array<readonly [string, { signature: string; value: number }]> = [];
	if (options.registrationState !== undefined) {
		threeGppProps.push(['RegistrationState', { signature: 'u', value: options.registrationState }]);
	}
	return [
		[
			MODEM,
			[
				[MODEM_IFACE, modemProps],
				[MODEM3GPP_IFACE, threeGppProps],
			],
		],
	] as unknown as DecodedManagedObjects;
}

test('an LTE-only home registration is registered with NO circuit-switched domain', () => {
	const facts = registrationFactsFromTree(
		tree({ registrationState: 1, accessTechnologies: LTE_BIT }),
		MODEM,
	);
	expect(facts).toEqual({ registered: true, csDomain: false, accessTechnologies: ['lte'] });
});

test('a 5G-NR-only registration is packet-only too', () => {
	const facts = registrationFactsFromTree(
		tree({ registrationState: 5, accessTechnologies: NR_BIT }),
		MODEM,
	);
	expect(facts.csDomain).toBe(false);
	expect(facts.accessTechnologies).toEqual(['5gnr']);
});

test('a CSFB registration is CS-capable even while camped on LTE', () => {
	// States 9/10 (`*_CSFB_NOT_PREFERRED`) are MM saying outright that the CS
	// domain is reachable, so the radio in use does not get to overrule them.
	for (const state of [9, 10]) {
		const facts = registrationFactsFromTree(
			tree({ registrationState: state, accessTechnologies: LTE_BIT }),
			MODEM,
		);
		expect(facts.csDomain).toBe(true);
		expect(facts.registered).toBe(true);
	}
});

test('a UMTS registration is CS-capable', () => {
	const facts = registrationFactsFromTree(
		tree({ registrationState: 1, accessTechnologies: UMTS_BIT }),
		MODEM,
	);
	expect(facts.csDomain).toBe(true);
});

test('an LTE registration with a CS radio also in use is CS-capable', () => {
	const facts = registrationFactsFromTree(
		tree({ registrationState: 1, accessTechnologies: LTE_BIT | GSM_BIT }),
		MODEM,
	);
	expect(facts.csDomain).toBe(true);
	expect(facts.accessTechnologies).toEqual(['gsm', 'lte']);
});

test('an UNREAD access-technology mask leaves the CS domain undeclared', () => {
	const facts = registrationFactsFromTree(tree({ registrationState: 1 }), MODEM);
	expect(facts.registered).toBe(true);
	expect(facts.csDomain).toBeUndefined();
	expect(facts.accessTechnologies).toBeUndefined();
});

test('a zero mask is a read that named no radio, and declares nothing', () => {
	const facts = registrationFactsFromTree(
		tree({ registrationState: 1, accessTechnologies: 0 }),
		MODEM,
	);
	expect(facts.accessTechnologies).toEqual([]);
	expect(facts.csDomain).toBeUndefined();
});

test('a searching or denied modem is not registered', () => {
	for (const state of [0, 2, 3, 4]) {
		expect(registrationFactsFromTree(tree({ registrationState: state }), MODEM).registered).toBe(
			false,
		);
	}
});

test('a modem missing from the tree yields the unregistered default', () => {
	expect(registrationFactsFromTree([], MODEM)).toEqual({ registered: false });
});

test('the access-technology mask decodes every named bit', () => {
	expect(decodeAccessTechnologies(LTE_BIT | NR_BIT)).toEqual(['lte', '5gnr']);
	expect(decodeAccessTechnologies(1 << 16)).toEqual(['lte-cat-m']);
	expect(decodeAccessTechnologies(1 << 17)).toEqual(['lte-nb-iot']);
	expect(decodeAccessTechnologies(0)).toEqual([]);
});
