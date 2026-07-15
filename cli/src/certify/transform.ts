// Turning raw capture output into redaction-walkable, JSON-safe shapes.
//
// The shared redactor (`@ceralive/modem-control` `redact`) is KEY-BASED: it walks plain
// objects and masks the value under a sensitive key (`iccid`, `imsi`, `eid`, …), matching
// the last dotted segment too (so `sim.properties.iccid` is caught). Two capture inputs
// carry SIM subscriber secrets and therefore MUST be handed to the redactor as objects,
// not raw text:
//   * `mmcli -K` — a keyfile of `a.b.c : value` lines → a flat `{ "a.b.c": value }` map;
//     `sim.properties.iccid` / `.imsi` / `.eid` are then masked by dotted-segment match.
//   * `GetManagedObjects` — the decoded D-Bus tree → nested `{ path: { iface: { prop } } }`.
// ModemManager exposes the ICCID as the property `SimIdentifier`, the ONE secret whose
// raw name the shared redactor does not recognize; we surface it under its canonical name
// `iccid` (exactly the domain layer's `SimIdentifier → subscriptionId` mapping) so the
// redactor masks it. `Imsi` and `Eid` already match by name.

import type {
	DecodedInterfaces,
	DecodedManagedObjects,
	DecodedProps,
	ExpectedDescriptors,
	SkuDiscriminator,
	UsbDeviceSnapshot,
} from '@ceralive/modem-control';
import { type DbusValue, isVariant } from '@ceralive/modem-control/transport';

/** MM's ICCID property name; surfaced as `iccid` so the shared redactor masks it. */
const SIM_IDENTIFIER_PROP = 'SimIdentifier';

/** A JSON-safe value — what the objectified tree and parsed keyfile contain. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/** Parse `mmcli -K` keyfile text (`a.b.c : value` lines) into a flat map. */
export function parseKeyfile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const sep = line.indexOf(':');
		if (sep < 0) {
			continue;
		}
		const key = line.slice(0, sep).trim();
		if (key === '') {
			continue;
		}
		out[key] = line.slice(sep + 1).trim();
	}
	return out;
}

/** Convert a decoded D-Bus value to a JSON-safe one (bigint→string, bytes→numbers). */
function jsonValue(value: DbusValue): JsonValue {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (value instanceof Uint8Array) {
		return Array.from(value);
	}
	if (isVariant(value)) {
		return jsonValue(value.value);
	}
	if (Array.isArray(value)) {
		return value.map(jsonValue);
	}
	return value;
}

/** Objectify one interface's `[propName, variant][]` into `{ prop: value }`. */
function objectifyProps(props: DecodedProps): Record<string, JsonValue> {
	const out: Record<string, JsonValue> = {};
	for (const [name, propVariant] of props) {
		const key = name === SIM_IDENTIFIER_PROP ? 'iccid' : name;
		out[key] = jsonValue(propVariant.value);
	}
	return out;
}

/** Objectify one object's `[iface, props][]` into `{ iface: { prop: value } }`. */
function objectifyInterfaces(interfaces: DecodedInterfaces): Record<string, JsonValue> {
	const out: Record<string, JsonValue> = {};
	for (const [iface, props] of interfaces) {
		out[iface] = objectifyProps(props);
	}
	return out;
}

/**
 * Objectify a decoded `GetManagedObjects` tree into `{ path: { iface: { prop } } }`.
 * The result is plain objects and JSON primitives only — walkable by the shared
 * key-based redactor and safe to serialize into the bundle.
 */
export function objectifyManagedObjects(
	tree: DecodedManagedObjects,
): Record<string, Record<string, JsonValue>> {
	const out: Record<string, Record<string, JsonValue>> = {};
	for (const [path, interfaces] of tree) {
		out[path] = objectifyInterfaces(interfaces);
	}
	return out;
}

/**
 * Derive the `ExpectedDescriptors` shape (A4.2's catalog postcondition) from a live USB
 * device snapshot — the before/after descriptors of transition-evidence mode. A human
 * reviewer copies the `after` descriptors straight into a new catalog entry.
 */
export function descriptorsOf(device: UsbDeviceSnapshot): ExpectedDescriptors {
	return {
		deviceClass: device.bDeviceClass,
		interfaces: device.interfaces.map((i) => ({
			interfaceClass: i.interfaceClass,
			interfaceSubClass: i.interfaceSubClass,
			interfaceProtocol: i.interfaceProtocol,
		})),
	};
}

/**
 * Build the SKU discriminator (VID:PID + model + firmware prefix) from a device, or
 * `undefined` when the device lacks a model or firmware string — the three parts the
 * certified catalog matches on. A partial SKU is not a certified device.
 */
export function skuOf(device: UsbDeviceSnapshot): SkuDiscriminator | undefined {
	if (device.model === undefined || device.firmwareRevision === undefined) {
		return undefined;
	}
	return {
		vidPid: `${device.vendorId}:${device.productId}`,
		model: device.model,
		firmwarePrefix: device.firmwareRevision,
	};
}
