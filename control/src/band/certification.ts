// The band-lock certification catalog — what has actually been PROVEN, per SKU.
//
// A band lock is the one capability module that can take a working uplink off the
// air and leave it there: a band the SIM's network does not operate on registers
// nowhere, and a modem that does not honour a reset leaves the operator with no
// way back short of a replug they may not be able to reach. So band-lock is
// deliberately STRICTER than the framework floor in `support-claim.ts`. The
// framework offers a control at `capable` (the modem advertises the capability)
// because hiding an uncertified-but-working control puts hardware behind a
// paperwork gate. For this module the paperwork IS the safety argument, so the
// control stays HIDDEN until an entry here proves the whole round trip.
//
// FOUR STEPS, ALL FOUR REQUIRED, and they are separate booleans rather than one
// `certified: true` because each can fail on its own and each failure means a
// different thing:
//
//   supportedRead — `SupportedBands` was read and named real bands. Without it
//                   there is nothing to offer.
//   set           — `SetCurrentBands` was accepted for a band in that set.
//   readback      — `CurrentBands` afterwards reported exactly what was asked
//                   for. An accepted-but-ignored write is the failure mode that
//                   looks like success from the call site alone.
//   reset         — setting `any` restored the baseline. This is the escape
//                   hatch; a SKU that cannot be shown to reset must never be
//                   locked in the first place.
//
// THE SHIPPED CATALOG IS EMPTY, and that is the honest state. Nothing in the
// fleet has been through the drill — see the phase-C band-lock evidence for why
// (the bench Quectel's SIM never registers, so "re-registration proven" cannot
// be claimed today). An entry is added by a human-reviewed commit carrying the
// bench transcript, exactly like `usb-mode/certified-catalog.json`.

import { z } from 'zod';

import rawCatalog from './certified-bands.json' with { type: 'json' };

/**
 * The device a certification is about. Firmware is a PREFIX for the same reason
 * the USB-mode catalog matches one: an entry certifies a firmware FAMILY, and
 * where the family ends is a per-SKU judgement a reviewer makes, not something a
 * device can compute.
 */
export const bandSkuSchema = z
	.object({
		vidPid: z.string().regex(/^[0-9a-f]{4}:[0-9a-f]{4}$/),
		model: z.string().min(1),
		firmwarePrefix: z.string().min(1),
	})
	.strict();
export type BandSku = z.infer<typeof bandSkuSchema>;

export const bandProofSchema = z
	.object({
		supportedRead: z.literal(true),
		set: z.literal(true),
		readback: z.literal(true),
		reset: z.literal(true),
	})
	.strict();

/**
 * All four proofs are `z.literal(true)`, so a HALF-certified entry cannot be
 * expressed at all. A reviewer with three of four proofs has an uncertified SKU
 * and the file must say so by omitting it — a `false` field would read as a
 * catalog row, and a catalog row is what surfaces the control.
 */
export const bandCertificationEntrySchema = z
	.object({
		vidPid: z.string().regex(/^[0-9a-f]{4}:[0-9a-f]{4}$/),
		model: z.string().min(1),
		firmwarePrefix: z.string().min(1),
		/** Free-form: where the transcript proving the four steps lives. */
		evidence: z.string().min(1),
		proofs: bandProofSchema,
		/**
		 * Bands the reviewer proved were individually settable AND resettable.
		 * An EMPTY list means "the whole advertised set", which is what a drill
		 * that swept the set records; a non-empty list NARROWS what is offered.
		 */
		provenBands: z.array(z.string()).default([]),
	})
	.strict();
export type BandCertificationEntry = z.infer<typeof bandCertificationEntrySchema>;

export const bandCertificationCatalogSchema = z
	.object({
		schemaVersion: z.literal(1),
		entries: z.array(bandCertificationEntrySchema),
	})
	.strict();
export type BandCertificationCatalog = z.infer<typeof bandCertificationCatalogSchema>;

/** Parse an untrusted value as a band catalog. Throws with a precise path. */
export function loadBandCertificationCatalog(value: unknown): BandCertificationCatalog {
	return bandCertificationCatalogSchema.parse(value);
}

/** The catalog shipped in this package, validated at module load. */
export const BAND_CERTIFICATION_CATALOG: BandCertificationCatalog =
	loadBandCertificationCatalog(rawCatalog);

/**
 * The entry certifying this exact device, or `undefined`.
 *
 * All three discriminators must match, and the firmware match is a PREFIX of the
 * device's FULL revision — never a truncation of the device's revision to the
 * entry's length, which would certify a family the reviewer never looked at.
 */
export function findBandCertification(
	catalog: BandCertificationCatalog,
	sku: BandSku,
): BandCertificationEntry | undefined {
	return catalog.entries.find(
		(entry) =>
			entry.vidPid === sku.vidPid &&
			entry.model === sku.model &&
			sku.firmwarePrefix.startsWith(entry.firmwarePrefix),
	);
}

/**
 * Whether a band-lock control may be OFFERED for this device.
 *
 * Fail-closed in every direction: an unknown SKU, a SKU with no entry, and a SKU
 * whose entry predates a proof step all answer `false`.
 */
export function isBandControlCertified(
	catalog: BandCertificationCatalog,
	sku: BandSku | undefined,
): boolean {
	if (sku === undefined) return false;
	return findBandCertification(catalog, sku) !== undefined;
}

/**
 * Narrow an advertised band set to what the certification proves is settable.
 *
 * An entry with no `provenBands` proves the whole advertised set (the drill swept
 * it); an entry that names bands offers ONLY those, intersected with what the
 * modem advertises right now — a certified band the device no longer advertises
 * is not offerable, and the device's own answer outranks the catalog.
 */
export function offerableBands(
	entry: BandCertificationEntry | undefined,
	supported: readonly string[],
): readonly string[] {
	if (entry === undefined) return [];
	if (entry.provenBands.length === 0) return supported;
	const proven = new Set(entry.provenBands);
	return supported.filter((band) => proven.has(band));
}
