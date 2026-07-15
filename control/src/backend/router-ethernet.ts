// Generic router-ethernet detection — presence, DHCP-gateway reachability, and a
// basic egress-health probe for uplinks ModemManager cannot control (HiLink, RNDIS
// tether, full router firmware).
//
// EVERYTHING here is ADVISORY (ports/router.ts, matrix §1-R): health degradation is
// informational only. `checkHealth` NEVER throws and NEVER gates anything — a
// degraded router stays in the routing set; the controller merely reports what it
// observed. Each probe is an injectable seam (default `Bun.spawn` of `ip` / `ping`)
// so tests run with no real network.

import { type EpochMillis, epochMillis } from '../domain';
import type { DeviceIfname, RouterHealth, RouterPort, RouterPresence } from '../ports';

/** Injectable probes — each defaults to a `Bun.spawn` shell-out; all advisory. */
export interface RouterEthernetProbeDeps {
	readonly now?: () => EpochMillis;
	/** Whether `ifname` exists and is administratively up. */
	readonly checkLinkUp?: (ifname: DeviceIfname) => Promise<boolean>;
	/** The DHCP-assigned default gateway on `ifname`, if any. */
	readonly resolveGateway?: (ifname: DeviceIfname) => Promise<string | undefined>;
	/** Whether `host` is reachable via `ifname` (ICMP). */
	readonly ping?: (host: string, ifname: DeviceIfname) => Promise<boolean>;
}

/** The host used for the basic egress-health probe (public DNS anycast). */
const EGRESS_PROBE_HOST = '1.1.1.1';

async function spawnSucceeds(command: readonly string[]): Promise<boolean> {
	try {
		const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

async function spawnOutput(command: readonly string[]): Promise<string> {
	try {
		const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? out : '';
	} catch {
		return '';
	}
}

function defaultCheckLinkUp(ifname: DeviceIfname): Promise<boolean> {
	return spawnSucceeds(['ip', 'link', 'show', 'up', 'dev', String(ifname)]);
}

async function defaultResolveGateway(ifname: DeviceIfname): Promise<string | undefined> {
	// `ip -o route show default dev <ifname>` → "default via 192.168.8.1 dev <ifname> …".
	const out = await spawnOutput(['ip', '-o', 'route', 'show', 'default', 'dev', String(ifname)]);
	const match = out.match(/default via (\S+)/);
	return match?.[1];
}

function defaultPing(host: string, ifname: DeviceIfname): Promise<boolean> {
	return spawnSucceeds(['ping', '-c', '1', '-W', '2', '-I', String(ifname), host]);
}

/**
 * Create a router-ethernet probe implementing the advisory `RouterPort`. Presence is
 * link-up; health additionally reports DHCP-gateway reachability and a basic egress
 * probe — all informational, never a gate. `checkHealth` swallows every error into a
 * `false` field so it can never throw.
 */
export function createRouterEthernetProbe(deps: RouterEthernetProbeDeps = {}): RouterPort {
	const now = deps.now ?? ((): EpochMillis => epochMillis(Date.now()));
	const checkLinkUp = deps.checkLinkUp ?? defaultCheckLinkUp;
	const resolveGateway = deps.resolveGateway ?? defaultResolveGateway;
	const ping = deps.ping ?? defaultPing;

	async function probePresence(ifname: DeviceIfname): Promise<RouterPresence> {
		return (await checkLinkUp(ifname).catch(() => false)) ? 'present' : 'absent';
	}

	async function checkHealth(ifname: DeviceIfname): Promise<RouterHealth> {
		const presence = await probePresence(ifname);
		const gateway =
			presence === 'present' ? await resolveGateway(ifname).catch(() => undefined) : undefined;
		const gatewayReachable =
			gateway !== undefined && (await ping(gateway, ifname).catch(() => false));
		const egressHealthy =
			gatewayReachable && (await ping(EGRESS_PROBE_HOST, ifname).catch(() => false));
		return { presence, gatewayReachable, egressHealthy, observedAt: now() };
	}

	return { probePresence, checkHealth };
}
