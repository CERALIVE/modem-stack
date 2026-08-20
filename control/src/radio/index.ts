// Radio capability TRUTH: the modem's own mode catalog and band-write gate, verbatim.
//
// It sits beside `src/band/` (the band vocabulary and per-SKU certification catalog)
// rather than inside it, because a mode combination is not a band and the two have
// different safety models — a mode change is disruptive-but-reversible, a band lock
// can strand a radio where nothing registers. Reachable through the package ROOT
// entry, deliberately NOT a new package subpath (the todo 17/18/23 precedent).

export * from './band-truth';
export * from './mode-combinations';
export * from './mode-truth';
