// The GPS/location module — the GNSS display state machine and NMEA decoding.
//
// PRIVACY FENCE (a product rule, not a phase limitation): this module reads the
// CURRENT fix and holds it in memory for a live display. There is no history, no
// track log, no persistence, and no upload — and none may be added here. The port
// contract in `../ports/location.ts` is guarded by `location-fence.test.ts`.

export * from './fix-state';
export * from './nmea';
