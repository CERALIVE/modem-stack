// Per-module capability detection — what ONE modem can actually be asked to do.
//
// It follows `backend/features.ts` exactly, because the constraints are the same:
// detection must PROBE the observed surface rather than match a version
// whitelist, it must never throw, and an unseen future ModemManager must degrade
// gracefully instead of resolving to a confident wrong answer.
//
// The one rule this module adds is that `unknown` is a first-class result. A
// property set we never observed says nothing about the device, and the ladder in
// `support-claim.ts` stops at `enabled` for it — surfaced by nothing, mutated by
// nothing. Answering `absent` there would hide a working capability; answering
// `present` would offer a control the modem cannot honour.

import { MODEM_IFACE, MODEM3GPP_USSD_IFACE } from '../backend/constants';
import type { MmPropertyProbe } from '../backend/features';
import type { RadioAccessTechnology } from '../domain';
import { fiveGPreferenceEvidence } from './five-g-preference';
import type { CapabilityEvidence, CapabilityModule } from './support-claim';

/** MM's Messaging interface — SMS list/read lives here. */
export const MESSAGING_IFACE = `${MODEM_IFACE}.Messaging`;
/** MM's Location interface — GNSS sources are advertised here. */
export const LOCATION_IFACE = `${MODEM_IFACE}.Location`;
/** MM's 3GPP USSD interface — the same name the USSD adapter dials. */
export const USSD_IFACE = MODEM3GPP_USSD_IFACE;

/**
 * What A3.2 observed, plus the two signals the static object tree cannot carry.
 *
 * `interfaces` is the set of interface NAMES exported on the modem object, which
 * is how SMS/USSD/Location are advertised — they are separate interfaces, not
 * properties, so `MmPropertyProbe` alone cannot see them.
 */
export interface ModuleCapabilityProbe extends MmPropertyProbe {
	readonly interfaces?: ReadonlySet<string>;
	/**
	 * `Location.Capabilities` decoded to source names (`gps-raw`, `gps-nmea`, …).
	 * An EMPTY set is a real answer — the interface exists and offers no GNSS.
	 */
	readonly locationSources?: ReadonlySet<string>;
	/**
	 * `SupportedModes` decoded to the RAT families it actually names.
	 *
	 * OPTIONAL, and its absence is the pre-existing behaviour verbatim: a caller
	 * that decoded only property NAMES answers exactly as before. Supplying it
	 * strictly NARROWS `five-g-pref`, because the property's mere presence is
	 * equally true of a 4G-only modem — see `detectCapabilityModules`.
	 */
	readonly supportedRats?: ReadonlySet<RadioAccessTechnology>;
}

const GNSS_SOURCES = ['gps-raw', 'gps-nmea', 'gps-unmanaged', 'agps-msa', 'agps-msb'];

/**
 * A property we did not see is only evidence of ABSENCE when we saw the object at
 * all. An empty property set means the read never landed.
 */
function fromProperty(probe: ModuleCapabilityProbe, name: string): CapabilityEvidence {
	if (probe.properties.size === 0) {
		return 'unknown';
	}
	return probe.properties.has(name) ? 'present' : 'absent';
}

function fromAnyProperty(
	probe: ModuleCapabilityProbe,
	names: readonly string[],
): CapabilityEvidence {
	if (probe.properties.size === 0) {
		return 'unknown';
	}
	return names.some((name) => probe.properties.has(name)) ? 'present' : 'absent';
}

function fromInterface(probe: ModuleCapabilityProbe, iface: string): CapabilityEvidence {
	if (probe.interfaces === undefined) {
		return 'unknown';
	}
	return probe.interfaces.has(iface) ? 'present' : 'absent';
}

function detectGnss(probe: ModuleCapabilityProbe): CapabilityEvidence {
	const iface = fromInterface(probe, LOCATION_IFACE);
	if (iface !== 'present') {
		return iface;
	}
	// The interface being exported is not the same claim as the modem offering a
	// GNSS source — MM exports Location for 3GPP-LAC/CID-only devices too.
	if (probe.locationSources === undefined) {
		return 'unknown';
	}
	return GNSS_SOURCES.some((source) => probe.locationSources?.has(source)) ? 'present' : 'absent';
}

/**
 * Detect every module's capability for one modem. Pure, total, never throws.
 *
 * `fcc-auto-unlock` is deliberately always `unknown`: FCC unlock is carried out
 * by a ModemManager PLUGIN keyed on the device, and nothing on the modem's own
 * D-Bus surface advertises whether one applies. Reporting `absent` would hide the
 * module on hardware that supports it, and `present` would promise a plugin that
 * may not be installed — so the honest answer is that this probe cannot tell, and
 * evidence for it has to come from the catalog instead.
 *
 * `five-g-pref` is the one module whose property NAME is not the question. Every
 * ModemManager modem exports `SupportedModes`, including a 4G-only one, so the
 * name alone would resolve `present` on hardware with no 5G at all and offer a 5G
 * posture nothing could honour. When the caller decoded the property's VALUE the
 * verdict narrows to whether the catalog actually names 5GNR; when it did not,
 * the property-name answer stands, so this is a strict narrowing and never a new
 * way to claim a capability.
 */
export function detectCapabilityModules(
	probe: ModuleCapabilityProbe,
): Record<CapabilityModule, CapabilityEvidence> {
	return {
		'band-lock': fromProperty(probe, 'SupportedBands'),
		sms: fromInterface(probe, MESSAGING_IFACE),
		'five-g-pref':
			probe.supportedRats === undefined
				? fromProperty(probe, 'SupportedModes')
				: fiveGPreferenceEvidence(probe.supportedRats),
		'fcc-auto-unlock': 'unknown',
		gps: detectGnss(probe),
		ussd: fromInterface(probe, USSD_IFACE),
		esim: fromAnyProperty(probe, ['SimType', 'EsimStatus']),
	};
}
