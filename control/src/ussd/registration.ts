// Reading the registration facts the USSD refusal classifier needs.
//
// ModemManager publishes NO "is a circuit-switched domain available" property, so
// the fact has to be DERIVED — and the derivation is worth stating, because it is
// the difference between telling an operator their modem cannot do USSD and
// telling them their carrier will not carry it on this registration:
//
//   * `Modem.AccessTechnologies` is a bitmask. When every bit in use is a
//     packet-only radio (LTE, 5G-NR, LTE-M, NB-IoT) the modem is not camped on a
//     circuit-switched radio at all.
//   * `Modem3gpp.RegistrationState` still overrides that, because CS FALLBACK is
//     exactly the case where an LTE-camped modem CAN reach the CS domain. MM has
//     two states that say so outright — `HOME_CSFB_NOT_PREFERRED` (9) and
//     `ROAMING_CSFB_NOT_PREFERRED` (10) — and a modem in either of them is
//     reported CS-capable regardless of its radio.
//
// Both reads are best-effort and NEVER throw: a fact nobody could read is left
// `undefined`, which the classifier treats as "we did not look" rather than as a
// negative. That asymmetry is the whole safety property — an unread registration
// can only ever produce the generic refusal, never the more specific claim.

import { MODEM_IFACE, MODEM3GPP_IFACE } from '../backend/constants';
import {
	type DecodedManagedObjects,
	fetchManagedObjects,
	findInterface,
	numberProp,
} from '../backend/managed-objects';
import type { DbusTransport } from '../transport';
import type { UssdRegistrationFacts } from './refusal';

/** `MMModemAccessTechnology` bits this module names. */
const ACCESS_TECHNOLOGY_BITS: readonly (readonly [number, string])[] = [
	[1 << 1, 'gsm'],
	[1 << 2, 'gsm-compact'],
	[1 << 3, 'gprs'],
	[1 << 4, 'edge'],
	[1 << 5, 'umts'],
	[1 << 6, 'hsdpa'],
	[1 << 7, 'hsupa'],
	[1 << 8, 'hspa'],
	[1 << 9, 'hspa-plus'],
	[1 << 10, '1xrtt'],
	[1 << 11, 'evdo0'],
	[1 << 12, 'evdoa'],
	[1 << 13, 'evdob'],
	[1 << 14, 'lte'],
	[1 << 15, '5gnr'],
	[1 << 16, 'lte-cat-m'],
	[1 << 17, 'lte-nb-iot'],
];

/** `MMModem3gppRegistrationState` values that mean the modem is on a network. */
const REGISTERED_STATES: ReadonlySet<number> = new Set<number>([1, 5, 6, 7, 9, 10]);

/** …and the two that positively advertise a circuit-switched fallback. */
const CSFB_STATES: ReadonlySet<number> = new Set<number>([9, 10]);

/** Decode `Modem.AccessTechnologies` into the technology names in use. */
export function decodeAccessTechnologies(mask: number): readonly string[] {
	const names: string[] = [];
	for (const [bit, name] of ACCESS_TECHNOLOGY_BITS) {
		if ((mask & bit) !== 0) {
			names.push(name);
		}
	}
	return names;
}

/**
 * Derive the registration facts from an already-fetched managed-objects tree.
 *
 * Pure, so the derivation is testable against a fixture tree without a bus — the
 * `sim-unlock.ts` split between "read the tree" and "decide from the tree".
 */
export function registrationFactsFromTree(
	tree: DecodedManagedObjects,
	modemPath: string,
): UssdRegistrationFacts {
	const modem = findInterface(tree, modemPath, MODEM_IFACE);
	const threeGpp = findInterface(tree, modemPath, MODEM3GPP_IFACE);
	const registrationState = numberProp(threeGpp, 'RegistrationState');
	const accessMask = numberProp(modem, 'AccessTechnologies');

	const registered = registrationState !== undefined && REGISTERED_STATES.has(registrationState);
	const technologies = accessMask === undefined ? undefined : decodeAccessTechnologies(accessMask);

	// A CSFB registration is CS-capable outright. Otherwise the domain is only
	// declared ABSENT when the radios in use were actually read and are all
	// packet-only; an unread mask leaves the field undefined on purpose.
	let csDomain: boolean | undefined;
	if (registrationState !== undefined && CSFB_STATES.has(registrationState)) {
		csDomain = true;
	} else if (technologies !== undefined && technologies.length > 0) {
		csDomain = technologies.some(
			(rat) => rat !== 'lte' && rat !== '5gnr' && rat !== 'lte-cat-m' && rat !== 'lte-nb-iot',
		);
	}

	return {
		registered,
		...(csDomain === undefined ? {} : { csDomain }),
		...(technologies === undefined ? {} : { accessTechnologies: technologies }),
	};
}

/** The unread default — every field withheld, so nothing can be claimed from it. */
export const UNKNOWN_REGISTRATION: UssdRegistrationFacts = { registered: false };

/**
 * Read the registration facts for one modem. Fail-soft: a tree we could not fetch
 * yields {@link UNKNOWN_REGISTRATION}, which can only ever make the refusal LESS
 * specific.
 */
export async function readUssdRegistrationFacts(
	transport: DbusTransport,
	destination: string,
	modemPath: string,
): Promise<UssdRegistrationFacts> {
	try {
		const tree = await fetchManagedObjects(transport, destination);
		return registrationFactsFromTree(tree, modemPath);
	} catch {
		return UNKNOWN_REGISTRATION;
	}
}
