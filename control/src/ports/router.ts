// The router port — for devices MM cannot control (HiLink, router-ethernet class).
//
// This port is DELIBERATELY tiny: presence and advisory health ONLY. Health never
// drives activation or recovery — a degraded router stays in the routing set (it is
// never evicted on health alone). A router device is an Ethernet uplink we OBSERVE,
// not a modem we configure; there is no bearer / APN / radio verb here.

import type { EpochMillis } from '../domain';
import type { DeviceIfname } from './network-manager';

/** Whether a router-class device is present on an interface. */
export type RouterPresence = 'present' | 'absent';

/**
 * Advisory health of a router-class uplink. Every field is informational — a
 * degraded router is reported, never removed from the routing set on health alone.
 */
export interface RouterHealth {
	readonly presence: RouterPresence;
	readonly gatewayReachable: boolean;
	readonly egressHealthy: boolean;
	readonly observedAt: EpochMillis;
}

/** The router port — presence and advisory health only. No mutation verbs. */
export interface RouterPort {
	probePresence(ifname: DeviceIfname): Promise<RouterPresence>;
	checkHealth(ifname: DeviceIfname): Promise<RouterHealth>;
}
