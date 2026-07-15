// CellularSnapshot — the whole coherent state of one modem at one revision.
//
// A snapshot composes the identity and all eight orthogonal dimensions plus a
// monotonic `revision`. Every snapshot that exists has passed the guards: the
// constructors here are the ONLY sanctioned way to build or advance one, so an
// impossible combination can never be observed downstream. Revisions strictly
// increase, letting the observer (A3.1) and consumers order and dedupe events.

import type { Brand } from './brand';
import { nonNegativeInteger } from './brand';
import { RevisionMonotonicityError } from './errors';
import { assertSnapshot } from './guards';
import type { ModemIdentity } from './identity';
import type {
	DataInterface,
	MmState,
	NmActivation,
	Presence,
	RadioPower,
	ReconcileStatus,
	RecoveryState,
	Registration,
	SimSlot,
	SourceHealth,
} from './state';

/** A monotonically increasing snapshot revision. */
export type Revision = Brand<number, 'Revision'>;

/** Construct a `Revision` from a non-negative integer. */
export function revision(value: number): Revision {
	return nonNegativeInteger(value, 'revision') as Revision;
}

/** The revision every fresh identity starts at. */
export const INITIAL_REVISION: Revision = revision(0);

/** The next revision after `current`. */
export function nextRevision(current: Revision): Revision {
	return (current + 1) as Revision;
}

/** The full coherent state of one modem at one point in time. */
export interface CellularSnapshot {
	readonly identity: ModemIdentity;
	readonly presence: Presence;
	readonly sourceHealth: SourceHealth;
	readonly simSlots: readonly SimSlot[];
	readonly radioPower: RadioPower;
	readonly mmState: MmState;
	readonly registration: Registration;
	readonly nmActivation: NmActivation;
	readonly dataInterface: DataInterface;
	readonly reconcileStatus: ReconcileStatus;
	readonly recoveryState: RecoveryState;
	readonly revision: Revision;
}

/** A partial update to a snapshot's dimensions; `revision` is managed, not patched. */
export type SnapshotPatch = Partial<Omit<CellularSnapshot, 'revision'>>;

/**
 * Validate and return a snapshot. The guards run here: an impossible combination
 * throws `ImpossibleStateError` rather than producing an incoherent value. This
 * is the sole sanctioned constructor for an arbitrary snapshot.
 */
export function createSnapshot(fields: CellularSnapshot): CellularSnapshot {
	assertSnapshot(fields);
	return fields;
}

/** A valid baseline for a freshly-observed-but-absent modem, at revision 0. */
export function initialSnapshot(identity: ModemIdentity): CellularSnapshot {
	return {
		identity,
		presence: 'absent',
		sourceHealth: 'live',
		simSlots: [],
		radioPower: 'unknown',
		mmState: 'unknown',
		registration: { status: 'unknown', activeRats: new Set() },
		nmActivation: 'unavailable',
		dataInterface: { present: false },
		reconcileStatus: 'pending',
		recoveryState: { stage: 'idle', attempts: 0 },
		revision: INITIAL_REVISION,
	};
}

/**
 * Apply a dimension patch, bump the revision, and re-validate. Monotonicity is
 * automatic (revision always advances by one); an impossible result throws.
 */
export function applyTransition(prev: CellularSnapshot, patch: SnapshotPatch): CellularSnapshot {
	const next: CellularSnapshot = { ...prev, ...patch, revision: nextRevision(prev.revision) };
	assertSnapshot(next);
	return next;
}

/**
 * Replace a snapshot with a fully-formed successor that carries its own revision
 * (the observer path). Enforces strict monotonicity — a stale or equal revision
 * throws `RevisionMonotonicityError` — and validates the successor.
 */
export function supersede(prev: CellularSnapshot, next: CellularSnapshot): CellularSnapshot {
	if (next.revision <= prev.revision) {
		throw new RevisionMonotonicityError(prev.revision, next.revision);
	}
	assertSnapshot(next);
	return next;
}

/**
 * The source (MM daemon / bus) dropped: mark the data `sourceUnavailable` while
 * KEEPING presence and all other facts. Stale is never removal — only an
 * authoritative snapshot confirms absence (draft §Oracle round-1 lifecycle).
 */
export function markSourceUnavailable(prev: CellularSnapshot): CellularSnapshot {
	return applyTransition(prev, { sourceHealth: 'sourceUnavailable' });
}
