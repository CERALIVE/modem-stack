// What a Qualcomm USB id does and does not prove.
//
// `05c6:9024` is the composition the bench UFI sticks enumerate in: RNDIS networking
// plus an ADB interface. That is EVIDENCE OF A COMPOSITION, not a permission — the ADB
// interface being present is exactly why production must be explicit that it never uses
// it (see `shell.transport-fallback` in prohibitions.ts).
//
// `05c6:9091` is a FIRMWARE-SPECIFIC product id. It is routinely read as "DIAG is
// available", and that reading is wrong: `05c6` is Qualcomm's generic vendor id and the
// product id is chosen by whoever built the firmware image, so it says nothing about
// which interfaces the device actually exposes. Treating it as proof of DIAG is how a
// tool ends up opening a channel that is not there, or worse, one that is there and
// belongs to something else.
//
// The only thing that proves a DIAG channel is a DIAG INTERFACE DESCRIPTOR. And even a
// confirmed one buys nothing in production: `UFI_DIAG_PRODUCTION_ACCESS` is `prohibited`
// unconditionally, and the supervised read-only info probe is a bench runbook
// (docs/UFI-DIAG-PROBE.md), never an operation this package can perform.

export const UFI_RNDIS_ADB_USB_ID = '05c6:9024';
export const UFI_FIRMWARE_SPECIFIC_USB_ID = '05c6:9091';

export type UfiUsbClaim = 'rndis-network' | 'adb-interface';

export const UFI_USB_EVIDENCE = {
	[UFI_RNDIS_ADB_USB_ID]: ['rndis-network', 'adb-interface'],
	/** Deliberately empty: a firmware-chosen product id claims nothing by itself. */
	[UFI_FIRMWARE_SPECIFIC_USB_ID]: [],
} as const satisfies Record<string, readonly UfiUsbClaim[]>;

export const UFI_MATCHED_USB_IDS = [UFI_RNDIS_ADB_USB_ID, UFI_FIRMWARE_SPECIFIC_USB_ID] as const;

export function ufiUsbClaims(usbId: string): readonly UfiUsbClaim[] {
	return Object.hasOwn(UFI_USB_EVIDENCE, usbId)
		? UFI_USB_EVIDENCE[usbId as keyof typeof UFI_USB_EVIDENCE]
		: [];
}

/** Qualcomm's DIAG interface: vendor-specific class/subclass with protocol 0x30. */
const DIAG_INTERFACE_CLASS = 0xff;
const DIAG_INTERFACE_SUBCLASS = 0xff;
const DIAG_INTERFACE_PROTOCOL = 0x30;

export type UfiUsbInterfaceDescriptor = {
	readonly number: number;
	readonly interfaceClass: number;
	readonly interfaceSubClass: number;
	readonly interfaceProtocol: number;
};

export type UfiDiagEvidence =
	| { readonly state: 'descriptor-confirmed'; readonly interfaceNumber: number }
	| {
			readonly state: 'not-proven';
			readonly reason: 'product-id-is-not-evidence' | 'no-diag-interface-descriptor';
	  };

export function classifyUfiDiagEvidence(input: {
	readonly usbId: string;
	readonly interfaces: readonly UfiUsbInterfaceDescriptor[];
}): UfiDiagEvidence {
	const diag = input.interfaces.find(
		(descriptor) =>
			descriptor.interfaceClass === DIAG_INTERFACE_CLASS &&
			descriptor.interfaceSubClass === DIAG_INTERFACE_SUBCLASS &&
			descriptor.interfaceProtocol === DIAG_INTERFACE_PROTOCOL,
	);
	if (diag !== undefined) {
		return { state: 'descriptor-confirmed', interfaceNumber: diag.number };
	}
	return input.interfaces.length === 0
		? { state: 'not-proven', reason: 'product-id-is-not-evidence' }
		: { state: 'not-proven', reason: 'no-diag-interface-descriptor' };
}

/**
 * Unconditional. A descriptor-confirmed DIAG channel raises what a SUPERVISED BENCH
 * operator may attempt by hand; it never raises what this package may do on its own.
 */
export const UFI_DIAG_PRODUCTION_ACCESS = 'prohibited' as const;
