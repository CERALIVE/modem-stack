// The band-lock capability module: the MMModemBand vocabulary and the
// certification catalog that gates whether a control may be offered at all.
//
// The D-Bus verbs themselves live with the other ModemManager mutations
// (`backend/mm-mutations.ts`), declared on `ModemManagerPort` — a band change is
// a radio mutation like a mode change, not a subsystem of its own.

export * from './band-names';
export * from './certification';
