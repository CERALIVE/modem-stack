// The MM-faithful object model, in `@httptoolkit/dbus-native` ENCODE form.
//
// This is the architectural heart of the fake: it models the REAL ModemManager
// object tree, not a flattened convenience shape. The two corrections review
// insisted on (draft §Oracle round-2 #6, round-4) are encoded here structurally:
//
//   1. A modem exposes `Modem` and `Modem.Modem3gpp` as SEPARATE D-Bus interfaces
//      under one object path — never merged into a single interface.
//   2. SIMs are SEPARATE objects at `/org/freedesktop/ModemManager1/SIM/<n>`,
//      reachable from the modem's `Sim` property (an object path), never inlined.
//   3. `Modem.Device` carries the udev slot UID on ALL versions; `Physdev` exists
//      ONLY from 1.22+ — the 1.20-shape omits it, the 1.22- and 1.24-shapes include it.
//
// Every value below is already in the library's native encode form (a variant is
// `[signature, value]`, a dict is an array of `[key, value]` entries), so the tree
// marshals straight onto the wire and the transport decodes it symmetrically.

export const ROOT_PATH = '/org/freedesktop/ModemManager1';
export const BUS_NAME = 'org.freedesktop.ModemManager1';

export const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
export const MODEM_IFACE = 'org.freedesktop.ModemManager1.Modem';
export const MODEM3GPP_IFACE = 'org.freedesktop.ModemManager1.Modem.Modem3gpp';
export const SIMPLE_IFACE = 'org.freedesktop.ModemManager1.Modem.Simple';
export const SIM_IFACE = 'org.freedesktop.ModemManager1.Sim';
export const BEARER_IFACE = 'org.freedesktop.ModemManager1.Bearer';

/** Which ModemManager property shape a scenario presents (1.22+ adds `Physdev`). */
export type MmShape = '1.20' | '1.22' | '1.24';

/** A variant in encode form: `[signature, value]`. */
export type EncodeVariant = readonly [string, unknown];
/** One `a{sv}` entry: `[propertyName, variant]`. */
export type PropEntry = readonly [string, EncodeVariant];
/** One interface's property set. */
export type InterfaceEntry = readonly [string, readonly PropEntry[]];
/** One managed object: `[objectPath, interfaces]` (an `oa{sa{sv}}` pair). */
export type ManagedObject = readonly [string, readonly InterfaceEntry[]];
/** The full `a{oa{sa{sv}}}` GetManagedObjects payload. */
export type ManagedObjects = readonly ManagedObject[];

/** A visible network row returned by `Modem3gpp.Scan` (`a{sv}`). */
export interface ScannedNetworkEntry {
	readonly operatorCode: string;
	readonly operatorName?: string;
	/** MMModem3gppNetworkAvailability: 0 unknown, 1 available, 2 current, 3 forbidden. */
	readonly availability: number;
	/** MMModemAccessTechnology bitmask (e.g. 1<<14 = LTE). */
	readonly accessTechnology?: number;
}

/** One SIM card, modeled as its own `/SIM/<n>` object. */
export interface SimSpec {
	/** Global SIM index → `/org/freedesktop/ModemManager1/SIM/<index>`. */
	readonly index: number;
	readonly iccid: string;
	readonly imsi: string;
	readonly operatorName?: string;
	readonly operatorCode?: string;
	/** Slot currently selected as primary (drives the modem's `Sim` path). */
	readonly active?: boolean;
}

/** One modem, with separate `Modem` + `Modem3gpp` interfaces and a bearer tripwire. */
export interface ModemSpec {
	/** Modem index → `/org/freedesktop/ModemManager1/Modem/<index>`. */
	readonly index: number;
	readonly manufacturer?: string;
	readonly model?: string;
	readonly revision?: string;
	/** IMEI / equipment id. */
	readonly equipmentId?: string;
	/** udev slot UID (or device path). Present on the `Modem.Device` prop, ALL versions. */
	readonly device?: string;
	/** Physical device path — only surfaced on the 1.24-shape (`Physdev`, 1.22+). */
	readonly physdev?: string;
	/** MMModemState (e.g. 8 registered, 11 connected). */
	readonly state?: number;
	/** Signal quality percent (0-100) for the `(ub)` SignalQuality struct. */
	readonly signalQuality?: number;
	/** MMModem3gppRegistrationState (1 home, 5 roaming). */
	readonly registrationState?: number;
	readonly sims: readonly SimSpec[];
	readonly primarySimSlot?: number;
	/** The bearer index → `/org/freedesktop/ModemManager1/Bearer/<index>`. */
	readonly bearerIndex?: number;
}

export const modemPath = (index: number): string => `${ROOT_PATH}/Modem/${index}`;
export const simPath = (index: number): string => `${ROOT_PATH}/SIM/${index}`;
export const bearerPath = (index: number): string => `${ROOT_PATH}/Bearer/${index}`;

const activeSim = (spec: ModemSpec): SimSpec | undefined =>
	spec.sims.find((sim) => sim.active) ?? spec.sims[0];

const modemBearerIndex = (spec: ModemSpec): number => spec.bearerIndex ?? spec.index;

/** The `Modem` interface property set. `Physdev` appears only on the 1.24-shape. */
export function modemProps(spec: ModemSpec, shape: MmShape): readonly PropEntry[] {
	const sim = activeSim(spec);
	const props: PropEntry[] = [
		['Manufacturer', ['s', spec.manufacturer ?? 'Fake Modems Inc.']],
		['Model', ['s', spec.model ?? 'FM-0']],
		['Revision', ['s', spec.revision ?? '1.0-fake']],
		['DeviceIdentifier', ['s', `fake-device-${spec.index}`]],
		['EquipmentIdentifier', ['s', spec.equipmentId ?? `35000000000000${spec.index}`]],
		// `Device` carries the slot UID on every MM version (draft round-4).
		['Device', ['s', spec.device ?? `/sys/devices/fake/usb${spec.index}`]],
		['State', ['i', spec.state ?? 8]],
		['PowerState', ['u', 3]],
		['SignalQuality', ['(ub)', [spec.signalQuality ?? 71, true]]],
		['Sim', ['o', sim ? simPath(sim.index) : '/']],
		['SimSlots', ['ao', spec.sims.map((each) => simPath(each.index))]],
		['PrimarySimSlot', ['u', spec.primarySimSlot ?? 0]],
		['Bearers', ['ao', [bearerPath(modemBearerIndex(spec))]]],
		['SupportedCapabilities', ['au', [4, 8]]],
		['CurrentCapabilities', ['u', 4]],
		['CurrentModes', ['(uu)', [7, 0]]],
	];
	// `Physdev` (physical path) exists from 1.22+ — present on 1.22 and 1.24, absent on 1.20.
	if (shape === '1.22' || shape === '1.24') {
		props.push(['Physdev', ['s', spec.physdev ?? `/sys/devices/fake/usb${spec.index}`]]);
	}
	return props;
}

/** The SEPARATE `Modem.Modem3gpp` interface property set. */
export function modem3gppProps(spec: ModemSpec): readonly PropEntry[] {
	const sim = activeSim(spec);
	return [
		['Imei', ['s', spec.equipmentId ?? `35000000000000${spec.index}`]],
		['OperatorCode', ['s', sim?.operatorCode ?? '00101']],
		['OperatorName', ['s', sim?.operatorName ?? 'Fake Network']],
		['RegistrationState', ['u', spec.registrationState ?? 1]],
		['EnabledFacilityLocks', ['u', 0]],
	];
}

/** A SIM object's `Sim` interface property set. */
export function simProps(sim: SimSpec): readonly PropEntry[] {
	return [
		['SimIdentifier', ['s', sim.iccid]],
		['Imsi', ['s', sim.imsi]],
		['OperatorIdentifier', ['s', sim.operatorCode ?? '00101']],
		['OperatorName', ['s', sim.operatorName ?? 'Fake Network']],
		['Active', ['b', sim.active ?? true]],
	];
}

/** A bearer object's property set — observable, but every connect method throws. */
export function bearerProps(): readonly PropEntry[] {
	return [
		['Connected', ['b', false]],
		['Suspended', ['b', false]],
		['Interface', ['s', '']],
	];
}

/** The managed object for a modem: two SEPARATE interfaces under one path. */
export function modemObject(spec: ModemSpec, shape: MmShape): ManagedObject {
	return [
		modemPath(spec.index),
		[
			[MODEM_IFACE, modemProps(spec, shape)],
			[MODEM3GPP_IFACE, modem3gppProps(spec)],
		],
	];
}

/** The managed object for a SIM — a top-level `/SIM/<n>` object. */
export function simObject(sim: SimSpec): ManagedObject {
	return [simPath(sim.index), [[SIM_IFACE, simProps(sim)]]];
}

/** The managed object for a bearer — observable in the tree, tripwired on connect. */
export function bearerObject(spec: ModemSpec): ManagedObject {
	return [bearerPath(modemBearerIndex(spec)), [[BEARER_IFACE, bearerProps()]]];
}

/** Every managed object a modem contributes: the modem, its SIMs, and its bearer. */
export function modemObjects(spec: ModemSpec, shape: MmShape): readonly ManagedObject[] {
	return [modemObject(spec, shape), ...spec.sims.map(simObject), bearerObject(spec)];
}

/** Build the full `a{oa{sa{sv}}}` tree from the live modem specs. */
export function managedObjects(specs: readonly ModemSpec[], shape: MmShape): ManagedObjects {
	return specs.flatMap((spec) => modemObjects(spec, shape));
}

/** Encode a scanned-network row as a `Modem3gpp.Scan` `a{sv}` entry list. */
export function scanEntry(network: ScannedNetworkEntry): readonly PropEntry[] {
	const props: PropEntry[] = [
		['status', ['u', network.availability]],
		['operator-code', ['s', network.operatorCode]],
	];
	if (network.operatorName !== undefined) {
		props.push(['operator-long', ['s', network.operatorName]]);
		props.push(['operator-short', ['s', network.operatorName]]);
	}
	if (network.accessTechnology !== undefined) {
		props.push(['access-technology', ['u', network.accessTechnology]]);
	}
	return props;
}
