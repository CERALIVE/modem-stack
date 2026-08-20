import type {
	DesiredRadio,
	ObservationEnvelope,
	OperationDescriptor,
	OperationResult,
	RadioPower,
} from '../../domain';
import type { SimPresence, SimPresenceEvidence } from '../../hardware/router-parsers';
import type { GnssFixState } from '../../location';
import type { NormalizedModemObservation } from '../../observations';
import type {
	FixRead,
	GnssSource,
	LocationStatusResult,
	LocationToggleResult,
	ModemBands,
	ObservationList,
	ObservationListener,
	SmsObservationPort,
} from '../../ports';
import type { BandWriteCertification, ModeSelection, RadioModeTruth } from '../../radio';
import type { MmUssd, UssdVerbResult } from '../../ussd';
import type { ProviderExecutionContext, ProviderOperationsSurface } from '../contracts';
import type { ModemManagerRefusalReason } from './errors';

export type ModemManagerCapabilities = {
	readonly modeRead: boolean;
	readonly modeWrite: boolean;
	readonly bandRead: boolean;
	readonly bandWrite: boolean;
	readonly signalRead: boolean;
	readonly simRead: boolean;
	readonly multiSim: boolean;
	readonly location: boolean;
	readonly sms: boolean;
	readonly ussd: boolean;
	readonly powerRead: boolean;
};

export type ModemManagerRadioState = {
	readonly current: { readonly allowed: number; readonly preferred: number };
	readonly supported: readonly { readonly allowed: number; readonly preferred: number }[];
	/**
	 * The SAME properties decoded without loss — `preferred: 'none'` stays `none`, an
	 * unfamiliar mode bit stays offerable as `unknown-combination`, and a member that
	 * is not a `(uu)` lands in `undecodable` rather than vanishing. `supported` above
	 * is the pre-existing raw-mask view and DROPS a zero-allowed member; this one does
	 * not, which is the whole point of carrying both.
	 */
	readonly truth: RadioModeTruth;
};

export type ModemManagerSignalState = {
	readonly quality?: number;
	readonly recent?: boolean;
	readonly extendedAvailable: boolean;
};

export type ModemManagerSimState = {
	/**
	 * The modem exports an ACTIVE SIM object path. `true` is positive evidence of a
	 * SIM; `false` is NOT evidence of absence — read `presence` for that.
	 */
	readonly present: boolean;
	/** `absent` only ever comes from `StateFailedReason: sim-missing`. */
	readonly presence: SimPresence;
	readonly presenceEvidence: SimPresenceEvidence;
	readonly slotCount: number;
	readonly primarySlot: number;
	readonly lockRequired?: number;
	readonly simType?: number;
	readonly esimStatus?: number;
};

export type ModemManagerProviderSnapshot = {
	readonly modemPath: string;
	readonly capabilities: ModemManagerCapabilities;
	readonly radio: ModemManagerRadioState;
	/** The band-lock gate for THIS device, resolved from the shipped certification catalog. */
	readonly bandCertification: BandWriteCertification;
	readonly signal: ModemManagerSignalState;
	readonly sim: ModemManagerSimState;
	readonly power: RadioPower;
	readonly observation: ObservationEnvelope<NormalizedModemObservation>;
};

export type ModemManagerSnapshotResult =
	| ({ readonly ok: true } & ModemManagerProviderSnapshot)
	| { readonly ok: false; readonly reason: ModemManagerRefusalReason };

export interface ContextReadOperation<O> {
	readonly descriptor: OperationDescriptor<never, O>;
	read(context: ProviderExecutionContext): Promise<OperationResult<O>>;
}

export interface ContextWriteOperation<I, O> {
	/** The shape-only descriptor: what this operation is, before any device answered. */
	readonly descriptor: OperationDescriptor<I, O>;
	/**
	 * The descriptor as the LIVE device entitles it.
	 *
	 * A static descriptor cannot carry a device's own catalog, so it cannot say which
	 * mode combinations this modem advertises or whether this SKU's band lock is
	 * certified. Those are exactly the facts a consumer needs before it offers a
	 * control, so they are read here instead of being inferred from a capability flag.
	 */
	describe(context: ProviderExecutionContext): Promise<OperationDescriptor<I, O>>;
	read(context: ProviderExecutionContext): Promise<OperationResult<O>>;
	write(context: ProviderExecutionContext, input: I): Promise<OperationResult<O>>;
}

export type SmsPortResult =
	| { readonly ok: true; readonly port: SmsObservationPort }
	| { readonly ok: false; readonly reason: ModemManagerRefusalReason };

export interface ModemManagerProviderOperations extends ProviderOperationsSurface {
	readonly radio: ContextWriteOperation<DesiredRadio, ModemManagerRadioState>;
	/**
	 * The modem's OWN mode vocabulary — an advertised `(allowed, preferred)` pair,
	 * selected verbatim. Separate from `radio` because `DesiredRadio` is an ordered RAT
	 * preference and cannot express `preferred: none`, which real hardware advertises.
	 */
	readonly modes: ContextWriteOperation<ModeSelection, RadioModeTruth>;
	readonly bands: ContextWriteOperation<readonly string[], ModemBands>;
	readonly signal: ContextReadOperation<ModemManagerSignalState>;
	readonly sim: ContextReadOperation<ModemManagerSimState>;
	readonly power: ContextReadOperation<RadioPower>;
	readonly location: {
		status(context: ProviderExecutionContext): Promise<LocationStatusResult>;
		enable(
			context: ProviderExecutionContext,
			sources: readonly GnssSource[],
		): Promise<LocationToggleResult>;
		disable(context: ProviderExecutionContext): Promise<LocationToggleResult>;
		readFix(context: ProviderExecutionContext): Promise<FixRead>;
		state(context: ProviderExecutionContext): GnssFixState;
		tick(context: ProviderExecutionContext): GnssFixState;
	};
	sms(context: ProviderExecutionContext): Promise<SmsPortResult>;
	readonly ussd: MmUssd;
	initiateUssd(context: ProviderExecutionContext, ussdCommand: string): Promise<UssdVerbResult>;
	respondUssd(context: ProviderExecutionContext, ussdResponse: string): Promise<UssdVerbResult>;
	cancelUssd(context: ProviderExecutionContext): Promise<UssdVerbResult>;
	readonly fccCoverage: (
		vid: string | undefined,
		pid: string | undefined,
	) => 'present' | 'absent' | 'unknown';
}

export interface ModemManagerProviderLifecycle {
	start(): Promise<ObservationList>;
	observe(listener: ObservationListener): () => void;
	stop(): Promise<void>;
}
