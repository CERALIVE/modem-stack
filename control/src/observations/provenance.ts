// Provenance + diagnostics — where a normalized value came from, and everything the
// provider said that the normalized model has no field for.
//
// The rule this module exists to enforce: normalization NARROWS a vendor payload into
// one shape, it does not DISCARD it. Every provider-native field a normalizer reads —
// and every one it does not — is retained verbatim in `ObservationDiagnostics.raw`,
// and each normalized metric carries the provenance of the exact observation that
// produced it. A consumer can therefore always answer "which provider said this, and
// when" without the provider having to widen the normalized model.

import type { EpochMillis, ObservationAuthority, SourceEpoch } from '../domain';
import { redact } from '../redact';

/**
 * The provider families this layer normalizes.
 *
 * These are SOURCE SHAPES, not live transports. Todo 18 builds the normalization
 * layer; the providers that will feed it (ModemManager D-Bus, the HiLink/goform/HIMI
 * HTTP sessions) are separate work and open no connection from here.
 *
 * `networkmanager` is here because NM is a source of a DIFFERENT fact than the other
 * four: it reports which connection is in force on which interface, never a radio
 * reading. Giving it its own kind is what keeps a bearer observation attributable to
 * NM rather than laundered through whichever provider happened to read the modem.
 */
export const OBSERVATION_SOURCE_KINDS = [
	'modemmanager',
	'huawei-hilink',
	'zte-goform',
	'ufi-himiapi',
	'networkmanager',
] as const;
export type ObservationSourceKind = (typeof OBSERVATION_SOURCE_KINDS)[number];

/**
 * A provider-native value, kept exactly as the provider expressed it.
 *
 * Arrays are part of the union because ModemManager genuinely returns them
 * (`Modem.SimSlots` is an `ao`); flattening one to its first member here would be a
 * silent drop of exactly the kind this module exists to prevent.
 */
export type RawFieldValue = string | number | boolean | null | readonly RawFieldValue[];

/** Provider-native fields keyed by their provider-native names. */
export type RawFieldRecord = Readonly<Record<string, RawFieldValue>>;

/**
 * Per-metric provenance: which source, which reading of it, and when.
 *
 * It is carried on EVERY metric rather than only on the envelope because one
 * normalized observation routinely folds several provider reads together (HiLink
 * answers `device_signal` and `monitoring_status` separately; UFI answers three
 * endpoints), so a single envelope-level `observedAt` would be a claim about a
 * reading no individual metric came from.
 */
export type MetricProvenance = {
	readonly source: ObservationSourceKind;
	readonly sourceEpoch: SourceEpoch;
	readonly observedAt: EpochMillis;
	readonly authority: ObservationAuthority;
	/** The provider-native field name(s) this value was normalized from. */
	readonly rawFields: readonly string[];
};

/**
 * Structural complaints about a payload. A note names the FIELD or body it concerns
 * and never carries its value: a body can hold an ICCID or a one-time code, and a
 * diagnostic is the one place a reviewer reads verbatim.
 */
export const OBSERVATION_DIAGNOSTIC_CODES = [
	'unparseable-body',
	'empty-body',
	'auth-expired',
	'field-shape-unrecognized',
] as const;
export type ObservationDiagnosticCode = (typeof OBSERVATION_DIAGNOSTIC_CODES)[number];

export type ObservationDiagnosticNote = {
	readonly code: ObservationDiagnosticCode;
	/** The provider-native field or body name, never its content. */
	readonly field: string;
};

/**
 * The typed diagnostics block: the provider payload, verbatim, plus which fields the
 * normalizer claimed and which it did not.
 *
 * `raw` is a REDACTION-CLASS boundary. A vendor payload routinely carries an ICCID or
 * an IMSI (the UFI overview endpoint reports both), so anything that logs, serializes
 * or files a diagnostics block must route it through {@link redactObservationDiagnostics}
 * first. Retention and disclosure are different decisions; this layer only guarantees
 * the first.
 */
export type ObservationDiagnostics = {
	readonly source: ObservationSourceKind;
	/** Every provider-native field, verbatim. Nothing is dropped during normalization. */
	readonly raw: RawFieldRecord;
	/** Fields a normalized metric claims. They remain present in `raw` as well. */
	readonly consumed: readonly string[];
	/** Fields in `raw` that no normalized field claims — retained, never discarded. */
	readonly unmapped: readonly string[];
	readonly notes: readonly ObservationDiagnosticNote[];
};

export type DiagnosticsInput = {
	readonly source: ObservationSourceKind;
	readonly raw: RawFieldRecord;
	readonly consumed?: readonly string[];
	readonly notes?: readonly ObservationDiagnosticNote[];
};

/**
 * Build a diagnostics block, deriving `unmapped` rather than accepting it.
 *
 * Deriving it is what makes the no-drop property structural: a normalizer cannot
 * declare a field mapped without a metric that names it, and a field it never
 * mentions lands in `unmapped` automatically instead of vanishing.
 */
export function createObservationDiagnostics(input: DiagnosticsInput): ObservationDiagnostics {
	const rawKeys = Object.keys(input.raw);
	const consumed = [...new Set(input.consumed ?? [])].filter((key) => rawKeys.includes(key)).sort();
	const consumedSet = new Set(consumed);
	return {
		source: input.source,
		raw: input.raw,
		consumed,
		unmapped: rawKeys.filter((key) => !consumedSet.has(key)).sort(),
		notes: input.notes ?? [],
	};
}

/**
 * A copy of `diagnostics` with every sensitive raw field replaced by the shared
 * redaction marker. Routed through the package's own key-based `redact`, so the
 * classes it masks here are exactly the classes it masks everywhere else.
 */
export function redactObservationDiagnostics(
	diagnostics: ObservationDiagnostics,
): ObservationDiagnostics {
	return { ...diagnostics, raw: redact(diagnostics.raw) as RawFieldRecord };
}
