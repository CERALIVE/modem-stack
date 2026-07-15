// @ceralive/modem-control — package entry point.
//
// Phase A: the domain model (identity + orthogonal state + revisions) lands first
// under `./domain`. The ModemManager D-Bus backend, NetworkManager adapter,
// desired-state reconciler, USB composition-mode model, and data-usage sampler
// land in later waves.

export const PACKAGE_NAME = '@ceralive/modem-control';

export * from './domain';
