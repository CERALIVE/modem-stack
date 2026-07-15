// The certification-bundle output schema — validated before the bundle is written.
//
// A capture that comes out malformed or incomplete fails LOUDLY here (a `ZodError` with a
// precise path) rather than silently producing a garbage bundle a reviewer would trust.
// The transition-evidence descriptors reuse A4.2's `expectedDescriptorsSchema` and the MM
// transition-mode enum DIRECTLY, so the evidence is shape-compatible with a certified
// catalog entry: a reviewer copies `afterDescriptors` into the entry's `expectedDescriptors`
// and the bundle sha256 into its `evidenceBundleSha256`.

import { expectedDescriptorsSchema, MM_USB_MODES } from '@ceralive/modem-control';
import { z } from 'zod';

/** The current bundle schema version. */
export const CERTIFY_SCHEMA_VERSION = 1;

const mmMode = z.enum(MM_USB_MODES);

/** A live device's SKU discriminator (VID:PID + model + firmware prefix). */
const skuSchema = z.strictObject({
	vidPid: z.string().regex(/^[0-9a-f]{4}:[0-9a-f]{4}$/),
	model: z.string().min(1),
	firmwarePrefix: z.string().min(1),
});

/** One bounded-window D-Bus signal — metadata only (property NAMES, never values). */
const signalRecordSchema = z.strictObject({
	atMs: z.number(),
	path: z.string(),
	interface: z.string(),
	member: z.string(),
	changed: z.array(z.string()),
	invalidated: z.array(z.string()),
});
export type SignalRecord = z.infer<typeof signalRecordSchema>;

/** One timestamped step of a mode transition (command / port-drop / re-enumeration). */
const timelineEventSchema = z.strictObject({
	event: z.enum(['command-sent', 'port-drop', 're-enumeration']),
	atMs: z.number(),
});
export type TransitionTimelineEvent = z.infer<typeof timelineEventSchema>;

/**
 * Transition evidence — EXACTLY the fields a reviewer needs to author a catalog entry:
 * the before/after USB descriptors, the executed AT command, and the port-drop /
 * re-enumeration timeline. `afterDescriptors` is `expectedDescriptorsSchema`, so it drops
 * straight into a catalog entry's `expectedDescriptors`.
 */
const transitionEvidenceSchema = z.strictObject({
	from: mmMode,
	to: mmMode,
	atCommand: z.string().min(1),
	expectedResponse: z.string().min(1),
	expectsPortDrop: z.boolean(),
	beforeDescriptors: expectedDescriptorsSchema,
	afterDescriptors: expectedDescriptorsSchema,
	timeline: z.array(timelineEventSchema).min(1),
});
export type TransitionEvidence = z.infer<typeof transitionEvidenceSchema>;

/** The whole redacted certification bundle. */
export const certificationBundleSchema = z.strictObject({
	schemaVersion: z.literal(CERTIFY_SCHEMA_VERSION),
	/** `false` on a real hardware capture; `true` only for synthetic test/sample bundles. */
	synthetic: z.boolean(),
	capturedAtMs: z.number(),
	slot: z.string().min(1),
	sku: skuSchema.optional(),
	usb: z.strictObject({
		lsusb: z.string().min(1),
		usbDevices: z.string().min(1),
		udevProperties: z.record(z.string(), z.string()),
	}),
	modemManager: z.strictObject({
		mmcliKeyfile: z.record(z.string(), z.string()),
		managedObjects: z.record(z.string(), z.record(z.string(), z.unknown())),
		signalWindow: z.array(signalRecordSchema),
	}),
	transition: transitionEvidenceSchema.optional(),
});
export type CertificationBundle = z.infer<typeof certificationBundleSchema>;
