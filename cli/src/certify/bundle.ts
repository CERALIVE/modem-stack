// Assembling, redacting, validating, and hashing a certification bundle.
//
// The base capture and (optionally) the transition evidence are composed into one
// object, run through the shared key-based redactor so ICCID / IMSI / EID are masked
// everywhere they appear, validated against the bundle schema (a malformed capture
// throws a `CertifyError` here rather than being written), and hashed. The sha256 is
// computed over a CANONICAL (sorted-key) serialization so it is reproducible: this hash
// IS the value a reviewer records in a catalog entry's `evidenceBundleSha256`.

import { createHash } from 'node:crypto';
import { redact } from '@ceralive/modem-control';
import { z } from 'zod';
import {
	CERTIFY_SCHEMA_VERSION,
	type CertificationBundle,
	certificationBundleSchema,
	type TransitionEvidence,
} from './bundle-schema';
import type { BaseCaptureParts } from './capture';
import { CertifyError } from './errors';

/** Everything needed to assemble one bundle. */
export interface BundleInput {
	readonly slot: string;
	/** `false` for a real hardware capture; `true` only for synthetic test/sample bundles. */
	readonly synthetic: boolean;
	readonly capturedAtMs: number;
	readonly base: BaseCaptureParts;
	readonly transition?: TransitionEvidence;
}

/** A validated, redacted bundle and its reproducible sha256. */
export interface CertificationResult {
	readonly bundle: CertificationBundle;
	/** sha256 of the canonical bundle — the catalog's `evidenceBundleSha256` value. */
	readonly sha256: string;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Recursively sort object keys so the serialization (and thus the hash) is stable. */
function sortKeys(value: Json): Json {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (value !== null && typeof value === 'object') {
		const out: { [key: string]: Json } = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = sortKeys(value[key] as Json);
		}
		return out;
	}
	return value;
}

/** Canonical JSON of a bundle — sorted keys, no whitespace. */
export function canonicalJson(bundle: CertificationBundle): string {
	return JSON.stringify(sortKeys(bundle as unknown as Json));
}

/**
 * Assemble, redact, validate, and hash a certification bundle. Throws a `CertifyError`
 * if the redacted bundle fails schema validation — a broken bundle is never returned.
 */
export function buildCertificationBundle(input: BundleInput): CertificationResult {
	const assembled = {
		schemaVersion: CERTIFY_SCHEMA_VERSION,
		synthetic: input.synthetic,
		capturedAtMs: input.capturedAtMs,
		slot: input.slot,
		...(input.base.sku !== undefined ? { sku: input.base.sku } : {}),
		usb: input.base.usb,
		modemManager: input.base.modemManager,
		...(input.transition !== undefined ? { transition: input.transition } : {}),
	};

	const redacted = redact(assembled);
	const parsed = certificationBundleSchema.safeParse(redacted);
	if (!parsed.success) {
		throw new CertifyError(`bundle failed schema validation: ${z.prettifyError(parsed.error)}`);
	}
	const bundle = parsed.data;
	const sha256 = createHash('sha256').update(canonicalJson(bundle), 'utf8').digest('hex');
	return { bundle, sha256 };
}
