// Port contracts — the MM / NM / Router adapter boundaries plus the desired-state
// planner and receipts. Concrete backends (A2.3 fake, A3.x D-Bus, A4.1 nmcli)
// implement these interfaces; nothing here performs I/O.
//
// OWNERSHIP MATRIX (see ./README.md): NM owns bearers / APN / auth / roaming /
// autoconnect / activation; MM owns radio / SIM ops; the local controller owns
// recovery + usage policy. The ModemManagerPort has NO bearer / connect verb —
// enforced at build time by forbidden-surface.test.ts.

export * from './modem-manager';
export * from './network-manager';
export * from './observation';
export * from './ops';
export * from './receipts';
export * from './reconcile';
export * from './router';
