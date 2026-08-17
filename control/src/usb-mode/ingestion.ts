// The evidence-bundle ingestion seam — turning ONE real `certify` bundle into (i) a
// classifier test fixture in the real udev shape and (ii) a candidate catalog entry.
//
// This is the documented path between the bench and the catalog. It is deliberately a
// PURE TRANSFORM that produces a REVIEW ARTIFACT: nothing here writes a file, mutates
// `certified-catalog.json`, or promotes anything. A catalog addition stays what Phase A
// made it — a human-reviewed commit — and this seam only removes the hand-transcription
// step between the bundle and that commit.
//
// THE ONE RULE THE CODE ENFORCES, NOT THE REVIEWER:
//   A bundle marked `synthetic: true` is REFUSED for catalog promotion, with a typed
//   reason. Synthetic bundles are legitimate test data — `buildClassifierFixture` accepts
//   them and stamps the fixture's provenance with `synthetic: true` — but a catalog entry
//   asserts a certified hardware fact, and no synthetic capture may ever back one.
//
// SHAPE COMPATIBILITY, not shape duplication: the bundle is validated here through a
// deliberately NON-strict VIEW schema. The authoritative bundle schema lives beside the
// `certify` command in the CLI, which depends on this package and not the reverse, so
// this file describes only the subset ingestion reads and ignores the rest (`lsusb`,
// `modemManager`, the transition timeline). Adding a field to the bundle can therefore
// never break ingestion — which is the point of a view.

import { z } from 'zod';
import type { UsbDeviceSnapshot } from '../backend/device-classifier';
import {
	CANONICAL_USB_MODES,
	type CanonicalUsbMode,
	type CatalogEntry,
	catalogEntrySchema,
	expectedDescriptorsSchema,
	MM_USB_MODES,
} from './catalog-schema';
import { parseUsbDevices, selectUniqueDevice } from './usb-devices-parse';

const mmMode = z.enum(MM_USB_MODES);

/** The ingestion VIEW of a certification bundle — non-strict on purpose (see header). */
export const evidenceBundleViewSchema = z.object({
	schemaVersion: z.literal(1),
	synthetic: z.boolean(),
	capturedAtMs: z.number(),
	slot: z.string().min(1),
	sku: z
		.object({
			vidPid: z.string().regex(/^[0-9a-f]{4}:[0-9a-f]{4}$/),
			model: z.string().min(1),
			firmwarePrefix: z.string().min(1),
		})
		.optional(),
	usb: z.object({
		usbDevices: z.string().min(1),
		udevProperties: z.record(z.string(), z.string()),
	}),
	transition: z
		.object({
			from: mmMode,
			to: mmMode,
			atCommand: z.string().min(1),
			expectedResponse: z.string().min(1),
			expectsPortDrop: z.boolean(),
			afterDescriptors: expectedDescriptorsSchema,
		})
		.optional(),
});
export type EvidenceBundleView = z.infer<typeof evidenceBundleViewSchema>;

/** Every way ingestion can refuse. Each is a named, actionable condition — never a throw. */
export type IngestionRefusalReason =
	| 'bundle-malformed'
	| 'sha256-malformed'
	| 'sku-missing'
	| 'device-not-in-capture'
	| 'device-ambiguous'
	| 'no-interfaces-captured'
	| 'synthetic-bundle'
	| 'transition-mode-mismatch'
	| 'entry-schema-invalid';

/** A typed refusal. `detail` is for a human reviewer; `reason` is for a machine. */
export interface IngestionRefusal {
	readonly ok: false;
	readonly reason: IngestionRefusalReason;
	readonly detail: string;
}

/** A refusal or a value — ingestion never throws and never returns a partial result. */
export type IngestionOutcome<T> = { readonly ok: true; readonly value: T } | IngestionRefusal;

const refuse = (reason: IngestionRefusalReason, detail: string): IngestionRefusal => ({
	ok: false,
	reason,
	detail,
});

/** Where a fixture came from — stamped onto every fixture, honest about synthetic input. */
export interface FixtureProvenance {
	readonly bundleSha256: string;
	/** `true` when the source bundle was synthetic — such a fixture is test data only. */
	readonly synthetic: boolean;
	readonly slot: string;
	readonly capturedAtMs: number;
}

/** A classifier fixture: the snapshot `classifyDevice` consumes, plus its provenance. */
export interface ClassifierFixture {
	readonly snapshot: UsbDeviceSnapshot;
	readonly provenance: FixtureProvenance;
}

/** One bundle plus the sha256 `certify` printed for it — the two halves are inseparable. */
export interface IngestionRequest {
	/** The bundle JSON, already `JSON.parse`d. Validated here against the view schema. */
	readonly bundle: unknown;
	/** The `CERTIFY OK: sha256=…` value. Becomes the entry's `evidenceBundleSha256`. */
	readonly bundleSha256: string;
}

/**
 * The claim a REVIEWER makes about the SKU. `canonicalMode` is stated, never inferred:
 * a machine reading descriptors could guess it, but a catalog entry is an assertion a
 * human signs, and a stage-2 bundle's `transition.from` is cross-checked against it.
 */
export interface CatalogClaim {
	readonly canonicalMode: CanonicalUsbMode;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Validate a request's bundle + sha, or refuse with a precise reason. */
export function parseIngestionRequest(
	request: IngestionRequest,
): IngestionOutcome<EvidenceBundleView> {
	if (!SHA256_RE.test(request.bundleSha256)) {
		return refuse(
			'sha256-malformed',
			`bundle sha256 must be 64 lowercase hex characters, got '${request.bundleSha256}'`,
		);
	}
	const parsed = evidenceBundleViewSchema.safeParse(request.bundle);
	if (!parsed.success) {
		return refuse('bundle-malformed', z.prettifyError(parsed.error));
	}
	return { ok: true, value: parsed.data };
}

/**
 * Build a classifier test fixture from a bundle — the real udev shape, not a hand-typed
 * approximation. Descriptors and per-interface DRIVERS come from the bundle's
 * `usb-devices` text (the only structured descriptor source a base bundle carries);
 * identity comes from the bundle's SKU; `physicalUid` / `ifname` come from the captured
 * udev properties. A synthetic bundle is ACCEPTED here and the provenance says so.
 */
export function buildClassifierFixture(
	request: IngestionRequest,
): IngestionOutcome<ClassifierFixture> {
	const parsed = parseIngestionRequest(request);
	if (!parsed.ok) {
		return parsed;
	}
	const bundle = parsed.value;
	const sku = bundle.sku;
	if (sku === undefined) {
		// Blocker B2 in `docs/BENCH.md` produces exactly this: an unmatched USB device
		// yields a bundle with no SKU at all.
		return refuse(
			'sku-missing',
			'bundle carries no `sku` — the capture did not match a USB device to the slot',
		);
	}

	const selected = selectUniqueDevice(parseUsbDevices(bundle.usb.usbDevices), sku.vidPid);
	if (!('device' in selected)) {
		return selected.ambiguousMatches === 0
			? refuse(
					'device-not-in-capture',
					`no device with vidPid ${sku.vidPid} in the bundle's usb-devices capture`,
				)
			: refuse(
					'device-ambiguous',
					`${selected.ambiguousMatches} devices share vidPid ${sku.vidPid} in this capture; a fixture must name one physical device`,
				);
	}
	const device = selected.device;
	if (device.interfaces.length === 0) {
		return refuse(
			'no-interfaces-captured',
			`device ${sku.vidPid} has no parsed interface lines; a classifier fixture with no interfaces classifies nothing`,
		);
	}

	const [vendorId, productId] = sku.vidPid.split(':') as [string, string];
	const props = bundle.usb.udevProperties;
	const physicalUid = props.ID_PATH;
	const ifname = props.INTERFACE;

	return {
		ok: true,
		value: {
			snapshot: {
				vendorId,
				productId,
				model: sku.model,
				firmwareRevision: sku.firmwarePrefix,
				bDeviceClass: device.bDeviceClass,
				interfaces: device.interfaces,
				udevProperties: props,
				...(physicalUid !== undefined ? { physicalUid } : {}),
				...(ifname !== undefined ? { ifname } : {}),
			},
			provenance: {
				bundleSha256: request.bundleSha256,
				synthetic: bundle.synthetic,
				slot: bundle.slot,
				capturedAtMs: bundle.capturedAtMs,
			},
		},
	};
}

/**
 * Build a CANDIDATE catalog entry from a bundle. The entry is a review artifact: it is
 * returned, never written.
 *
 * REFUSES a `synthetic: true` bundle — a catalog entry asserts a certified hardware
 * fact, so synthetic evidence can never back one (`docs/BENCH.md` Must-NOT-Have 7).
 *
 * A stage-1 (base) bundle yields `permittedTransitions: []`. A stage-2 bundle — one
 * captured with `certify --transition` — yields exactly ONE permitted transition, whose
 * `expectedDescriptors` is the captured `afterDescriptors` and whose
 * `evidenceBundleSha256` is this bundle's hash. The reviewer's stated `canonicalMode`
 * must equal the captured `transition.from`; a mismatch is refused rather than silently
 * resolved in either direction.
 */
export function buildCatalogEntryCandidate(
	request: IngestionRequest,
	claim: CatalogClaim,
): IngestionOutcome<CatalogEntry> {
	const parsed = parseIngestionRequest(request);
	if (!parsed.ok) {
		return parsed;
	}
	const bundle = parsed.value;
	if (bundle.synthetic) {
		return refuse(
			'synthetic-bundle',
			`bundle for slot '${bundle.slot}' is marked synthetic:true; a catalog entry requires a real capture (synthetic:false)`,
		);
	}
	const sku = bundle.sku;
	if (sku === undefined) {
		return refuse(
			'sku-missing',
			'bundle carries no `sku` — a catalog entry needs all three discriminators (vidPid, model, firmwarePrefix)',
		);
	}

	const transition = bundle.transition;
	if (transition !== undefined && transition.from !== claim.canonicalMode) {
		return refuse(
			'transition-mode-mismatch',
			`claimed canonicalMode '${claim.canonicalMode}' contradicts the captured transition.from '${transition.from}'`,
		);
	}

	const candidate = {
		vidPid: sku.vidPid,
		model: sku.model,
		firmwarePrefix: sku.firmwarePrefix,
		canonicalMode: claim.canonicalMode,
		permittedTransitions:
			transition === undefined
				? []
				: [
						{
							from: transition.from,
							to: transition.to,
							atCommand: transition.atCommand,
							expectedResponse: transition.expectedResponse,
							expectsPortDrop: transition.expectsPortDrop,
							expectedDescriptors: transition.afterDescriptors,
							evidenceBundleSha256: request.bundleSha256,
						},
					],
	};

	// The candidate is re-validated through the AUTHORITATIVE entry schema, so an
	// impossible combination (a router-mode SKU declaring a transition, say) is refused
	// here rather than at review time.
	const entry = catalogEntrySchema.safeParse(candidate);
	if (!entry.success) {
		return refuse('entry-schema-invalid', z.prettifyError(entry.error));
	}
	return { ok: true, value: entry.data };
}

/** The canonical-mode vocabulary a reviewer's claim may use — re-exported for callers. */
export const CLAIMABLE_CANONICAL_MODES = CANONICAL_USB_MODES;
