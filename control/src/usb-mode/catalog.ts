// Loading and querying the certified USB-mode catalog.
//
// The catalog is validated on load — a malformed file fails LOUDLY, never silently
// half-parsed. The certified-catalog.json shipped in this package is validated once
// at module load and exposed as `CERTIFIED_CATALOG`; a caller that wants to validate
// an alternate file (e.g. A6.2's `certify` tool checking a candidate entry) uses
// `loadCertifiedCatalog`. The evidence bundles the entries reference are NOT read
// here — only the catalog metadata is.

import {
	type CatalogEntry,
	type CertifiedCatalog,
	certifiedCatalogSchema,
	type MmUsbMode,
	type PermittedTransition,
	type SkuDiscriminator,
} from './catalog-schema';
import rawCatalog from './certified-catalog.json' with { type: 'json' };

/**
 * Parse and validate an untrusted value as a certified catalog. Throws a `ZodError`
 * with a precise path if the value violates the schema (unknown field, an MM↔router
 * transition, a bad VID:PID, etc.).
 */
export function loadCertifiedCatalog(value: unknown): CertifiedCatalog {
	return certifiedCatalogSchema.parse(value);
}

/** The catalog shipped in this package, validated at module load. */
export const CERTIFIED_CATALOG: CertifiedCatalog = loadCertifiedCatalog(rawCatalog);

/**
 * Find the catalog entry matching a live device's SKU discriminator. All three
 * discriminators (VID:PID, model, firmware prefix) must match — a partial match is
 * NOT a certified device. Returns `undefined` for an uncertified SKU (never a guess).
 */
export function findCatalogEntry(
	catalog: CertifiedCatalog,
	sku: SkuDiscriminator,
): CatalogEntry | undefined {
	return catalog.entries.find(
		(entry) =>
			entry.vidPid === sku.vidPid &&
			entry.model === sku.model &&
			entry.firmwarePrefix === sku.firmwarePrefix,
	);
}

/**
 * Find the permitted transition `from → to` in a catalog entry. Returns `undefined`
 * when the entry declares no such transition — the caller MUST treat that as "not
 * permitted", never as "permitted with no command".
 */
export function findPermittedTransition(
	entry: CatalogEntry,
	from: MmUsbMode,
	to: MmUsbMode,
): PermittedTransition | undefined {
	return entry.permittedTransitions.find((t) => t.from === from && t.to === to);
}
