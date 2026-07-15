// Nominal (branded) primitive types for the domain layer.
//
// Branding stops the four identity strings — and the two counter numbers — from
// being interchangeable at the type level: a `LogicalSlotId` can never be passed
// where a `SubscriptionId` is expected, even though both are strings at runtime.
// Downstream waves (A2.2 ports, A3.x D-Bus backend) depend on this distinction.

import { DomainError } from './errors';

declare const brand: unique symbol;

/** A primitive `T` tagged with a compile-time-only brand `B`. Erased at runtime. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Assert a value is a non-empty string, throwing a typed error otherwise. */
export function nonEmptyString(value: string, label: string): string {
	if (value.length === 0) {
		throw new DomainError(`${label} must be a non-empty string`);
	}
	return value;
}

/** Assert a value is a non-negative safe integer, throwing a typed error otherwise. */
export function nonNegativeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new DomainError(`${label} must be a non-negative safe integer, got ${value}`);
	}
	return value;
}
