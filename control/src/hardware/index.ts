// `@ceralive/modem-control/hardware` — the per-SKU hardware model.
//
// This subpath is the narrow entry for everything keyed on the PHYSICAL unit rather
// than on a live D-Bus object: which USB composition a SKU may be switched into and
// which transitions were certified for it (`../usb-mode`), and the MMModemBand
// vocabulary plus the per-SKU band-lock certification catalog (`../band`).
//
// Both halves are evidence-gated catalogs plus their pure lookups — no transport, no
// mutation verb. The D-Bus verbs that ACT on these facts stay where they live
// (`../backend/mm-mutations.ts`, declared on `ModemManagerPort`); a consumer that only
// needs to know what a SKU is capable of should not have to import a bus client to
// find out. That asymmetry is the reason this entry exists.

export * from '../band';
export * from '../usb-mode';
