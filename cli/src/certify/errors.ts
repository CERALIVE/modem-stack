// The one error type the certify capture throws.
//
// Every malformed / incomplete / failed capture surfaces as a `CertifyError` with a
// clear, human-readable message naming what went wrong (which command, which field).
// The command layer turns it into a non-zero exit and a printed diagnostic — a broken
// bundle is NEVER written silently.

/** A visible capture failure — malformed input, a failed tool, an uncertified SKU. */
export class CertifyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CertifyError';
		Object.setPrototypeOf(this, CertifyError.prototype);
	}
}
