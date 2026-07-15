// Public surface of the MM-faithful fake service. The A3.x D-Bus backend tests import
// the `FakeModemManager` service, the `ModemSpec` / `SimSpec` scenario types, the path
// and interface-name constants, and the decoded-tree walk helpers from here.

export type { BusAddress } from './bus-session';
export {
	BEARER_IFACE,
	BUS_NAME,
	bearerPath,
	type EncodeVariant,
	type InterfaceEntry,
	type ManagedObject,
	type ManagedObjects,
	type MmShape,
	MODEM_IFACE,
	MODEM3GPP_IFACE,
	type ModemSpec,
	modemPath,
	OBJECT_MANAGER_IFACE,
	type PropEntry,
	ROOT_PATH,
	type ScannedNetworkEntry,
	SIM_IFACE,
	SIMPLE_IFACE,
	type SimSpec,
	simPath,
} from './object-model';
export { FakeModemManager, type FakeModemManagerOptions, TRIPWIRE_ERROR } from './service';
export {
	asManagedObjects,
	type DecodedInterfaces,
	type DecodedManagedObjects,
	type DecodedObject,
	type DecodedProps,
	fetchManagedObjects,
	findInterface,
	findObject,
	followObjectPath,
	hasInterface,
	interfaceNames,
	objectPaths,
	pathsWithInterface,
	propValue,
} from './tree';
