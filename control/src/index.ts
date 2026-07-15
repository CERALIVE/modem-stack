// @ceralive/modem-control — package entry point.
//
// Phase A: the domain model (identity + orthogonal state + revisions) under
// `./domain`, the MM / NM / Router port contracts + desired-state planner under
// `./ports`, the redaction module (`./redact`), and the epoch-scoped ModemManager
// D-Bus observer under `./backend`. The NetworkManager adapter, USB composition-mode
// model, and data-usage sampler land in later waves.

export const PACKAGE_NAME = '@ceralive/modem-control';

export * from './backend';
export * from './domain';
export * from './ports';
export * from './redact';
