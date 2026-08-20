// The claims every router admin API makes identically, in one place.
//
// HiLink, goform and HIMI are three vendor HTTP surfaces over a modem, and they share
// a capability boundary: none of them exposes ModemManager's modem state, its 3GPP
// registration enum, its lock enum or its SIM-type enum. Those read `unsupported`,
// which is a durable claim about the SOURCE rather than about one poll — and stating
// it once here is what stops the three normalizers from drifting into three different
// answers for the same structural fact.
//
// SIM PRESENCE is deliberately NOT claimed. Each vendor reports a presence code of
// its own (`SimStatus`, `simcard_state`, `simstate`) with vendor semantics, and no
// migrated decoder covers them; guessing one would be exactly the invented reading
// this layer exists to prevent. It reads `not-reported` and the vendor code stays
// verbatim in the diagnostics block for the per-vendor providers to claim later.

import {
	isUninformativeIdentity,
	modemHardwareLabel,
	modemHardwareName,
	type ObservationAuthority,
} from '../../domain';
import { knownMetric, type NormalizedMetric, unknownMetric } from '../metric';
import type { NormalizedHardware, NormalizedSim, SimPresenceValue } from '../model';
import type { MetricProvenance } from '../provenance';

export type RouterProvenance = (
	fields: readonly string[],
	authority?: ObservationAuthority,
) => MetricProvenance;

export function unsupportedRadioMetric(provenance: RouterProvenance): NormalizedMetric<string> {
	return unknownMetric<string>('unsupported', provenance([]));
}

/**
 * The SIM block every router source produces.
 *
 * `vendorPresenceField` NAMES the vendor's own presence code when the payload carried
 * one, so the evidence records that a code exists and was deliberately not decoded —
 * distinct from `no-evidence`, which says the payload offered nothing at all. Neither
 * one is ever `absent`: claiming absence from a vendor code whose semantics no
 * migrated decoder covers is precisely the invented reading this layer refuses.
 */
export function routerSim(
	provenance: RouterProvenance,
	vendorPresenceField?: string,
): NormalizedSim {
	// The vendor field is NAMED in the evidence but is NOT consumed: no metric claims its
	// value, so it must stay in the diagnostics block's `unmapped` set, verbatim, for the
	// per-vendor provider that will one day decode it with evidence.
	return {
		presence: unknownMetric<SimPresenceValue>('not-reported', provenance([])),
		presenceEvidence:
			vendorPresenceField === undefined
				? { kind: 'no-evidence', inspected: [] }
				: { kind: 'vendor-code-unclaimed', field: vendorPresenceField },
		lockRequired: unknownMetric<string>('unsupported', provenance([])),
		kind: unknownMetric<'physical' | 'esim'>('unsupported', provenance([])),
		esimStatus: unknownMetric<'no-profiles' | 'with-profiles'>('unsupported', provenance([])),
	};
}

/** Router admin APIs report no measurement-recency flag; that is a source capability claim. */
export function unsupportedQualityRecent(provenance: RouterProvenance): NormalizedMetric<boolean> {
	return unknownMetric<boolean>('unsupported', provenance([]));
}

/**
 * A router's product name, screened by the migrated presentation rules.
 *
 * `modemHardwareLabel` falls back to a generic label when its input says nothing, and
 * publishing that as a KNOWN value would be reporting a name no device gave. So an
 * uninformative product string is refused up front and reads `not-reported` instead.
 */
export function routerHardware(
	provenance: RouterProvenance,
	product: { readonly name: string; readonly field: string } | undefined,
): NormalizedHardware {
	if (product === undefined || isUninformativeIdentity(product.name)) {
		const source = provenance(product === undefined ? [] : [product.field]);
		return {
			label: unknownMetric<string>('not-reported', source),
			displayName: unknownMetric<string>('not-reported', source),
		};
	}
	const source = provenance([product.field]);
	const identity = { model: product.name };
	return {
		label: knownMetric(modemHardwareLabel(identity), source),
		displayName: knownMetric(modemHardwareName(identity), source),
	};
}
