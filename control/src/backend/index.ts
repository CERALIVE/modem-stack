// Backend adapters — the concrete D-Bus implementations of the port contracts.
//
// A3.1 lands the epoch-scoped `MmDbusObserver` (the read side). Later A3 waves add
// feature detection + identity (A3.2), mutations + Signal.Setup (A3.3), and the
// recovery ladder (A3.4) here.

export { MM_BUS_NAME, MM_ROOT_PATH, MODEM_IFACE, MODEM3GPP_IFACE, SIM_IFACE } from './constants';
export { createMmDbusObserver, MmDbusObserver, type MmDbusObserverOptions } from './observer';
