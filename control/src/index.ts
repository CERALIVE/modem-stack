// @ceralive/modem-control — package entry point.
//
// Phase A: the domain model (identity + orthogonal state + revisions) under
// `./domain`, the MM / NM / Router port contracts + desired-state planner under
// `./ports`, and the redaction module (`./redact`). The ModemManager D-Bus
// backend, NetworkManager adapter, USB composition-mode model, and data-usage
// sampler land in later waves.

export const PACKAGE_NAME = '@ceralive/modem-control';

export * from './domain';
export * from './ports';
export * from './redact';
