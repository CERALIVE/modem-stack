// @ceralive/modem-control — package entry point.
//
// Phase A: the domain model (identity + orthogonal state + revisions) under
// `./domain`, the MM / NM / Router port contracts + desired-state planner under
// `./ports`, the redaction module (`./redact`), and the epoch-scoped ModemManager
// D-Bus observer under `./backend`. The NetworkManager adapter, USB composition-mode
// model, and data-usage sampler land in later waves.

export const PACKAGE_NAME = '@ceralive/modem-control';

export * from './backend';
export * from './band';
export * from './capability';
export * from './domain';
export * from './fcc';
export * from './hardware/router-parsers';
export * from './location';
export * from './ports';
export * from './providers';
export * from './redact';
export * from './sms';
export * from './usb-mode';
export * from './ussd';
