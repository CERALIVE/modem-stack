import { describe, expect, test } from 'bun:test';
import { ImpossibleStateError, RevisionMonotonicityError } from './errors';
import { imeiEquipmentId, type ModemIdentity, runtimePath } from './identity';
import {
	applyTransition,
	type CellularSnapshot,
	createSnapshot,
	initialSnapshot,
	markSourceUnavailable,
	revision,
	supersede,
} from './snapshot';
import {
	type DataInterface,
	epochMillis,
	isRegistered,
	MM_STATES_REQUIRING_RADIO,
	type MmState,
	type NmActivation,
	type RadioAccessTechnology,
	type RadioPower,
	type RecoveryStage,
	type RecoveryState,
	type RegistrationStatus,
	SIM_LOCK_REQUIRES_CARD,
	type SimLock,
	type SimSlot,
} from './state';

const IDENTITY: ModemIdentity = {
	equipmentId: imeiEquipmentId('490154203237518'),
	runtimePath: runtimePath('/org/freedesktop/ModemManager1/Modem/0'),
};

describe('reducers', () => {
	test('initialSnapshot is a valid absent baseline at revision 0', () => {
		const snapshot = initialSnapshot(IDENTITY);
		expect(snapshot.presence).toBe('absent');
		expect(snapshot.revision).toBe(revision(0));
		expect(() => createSnapshot(snapshot)).not.toThrow();
	});

	test('applyTransition bumps the revision by exactly one', () => {
		const start = initialSnapshot(IDENTITY);
		const next = applyTransition(start, { reconcileStatus: 'reconciling' });
		expect(next.revision).toBe(revision(1));
		expect(next.reconcileStatus).toBe('reconciling');
	});

	test('applyTransition re-validates and throws on an impossible patch', () => {
		const start = applyTransition(initialSnapshot(IDENTITY), {
			presence: 'present',
			radioPower: 'on',
			mmState: 'registered',
			registration: { status: 'home', activeRats: new Set(['lte']) },
		});
		expect(() => applyTransition(start, { presence: 'absent' })).toThrow(ImpossibleStateError);
	});

	test('markSourceUnavailable keeps presence and marks the source, bumping revision', () => {
		const present = applyTransition(initialSnapshot(IDENTITY), { presence: 'present' });
		const unavailable = markSourceUnavailable(present);
		expect(unavailable.presence).toBe('present');
		expect(unavailable.sourceHealth).toBe('sourceUnavailable');
		expect(unavailable.revision).toBe(revision(2));
	});

	test('supersede rejects a stale or equal revision', () => {
		const current = applyTransition(initialSnapshot(IDENTITY), { reconcileStatus: 'converged' });
		const stale: CellularSnapshot = { ...initialSnapshot(IDENTITY), revision: revision(0) };
		expect(() => supersede(current, stale)).toThrow(RevisionMonotonicityError);
	});

	test('supersede accepts a strictly-newer valid snapshot', () => {
		const current = initialSnapshot(IDENTITY);
		const newer: CellularSnapshot = { ...initialSnapshot(IDENTITY), revision: revision(9) };
		expect(supersede(current, newer).revision).toBe(revision(9));
	});
});

// --- randomized property test ----------------------------------------------

const MM_STATES: readonly MmState[] = [
	'failed',
	'unknown',
	'initializing',
	'locked',
	'disabled',
	'enabled',
	'searching',
	'registered',
	'connecting',
	'connected',
];
const REG_STATUSES: readonly RegistrationStatus[] = [
	'idle',
	'home',
	'searching',
	'denied',
	'unknown',
	'roaming',
];
const NM_STATES: readonly NmActivation[] = [
	'unmanaged',
	'unavailable',
	'disconnected',
	'activating',
	'activated',
	'failed',
];
const POWERS: readonly RadioPower[] = ['unknown', 'off', 'low', 'on'];
const STAGES: readonly RecoveryStage[] = [
	'idle',
	'attributing',
	'nm-cycle',
	'mm-cycle',
	'reset',
	'power-cycle',
	'cooldown',
	'exhausted',
];
const LOCKS: readonly SimLock[] = [
	'unknown',
	'none',
	'sim-pin',
	'sim-puk',
	'net-pers',
	'permanently-blocked',
];
const RATS: readonly RadioAccessTechnology[] = ['gsm', 'umts', 'lte', '5gnr'];

/** Deterministic xorshift32 PRNG so a failing case is always reproducible. */
function makePrng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0xffffffff;
	};
}

function pick<T>(rng: () => number, values: readonly T[]): T {
	const index = Math.min(values.length - 1, Math.floor(rng() * values.length));
	return values[index] as T;
}

function randomSnapshot(rng: () => number): CellularSnapshot {
	const rats = new Set<RadioAccessTechnology>();
	for (const rat of RATS) {
		if (rng() < 0.5) {
			rats.add(rat);
		}
	}

	const slotCount = Math.floor(rng() * 3);
	const simSlots: SimSlot[] = [];
	for (let i = 0; i < slotCount; i += 1) {
		simSlots.push({
			index: i + 1,
			occupied: rng() < 0.7,
			active: rng() < 0.5,
			lock: pick(rng, LOCKS),
		});
	}

	let dataInterface: DataInterface;
	if (rng() < 0.6) {
		dataInterface = rng() < 0.5 ? { present: true, name: 'wwan0' } : { present: true };
	} else {
		dataInterface = rng() < 0.5 ? { present: false } : { present: false, name: 'wwan0' };
	}

	const stage = pick(rng, STAGES);
	const attempts = Math.floor(rng() * 4);
	const recoveryState: RecoveryState =
		rng() < 0.5
			? { stage, attempts, cooldownUntil: epochMillis(1_700_000_000_000) }
			: { stage, attempts };

	return {
		identity: IDENTITY,
		presence: rng() < 0.5 ? 'present' : 'absent',
		sourceHealth: pick(rng, ['live', 'stale', 'sourceUnavailable'] as const),
		simSlots,
		radioPower: pick(rng, POWERS),
		mmState: pick(rng, MM_STATES),
		registration: { status: pick(rng, REG_STATUSES), activeRats: rats },
		nmActivation: pick(rng, NM_STATES),
		dataInterface,
		reconcileStatus: pick(rng, [
			'converged',
			'reconciling',
			'pending',
			'divergent',
			'unsupported',
		] as const),
		recoveryState,
		revision: revision(Math.floor(rng() * 1_000_000)),
	};
}

/** Independent restatement of the invariants — never calls the guards under test. */
function assertInvariants(s: CellularSnapshot): void {
	if (isRegistered(s.registration.status)) {
		expect(s.presence).toBe('present');
		expect(s.radioPower).not.toBe('off');
		expect(s.registration.activeRats.size).toBeGreaterThan(0);
	}
	if (MM_STATES_REQUIRING_RADIO.has(s.mmState)) {
		expect(s.presence).toBe('present');
	}
	if (s.nmActivation === 'activated') {
		expect(s.presence).toBe('present');
		expect(s.dataInterface.present).toBe(true);
		expect(s.mmState).toBe('connected');
	}
	if (s.radioPower === 'off') {
		const onAir =
			MM_STATES_REQUIRING_RADIO.has(s.mmState) ||
			s.registration.status === 'searching' ||
			s.nmActivation === 'activating' ||
			s.nmActivation === 'activated';
		expect(onAir).toBe(false);
	}
	expect(s.simSlots.filter((slot) => slot.active).length).toBeLessThanOrEqual(1);
	for (const slot of s.simSlots) {
		if (!slot.occupied) {
			expect(SIM_LOCK_REQUIRES_CARD.has(slot.lock)).toBe(false);
		}
	}
	if (!s.dataInterface.present) {
		expect(s.dataInterface.name).toBeUndefined();
	}
	expect(s.recoveryState.attempts).toBeGreaterThanOrEqual(0);
	expect(s.recoveryState.cooldownUntil !== undefined).toBe(s.recoveryState.stage === 'cooldown');
}

describe('randomized property test', () => {
	test('every constructed snapshot upholds the invariants; every rejection is typed', () => {
		const rng = makePrng(0x9e3779b9);
		let constructed = 0;
		let rejected = 0;

		for (let i = 0; i < 5000; i += 1) {
			const candidate = randomSnapshot(rng);
			let built: CellularSnapshot | null = null;
			try {
				built = createSnapshot(candidate);
			} catch (error) {
				rejected += 1;
				expect(error).toBeInstanceOf(ImpossibleStateError);
				continue;
			}
			constructed += 1;
			assertInvariants(built);
			// The plan's headline invariant, stated on its own.
			expect(isRegistered(built.registration.status) && built.presence === 'absent').toBe(false);
		}

		expect(constructed).toBeGreaterThan(0);
		expect(rejected).toBeGreaterThan(0);
	});
});
