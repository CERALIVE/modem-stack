// Typed errors for the domain layer.
//
// The domain never fails silently: an impossible state combination, a refused
// policy binding, or a non-monotonic revision each raise a distinct, catchable
// error class carrying a machine-readable reason. QA and callers discriminate on
// the class and the `code`, never on a message string.

/** Base class for every domain-layer error. Callers can catch this to trap all. */
export class DomainError extends Error {
	override readonly name: string = 'DomainError';

	constructor(message: string) {
		super(message);
		// Restore the prototype chain across the ES5 target transpile so
		// `instanceof` works on subclasses (standard TS extends-Error guard).
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/**
 * Every distinct impossible cross-dimension combination the guards reject.
 * One code per rule so a failing construction names exactly what it violated.
 */
export type ImpossibleStateCode =
	| 'registered-while-absent'
	| 'registered-radio-off'
	| 'registered-empty-rat-set'
	| 'active-state-while-absent'
	| 'radio-off-while-active'
	| 'nm-activated-while-absent'
	| 'nm-activated-without-interface'
	| 'nm-activated-without-mm-connected'
	| 'multiple-active-sim-slots'
	| 'locked-sim-in-empty-slot'
	| 'mm-locked-without-sim-lock'
	| 'data-interface-name-without-presence'
	| 'recovery-attempts-negative'
	| 'recovery-cooldown-stage-mismatch'
	| 'recovery-idle-with-attempts';

/** A snapshot was constructed (or transitioned into) a physically impossible state. */
export class ImpossibleStateError extends DomainError {
	override readonly name = 'ImpossibleStateError';
	readonly code: ImpossibleStateCode;

	constructor(code: ImpossibleStateCode, detail: string) {
		super(`impossible cellular state [${code}]: ${detail}`);
		this.code = code;
	}
}

/**
 * A durable policy binding was attempted against an identity that is not allowed
 * to carry one — today only low-confidence (ambiguous) equipment identities.
 */
export class PolicyBindingRefusedError extends DomainError {
	override readonly name = 'PolicyBindingRefusedError';
	readonly reason: 'ambiguous-identity';

	constructor(detail: string) {
		super(`durable policy binding refused: ${detail}`);
		this.reason = 'ambiguous-identity';
	}
}

/** A snapshot transition tried to keep or lower the monotonic revision. */
export class RevisionMonotonicityError extends DomainError {
	override readonly name = 'RevisionMonotonicityError';
	readonly previous: number;
	readonly next: number;

	constructor(previous: number, next: number) {
		super(`revision must strictly increase: ${previous} -> ${next}`);
		this.previous = previous;
		this.next = next;
	}
}
