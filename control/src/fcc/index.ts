// FCC auto-unlock — the opt-in POLICY surface, and the catalog that gates it.
//
// This module implements NO unlock procedure and ships NO unlock script. All it does
// is record which `<vid>:<pid>` models an operator has opted in for, so that
// `ceralive-fcc-reconcile` can re-derive ModemManager's own admin-tier symlinks from
// that record on every boot. The unlocking itself is ModemManager's dispatcher's job,
// start to finish.
//
// Full model, coverage matrix and certification status: `docs/FCC-UNLOCK-COVERAGE.md`.

export * from './coverage';
export * from './policy-store';
export * from './policy-write';
