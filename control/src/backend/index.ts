// Backend adapters — the concrete D-Bus implementations of the port contracts.
//
// A3.1 lands the epoch-scoped `MmDbusObserver` (the read side). A3.2 adds MM
// feature detection + the stable identity ladder. Later A3 waves add mutations +
// Signal.Setup (A3.3) and the recovery ladder (A3.4) here.

export { MM_BUS_NAME, MM_ROOT_PATH, MODEM_IFACE, MODEM3GPP_IFACE, SIM_IFACE } from './constants';
export {
	detectMmFeatures,
	detectModemFeatures,
	type MmFeatures,
	type MmPropertyProbe,
	type MmVersion,
	parseMmVersion,
	probeModemProperties,
} from './features';
export {
	looksLikeSlotUid,
	type ModemIdentityFacts,
	modemIdentityFactsFromTree,
	type ResolvedIdentity,
	resolveModemIdentities,
	resolveModemIdentity,
	SLOT_UID_PREFIX,
	type SlotSource,
} from './identity-ladder';
export {
	IdentityRegistry,
	type IdentityRow,
	type IdentityTransition,
} from './identity-registry';
export { createMmDbusObserver, MmDbusObserver, type MmDbusObserverOptions } from './observer';
