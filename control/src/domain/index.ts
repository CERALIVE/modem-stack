// Domain layer — pure types + reducers for modem identity and orthogonal state.
//
// No I/O, no D-Bus, no NetworkManager: this module is data and pure functions
// only. Later waves (A2.2 ports, A3.x D-Bus backend) build on these exact shapes.

export * from './brand';
export * from './errors';
export * from './guards';
export * from './identity';
export * from './policy';
export * from './snapshot';
export * from './state';
