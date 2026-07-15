// The pluggable safety interlock the recovery ladder consults before disruption.
//
// A disruptive recovery step (deactivate NM, disable MM, Reset(), power-cycle) must
// never fire while the modem is carrying a live stream. The ladder therefore asks a
// `LifecycleInterlock` BEFORE every disruptive step. Phase A (CLI) injects the
// always-allow stub below; Phase B wires CeraUI's real streaming-admission check
// into this SAME interface — the ladder code does not change, only the injected
// instance. A4.2's USB-mode transition reuses this exact interlock shape.

/** What a disruptive step is about to act on — enough for an interlock to decide. */
export interface InterlockTarget {
	readonly stableKey: string;
}

/** An interlock verdict. A denial ALWAYS carries a reason (why it is unsafe now). */
export type InterlockDecision =
	| { readonly allow: true }
	| { readonly allow: false; readonly reason: string };

/**
 * The safety interlock consulted before each disruptive recovery step. Returning
 * `{ allow: false, reason }` stops the ladder — the modem is left as-is rather than
 * disrupted mid-stream.
 */
export interface LifecycleInterlock {
	canDisrupt(target: InterlockTarget): Promise<InterlockDecision>;
}

/**
 * The Phase-A interlock: always allows. There is no streaming-admission signal in
 * the CLI, so nothing to block against. Phase B replaces this instance with a
 * real streaming-aware interlock; no ladder code changes.
 */
export const ALLOW_ALL_INTERLOCK: LifecycleInterlock = {
	canDisrupt(): Promise<InterlockDecision> {
		return Promise.resolve({ allow: true });
	},
};
