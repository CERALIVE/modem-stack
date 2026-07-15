// Backend adapters — the concrete D-Bus implementations of the port contracts.
//
// A3.1 lands the epoch-scoped `MmDbusObserver` (the read side). A3.2 adds MM
// feature detection + the stable identity ladder. Later A3 waves add mutations +
// Signal.Setup (A3.3) and the recovery ladder (A3.4) here.

export {
	type CellInfoProvenance,
	type CellReading,
	compareServing,
	normalizeCellInfo,
	normalizeCellReading,
	selectServingCell,
} from './cell-info';
export {
	MM_BUS_NAME,
	MM_MANAGER_IFACE,
	MM_ROOT_PATH,
	MODEM_IFACE,
	MODEM3GPP_IFACE,
	SIM_IFACE,
} from './constants';
export {
	buildEnrichment,
	type EsimInfo,
	type EsimStatus,
	type ModemEnrichment,
	readEsimInfo,
	readRevision,
	type SimType,
} from './enrichment';
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
export {
	createMmDbusBackend,
	MmDbusBackend,
	type MmDbusBackendOptions,
} from './mm-backend';
export { MmMutations, type MmMutationsDeps } from './mm-mutations';
export {
	ModemActor,
	NO_OP_QUIESCE,
	type QuiesceHook,
	type QuiesceLeaseHandle,
	type QuiesceTarget,
} from './modem-actor';
export {
	createMmDbusObserver,
	type EpochRefreshEvent,
	MmDbusObserver,
	type MmDbusObserverOptions,
} from './observer';
export {
	DEFAULT_SIGNAL_INTERVAL_SECONDS,
	type SignalCadence,
	SignalSetupManager,
	type SignalSetupManagerOptions,
} from './signal-setup';
export { sendSimPin, sendSimPuk } from './sim-unlock';
