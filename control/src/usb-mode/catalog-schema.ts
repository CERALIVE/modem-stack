// The certified USB-mode catalog schema — the contract that gates a mode switch.
//
// A catalog ENTRY is one server-derived SKU discriminator (VID:PID + model +
// firmware prefix) plus everything a certified transition needs: the canonical mode
// the SKU speaks, the AT commands that switch it, the expected AT response and
// port-drop behaviour, the USB descriptors it should present AFTER the switch, and a
// forward-reference to the evidence bundle that certified it. Certification is a
// human-reviewed commit that adds an entry — evidence bundles are inputs to that
// review, never read at runtime.
//
// TWO safety invariants are enforced by the SCHEMA ITSELF, not by convention:
//   1. Permitted transitions are WITHIN-ModemManager only — `qmi ↔ mbim ↔ ecm-ncm`.
//      A transition's `from`/`to` are typed to the MM-mode enum, so any attempt to
//      declare an `MM ↔ router` (or `rndis`) transition FAILS to parse.
//   2. `.strict()` everywhere — an entry carrying an unknown field is rejected, so a
//      typo or a smuggled extra field can never slip past review as valid data.

import { z } from 'zod';

/**
 * The full canonical USB composition-mode vocabulary. A SKU's `canonicalMode` may be
 * any of these; only the first three are ModemManager-manageable. (Structurally
 * identical to `PreferredUsbMode` in the power contract — A4.2 owns this vocabulary.)
 */
export const CANONICAL_USB_MODES = ['qmi', 'mbim', 'ecm-ncm', 'rndis', 'router-ethernet'] as const;
export type CanonicalUsbMode = (typeof CANONICAL_USB_MODES)[number];

/**
 * The ModemManager-manageable modes — the ONLY modes a transition may move between.
 * `rndis` and `router-ethernet` are deliberately absent: a device in either is not
 * MM-managed, so switching to/from them crosses the MM↔router line the schema forbids.
 */
export const MM_USB_MODES = ['qmi', 'mbim', 'ecm-ncm'] as const;
export type MmUsbMode = (typeof MM_USB_MODES)[number];

const canonicalMode = z.enum(CANONICAL_USB_MODES);
const mmMode = z.enum(MM_USB_MODES);

/** A `bInterfaceClass`/`bInterfaceSubClass`/`bInterfaceProtocol` byte triple. */
const usbByte = z.number().int().min(0).max(255);

/** The USB descriptors a device must present AFTER a transition — the postcondition. */
export const expectedDescriptorsSchema = z.strictObject({
	deviceClass: usbByte,
	interfaces: z
		.array(
			z.strictObject({
				interfaceClass: usbByte,
				interfaceSubClass: usbByte,
				interfaceProtocol: usbByte,
			}),
		)
		.min(1),
});
export type ExpectedDescriptors = z.infer<typeof expectedDescriptorsSchema>;

/** One permitted, certified transition between two MM modes. */
export const permittedTransitionSchema = z
	.strictObject({
		from: mmMode,
		to: mmMode,
		/** The EXACT AT command that performs the switch (allowlisted at send time). */
		atCommand: z.string().min(1),
		/**
		 * The EXACT AT command that COMMITS the switch on a SKU whose `atCommand` only
		 * writes non-volatile configuration; omitted for a SKU that re-enumerates on
		 * `atCommand` alone. Sent through the SAME allowlisted lease.
		 *
		 * Declaring it is a per-SKU hardware FACT, not a retry. Measured on the bench
		 * RM530N-GL: `AT+QCFG="usbnet",<n>` answers `OK`, reads back the new value, and
		 * leaves the device in the OLD composition for the whole port-drop budget — having
		 * already committed to NV. Undeclared, such a SKU fails on a timeout AFTER it was
		 * silently changed, then lands in the new composition at the next unrelated reboot.
		 */
		applyCommand: z.string().min(1).optional(),
		/** The AT response expected on success (e.g. `OK`) — never proof on its own. */
		expectedResponse: z.string().min(1),
		/** Whether the control port is expected to drop after the command is written. */
		expectsPortDrop: z.boolean(),
		/** The descriptors the device must present after re-enumerating — the postcondition. */
		expectedDescriptors: expectedDescriptorsSchema,
		/** sha256 of the evidence bundle that certified this transition (A6.2 fills it). */
		evidenceBundleSha256: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.optional(),
	})
	.refine((t) => t.from !== t.to, { message: 'a transition must change mode (from !== to)' });
export type PermittedTransition = z.infer<typeof permittedTransitionSchema>;

/** One certified SKU: its discriminator, canonical mode, and permitted transitions. */
export const catalogEntrySchema = z
	.strictObject({
		/** VID:PID, lowercase hex, `xxxx:xxxx`. */
		vidPid: z.string().regex(/^[0-9a-f]{4}:[0-9a-f]{4}$/),
		/** The server-derived model string (a discriminator, not free text). */
		model: z.string().min(1),
		/** The firmware-revision prefix that discriminates this personality. */
		firmwarePrefix: z.string().min(1),
		/** The mode this SKU speaks as certified. */
		canonicalMode,
		/** The certified transitions — empty for a non-MM (router/rndis) SKU. */
		permittedTransitions: z.array(permittedTransitionSchema),
	})
	.refine(
		(e) =>
			e.permittedTransitions.length === 0 ||
			(MM_USB_MODES as readonly string[]).includes(e.canonicalMode),
		{ message: 'only an MM-mode SKU (qmi/mbim/ecm-ncm) may declare permitted transitions' },
	);
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** The whole certified catalog file. */
export const certifiedCatalogSchema = z.strictObject({
	schemaVersion: z.literal(1),
	entries: z.array(catalogEntrySchema),
});
export type CertifiedCatalog = z.infer<typeof certifiedCatalogSchema>;

/** A live device's SKU discriminator — matched against the catalog. */
export interface SkuDiscriminator {
	readonly vidPid: string;
	readonly model: string;
	readonly firmwarePrefix: string;
}
