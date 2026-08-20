// Capability-module feature-gate framework — the support-claim taxonomy, the
// per-modem capability detection the seven gated modules resolve against, and the
// modules that have landed their own probe + evidence.
//
// Implemented so far: `five-g-pref` (`five-g-preference.ts`). The remaining six
// are framework-only and may not be surfaced or claimed until their own change
// lands.

export * from './detect';
export * from './five-g-preference';
export * from './support-claim';
