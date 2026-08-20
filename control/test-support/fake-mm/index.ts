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
	LOCATION_IFACE,
	type ManagedObject,
	type ManagedObjects,
	MESSAGING_IFACE,
	MM_LOCK_NONE,
	MM_LOCK_SIM_PIN,
	MM_LOCK_SIM_PUK,
	MM_MANAGER_IFACE,
	type MmShape,
	MODEM_IFACE,
	MODEM3GPP_IFACE,
	type ModemSpec,
	modemPath,
	OBJECT_MANAGER_IFACE,
	type PropEntry,
	ROOT_PATH,
	type ScannedNetworkEntry,
	SIGNAL_IFACE,
	SIM_IFACE,
	SIMPLE_IFACE,
	type SimSpec,
	simPath,
	USSD_IFACE,
} from './object-model';
export type { PreviousEpoch } from './previous-epoch';
export {
	FakeModemManager,
	type FakeModemManagerOptions,
	type LocationSetupCall,
	type SignalSetupCall,
	TRIPWIRE_ERROR,
} from './service';
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
