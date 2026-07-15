// Reconcile receipts — the HONEST outcome of trying to apply one policy dimension.
//
// Every attempt to converge a dimension yields exactly one receipt with a status
// AND a reason. Nothing is ever silently dropped: "prefer 5G" on a 4G-only modem is
// reported as `unsupported` with a reason, never quietly downgraded to "5G off".

/** The policy dimension a receipt is about. */
export type PolicyDimension =
	| 'enabled'
	| 'connection'
	| 'roaming'
	| 'radio'
	| 'simSlot'
	| 'recovery'
	| 'usage';

/**
 * Receipt status taxonomy:
 *   - applied     — the desired state is in effect (converged, or already was).
 *   - pending     — an op was issued; a terminal state is not yet observed.
 *   - unsupported — the hardware / stack cannot honor this desire (surfaced, not silent).
 *   - failed      — an op was attempted and errored.
 */
export type ReceiptStatus = 'applied' | 'pending' | 'unsupported' | 'failed';

/**
 * One reconcile receipt. `reason` is ALWAYS populated — a receipt with no reason
 * would be a silent outcome, which the contract forbids.
 */
export interface Receipt {
	readonly dimension: PolicyDimension;
	readonly status: ReceiptStatus;
	readonly reason: string;
}

/** Build a receipt. Kept as a helper so `reason` can never be forgotten. */
export function receipt(
	dimension: PolicyDimension,
	status: ReceiptStatus,
	reason: string,
): Receipt {
	return { dimension, status, reason };
}
