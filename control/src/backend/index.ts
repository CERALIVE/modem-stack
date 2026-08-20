// Backend adapters — the concrete D-Bus implementations of the port contracts.
//
// A3.1 lands the epoch-scoped `MmDbusObserver` (the read side). A3.2 adds MM
// feature detection + the stable identity ladder. Later A3 waves add mutations +
// Signal.Setup (A3.3) and the recovery ladder (A3.4) here.

export {
	AT_BASELINE_ALLOWLIST,
	type AtAuditEntry,
	type AtAuditSink,
	AtCommandLease,
	type AtCommandLeaseDeps,
	AtCommandNotAllowedError,
	type AtCommandSender,
	AtCommandTimeoutError,
	type AtResponse,
	computeAtAllowlist,
} from './at-lease';
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
	MODEM_LOCATION_IFACE,
	MODEM3GPP_IFACE,
	MODEM3GPP_USSD_IFACE,
	SIM_IFACE,
} from './constants';
export {
	CELLULAR_USB_VENDOR_IDS,
	cellularEvidence,
	cellularVendorName,
	classifyDevice,
	classifyUsbNetDevice,
	type DeviceClass,
	type DeviceClassification,
	descriptorsMatch,
	detectUsbMode,
	modelLabel,
	publishesGenericIdentity,
	type UsbDeviceSnapshot,
	type UsbInterface,
	type UsbNetClass,
	type UsbNetClassification,
	unitDiscriminator,
	vendorLabel,
} from './device-classifier';
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
	ALLOW_ALL_INTERLOCK,
	type InterlockDecision,
	type InterlockTarget,
	type LifecycleInterlock,
} from './lifecycle-interlock';
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
	numberProp,
	objectPaths,
	pathsWithInterface,
	propValue,
	stringProp,
} from './managed-objects';
export {
	createMmDbusBackend,
	MmDbusBackend,
	type MmDbusBackendOptions,
} from './mm-backend';
export {
	decodeLocationSources,
	encodeLocationSources,
	MmLocation,
	type MmLocationDeps,
} from './mm-location';
export { MmMutations, type MmMutationsDeps } from './mm-mutations';
export {
	ModemActor,
	NO_OP_QUIESCE,
	type QuiesceHook,
	type QuiesceLeaseHandle,
	type QuiesceTarget,
} from './modem-actor';
export {
	AUTO_APN_ADVISORY,
	type AutoApnAdvisory,
	type AutoApnTransitionResult,
	autoApnCapableFromVersion,
	autoApnSupportedByVersion,
	classifyActivation,
	type ManualApn,
	parseNmVersion,
	probeAutoApnCapability,
	toAutoArgs,
	toManualArgs,
} from './nm-auto-apn';
export {
	buildProfile,
	cliArg,
	createGsmArgs,
	flattenPairs,
	gsmFieldPairs,
	passwordFlags,
	patchPairs,
} from './nm-gsm-fields';
export {
	NmcliNmPort,
	type NmcliNmPortOptions,
} from './nmcli-nm-port';
export {
	type NmcliResult,
	type NmcliRunner,
	parseTerse,
	runNmcli,
	SpawnNmcliRunner,
} from './nmcli-runner';
export {
	createMmDbusObserver,
	type EpochRefreshEvent,
	MmDbusObserver,
	type MmDbusObserverOptions,
} from './observer';
export {
	NONE_POWER_CAPABILITY,
	NONE_POWER_HOOK,
	type PowerCapability,
	type PowerCapabilityKind,
	type PowerCycleContext,
	type PowerCycleResult,
	type PowerHook,
	type PreferredUsbMode,
	unsupportedPowerHook,
} from './power-contract';
export {
	attributeFault,
	attributeSnapshot,
	type FaultAttribution,
	type FaultSymptoms,
	symptomsFromSnapshot,
} from './recovery-attribution';
export {
	type BudgetDecision,
	beginAttempt,
	DEFAULT_RECOVERY_BUDGET,
	INITIAL_BUDGET_STATE,
	markRecovered,
	type RecoveryBudget,
	type RecoveryBudgetState,
} from './recovery-budget';
export {
	DEFAULT_LADDER_CONFIG,
	LADDER_ORDER,
	RecoveryLadder,
	type RecoveryLadderConfig,
	type RecoveryLadderDeps,
	type RecoveryOutcome,
	type RecoveryOutcomeKind,
	type RecoveryRequest,
	type RecoveryRung,
	type RecoveryStepContext,
	type RecoveryStepGate,
	type RecoveryStepReport,
	type RecoverySteps,
	type StepOutcome,
} from './recovery-ladder';
export { createRouterEthernetProbe, type RouterEthernetProbeDeps } from './router-ethernet';
export {
	DEFAULT_SIGNAL_INTERVAL_SECONDS,
	type SignalCadence,
	SignalSetupManager,
	type SignalSetupManagerOptions,
} from './signal-setup';
export { sendSimPin, sendSimPuk } from './sim-unlock';
export {
	ALLOW_ALL_TRANSITION_INTERLOCK,
	checkTransitionPreconditions,
	type InterlockHold,
	type PreconditionResult,
	type TransitionInterlock,
	type TransitionReadiness,
	type UsbModeTransitionOutcome,
	type UsbModeTransitionRequest,
} from './transition-preconditions';
export {
	createUhubctlPowerHook,
	parseUhubctlPortMap,
	readUhubctlPortMap,
	SpawnUhubctlRunner,
	type UhubctlPortMap,
	type UhubctlPortMapping,
	type UhubctlPowerHookDeps,
	type UhubctlResult,
	type UhubctlRunner,
	type UsbEnumerationPoller,
	uhubctlCycleArgv,
	uhubctlPortMappingSchema,
	uhubctlPortMapSchema,
} from './uhubctl-power-hook';
export * from './usage';
export {
	createUsbEnumerator,
	enumerateUsbDevices,
	parseUdevDatabase,
	type UsbEnumerator,
	type UsbEnumeratorDeps,
} from './usb-enumerator';
export { UsbModeTransition, type UsbModeTransitionDeps } from './usb-mode-transition';
