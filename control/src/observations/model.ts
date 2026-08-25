// The normalized observation shape every source produces.
//
// It is deliberately NARROW. A field earns a slot here only when more than one source
// can express it and an operator surface acts on it; everything else stays verbatim in
// the diagnostics block rather than growing a per-vendor branch of the model. That is
// the whole trade this layer makes — one shape to render, nothing thrown away.
//
// Every leaf is a `NormalizedMetric`, so "the source cannot report this" and "the
// source did not report this on this read" are different values with different
// reasons rather than the same absent field.

import type { RadioAccessTechnology } from '../domain';
import type { SimPresenceEvidence } from '../hardware/router-parsers';
import type { NormalizedMetric } from './metric';
import type { ObservationDiagnostics, ObservationSourceKind } from './provenance';

export type NormalizedHardware = {
	/** The operator-facing model label, sanitized by the migrated presentation rules. */
	readonly label: NormalizedMetric<string>;
	/**
	 * The label plus a short equipment-identifier tail, as CeraUI has always rendered
	 * it. It embeds the last five digits of an IMEI, so it is display copy and must
	 * not be used as a key or written to a log.
	 */
	readonly displayName: NormalizedMetric<string>;
};

export type NormalizedRadio = {
	readonly modemState: NormalizedMetric<string>;
	readonly registration: NormalizedMetric<string>;
	readonly accessTechnologies: NormalizedMetric<readonly RadioAccessTechnology[]>;
	readonly modeLabel: NormalizedMetric<string>;
	/**
	 * The operator the modem is REGISTERED WITH right now — `Modem3gpp.OperatorName`.
	 *
	 * Deliberately NOT `Sim.OperatorName`, which is the HOME operator written into the
	 * SIM. The two agree on a home network and disagree the entire time a device is
	 * roaming, which is exactly when an operator is looking at this field.
	 */
	readonly operatorName: NormalizedMetric<string>;
	/**
	 * The registered operator's PLMN id (MCC+MNC) — `Modem3gpp.OperatorCode`.
	 *
	 * Kept as text, not a number: the MNC is two OR three digits and the width is
	 * significant, so `732101` and `73201` are different networks and a numeric
	 * round-trip would lose the leading zero that separates them.
	 */
	readonly operatorCode: NormalizedMetric<string>;
};

/**
 * Coarse registration context — WHICH CELL, not where the device is.
 *
 * This is the `3gpp-lac-ci` location source's output, and it is a different class of
 * datum from a GNSS fix: it names a cell in the operator's network and carries no
 * coordinate. That is why it lives here rather than behind the GPS module's privacy
 * fence, why `3gpp-lac-ci` stays outside `GNSS_SOURCES`, and why nothing on this path
 * enables a location source or flips `Location.Setup`'s `signal_location`.
 *
 * Both fields are the SOURCE'S OWN TEXT. ModemManager emits them as uppercase hex, the
 * ZTE and UFI admin APIs emit their own vendor spellings, and no radix is common to all
 * three — so parsing to a number here would render an identifier that matches nothing
 * an operator sees in `mmcli` or in the vendor's own web UI.
 *
 * EARFCN IS ABSENT ON PURPOSE and cannot be added from these sources. ModemManager
 * publishes no generic ARFCN anywhere on the `Modem`, `Modem3gpp` or `Location`
 * interfaces (checked against 1.24.2's introspection, not recalled); the only place one
 * appears is inside a PER-CELL `GetCellInfo` dict, under two DIFFERENT keys — `earfcn`
 * for LTE (`libmm-glib/mm-cell-info-lte.c`) and `nrarfcn` for 5GNR
 * (`libmm-glib/mm-cell-info-nr5g.c`). A single normalized slot would therefore have to
 * either merge two different quantities or silently pick a RAT, so this model makes no
 * ARFCN claim at all and `backend/cell-info.ts` keeps the per-cell reading where it
 * belongs.
 */
export type NormalizedCell = {
	readonly cellId: NormalizedMetric<string>;
	readonly tac: NormalizedMetric<string>;
};

/**
 * Signal metrics.
 *
 * `quality` and `bars`/`maxBars` are different measurements and both are kept:
 * ModemManager reports a 0-100 percentage and no bar count, while the router admin
 * APIs report a vendor bar scale and no percentage. Deriving one from the other would
 * be inventing a reading, so each source reports what it has and answers
 * `unsupported` — a positive claim — for what it structurally cannot.
 */
export type NormalizedSignal = {
	readonly quality: NormalizedMetric<number>;
	/**
	 * ModemManager's `SignalQuality` is a `(ub)` — a percentage AND a boolean saying
	 * whether it was measured recently or is the last cached reading. The boolean is a
	 * separate fact about the same measurement, so it gets its own metric rather than
	 * being folded into freshness: an envelope's staleness is about when WE read, this
	 * is about when the MODEM last measured. The router APIs have no such flag and say
	 * so with `unsupported`.
	 */
	readonly qualityRecent: NormalizedMetric<boolean>;
	readonly bars: NormalizedMetric<number>;
	readonly maxBars: NormalizedMetric<number>;
	readonly dbm: NormalizedMetric<number>;
	readonly rsrp: NormalizedMetric<number>;
	readonly rsrq: NormalizedMetric<number>;
	readonly snr: NormalizedMetric<number>;
	readonly sinr: NormalizedMetric<number>;
};

/**
 * SIM presence as a metric value is BINARY on purpose.
 *
 * The migrated `deriveSimPresence` answers `present | absent | unknown`; the third
 * member is not a presence, it is the absence of an answer, so it becomes the
 * metric's `unknown` state with a reason instead of a third value. That is what stops
 * "we could not tell" from being rendered beside "there is no SIM".
 */
export type SimPresenceValue = 'present' | 'absent';

export type NormalizedSim = {
	readonly presence: NormalizedMetric<SimPresenceValue>;
	/**
	 * WHICH FACT decided `presence`. Carried beside the metric rather than derived from
	 * it, because "absent" and "we could not tell" are read off the SAME empty fields
	 * and only the evidence separates them. `absent` is reachable through exactly one
	 * evidence kind (`state-failed-reason`), which is what makes "never inferred from a
	 * blank field" a property a test can assert rather than a convention.
	 */
	readonly presenceEvidence: SimPresenceEvidence;
	readonly lockRequired: NormalizedMetric<string>;
	readonly kind: NormalizedMetric<'physical' | 'esim'>;
	readonly esimStatus: NormalizedMetric<'no-profiles' | 'with-profiles'>;
};

export type NormalizedModemObservation = {
	readonly source: ObservationSourceKind;
	readonly hardware: NormalizedHardware;
	readonly radio: NormalizedRadio;
	readonly signal: NormalizedSignal;
	readonly sim: NormalizedSim;
	readonly cell: NormalizedCell;
	/** Everything the provider said, verbatim, plus what was and was not claimed. */
	readonly diagnostics: ObservationDiagnostics;
};
