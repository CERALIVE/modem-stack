// The observation layer — normalization, provenance, freshness.
//
// It sits directly on top of the migrated pure logic (`domain/mm-enums.ts`,
// `domain/modem-presentation.ts`, `hardware/router-parsers.ts`) and turns a raw
// per-vendor payload into ONE `ObservationEnvelope<NormalizedModemObservation>` that
// carries where every value came from and why any value is missing. It opens no
// transport: a provider performs the read, this layer explains the result.
//
// Reachable through the package root, deliberately not through a new subpath — the
// public specifier set is a frozen contract and this is normalization, which the root
// entry already owns.

export * from './envelope';
export * from './freshness';
export * from './metric';
export * from './model';
export * from './provenance';
export * from './raw';
export * from './reading';
export * from './sources/hilink';
export * from './sources/modemmanager';
export * from './sources/router-shared';
export * from './sources/ufi';
export * from './sources/zte';
export * from './state-separation';
