// The gated USSD capability module — session state machine, refusal taxonomy, and
// the ModemManager `Modem3gpp.Ussd` adapter.
//
// GATED: nothing here runs unless the operator has enabled the `ussd` capability
// module and the modem positively advertises the interface (`../capability`).
// LEASE-ONLY: a USSD session cannot re-register the radio, so it takes the
// per-modem mutation lease and is NOT journaled.

export {
	callCancel,
	callInitiate,
	callRespond,
	decodeRepliedState,
	readUssdState,
	USSD_STATE_ACTIVE,
	USSD_STATE_IDLE,
	USSD_STATE_UNKNOWN,
	USSD_STATE_USER_RESPONSE,
	type UssdCallTarget,
} from './calls';
export {
	MmUssd,
	type MmUssdDeps,
	type UssdScheduler,
	type UssdTimerHandle,
	type UssdVerbResult,
} from './mm-ussd';
export {
	classifyUssdFailure,
	isPacketSwitchedOnly,
	USSD_REFUSAL_REASONS,
	type UssdRefusalReason,
	type UssdRegistrationFacts,
} from './refusal';
export {
	decodeAccessTechnologies,
	readUssdRegistrationFacts,
	registrationFactsFromTree,
	UNKNOWN_REGISTRATION,
} from './registration';
export {
	IDLE_SESSION,
	isUssdSessionOpen,
	reduceUssdSession,
	USSD_SESSION_OUTCOMES,
	USSD_SESSION_STATES,
	type UssdRepliedState,
	type UssdSessionEvent,
	type UssdSessionOutcome,
	type UssdSessionSnapshot,
	type UssdSessionState,
	type UssdTransition,
} from './session';
