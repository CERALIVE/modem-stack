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
	/** Override the public DNS target used by the egress probe. */
	readonly probeHost?: string;
	/** Bound applied to every default subprocess, including `ip`. */
	readonly subprocessTimeoutMs?: number;
}

export const ROUTER_PROBE_FAILURES = [
	'command-missing',
	'timeout',
	'nonzero-exit',
	'unreachable',
] as const;
export type RouterProbeFailureKind = (typeof ROUTER_PROBE_FAILURES)[number];

export function classifyRouterProbeFailure(error: unknown): RouterProbeFailureKind {
	if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
	if (error instanceof Error && error.name === 'UnreachableError') return 'unreachable';
	if (
		error instanceof Error &&
		'code' in error &&
		typeof error.code === 'string' &&
		error.code === 'ENOENT'
	) {
		return 'command-missing';
	}
	return 'nonzero-exit';
}

/** The host used for the basic egress-health probe (public DNS anycast). */
const EGRESS_PROBE_HOST = '1.1.1.1';
const DEFAULT_SUBPROCESS_TIMEOUT_MS = 5_000;

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	return Promise.race([
		operation,
		new Promise<T>((_, reject) =>
			setTimeout(
				() => reject(Object.assign(new Error('probe timed out'), { name: 'TimeoutError' })),
				timeoutMs,
			),
		),
	]);
}

async function spawnSucceeds(command: readonly string[], timeoutMs: number): Promise<boolean> {
	try {
		const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
		return (
			(await Promise.race([
				proc.exited,
				new Promise<number>((resolve) => setTimeout(() => resolve(124), timeoutMs)),
			])) === 0
		);
	} catch {
		return false;
	}
}

async function spawnOutput(command: readonly string[], timeoutMs: number): Promise<string> {
	try {
		const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
		const [out, code] = await Promise.race([
			Promise.all([new Response(proc.stdout).text(), proc.exited]),
			new Promise<readonly [string, number]>((resolve) =>
				setTimeout(() => resolve(['', 124]), timeoutMs),
			),
		]);
		return code === 0 ? out : '';
	} catch {
		return '';
	}
}

function defaultCheckLinkUp(ifname: DeviceIfname, timeoutMs: number): Promise<boolean> {
	return spawnSucceeds(['ip', 'link', 'show', 'up', 'dev', String(ifname)], timeoutMs);
}

async function defaultResolveGateway(
	ifname: DeviceIfname,
	timeoutMs: number,
): Promise<string | undefined> {
	// `ip -o route show default dev <ifname>` → "default via 192.168.8.1 dev <ifname> …".
	const out = await spawnOutput(
		['ip', '-o', 'route', 'show', 'default', 'dev', String(ifname)],
		timeoutMs,
	);
	const match = out.match(/default via (\S+)/);
	return match?.[1];
}

function defaultPing(host: string, ifname: DeviceIfname, timeoutMs: number): Promise<boolean> {
	return spawnSucceeds(['ping', '-c', '1', '-W', '2', '-I', String(ifname), host], timeoutMs);
}

/**
 * Create a router-ethernet probe implementing the advisory `RouterPort`. Presence is
 * link-up; health additionally reports DHCP-gateway reachability and a basic egress
 * probe — all informational, never a gate. `checkHealth` swallows every error into a
 * `false` field so it can never throw.
 */
export function createRouterEthernetProbe(deps: RouterEthernetProbeDeps = {}): RouterPort {
	const now = deps.now ?? ((): EpochMillis => epochMillis(Date.now()));
	const timeoutMs = deps.subprocessTimeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;
	const checkLinkUp =
		deps.checkLinkUp ?? ((ifname: DeviceIfname) => defaultCheckLinkUp(ifname, timeoutMs));
	const resolveGateway =
		deps.resolveGateway ?? ((ifname: DeviceIfname) => defaultResolveGateway(ifname, timeoutMs));
	const ping =
		deps.ping ?? ((host: string, ifname: DeviceIfname) => defaultPing(host, ifname, timeoutMs));
	const probeHost = deps.probeHost ?? EGRESS_PROBE_HOST;

	async function probePresence(ifname: DeviceIfname): Promise<RouterPresence> {
		return (await bounded(checkLinkUp(ifname), timeoutMs).catch(() => false))
			? 'present'
			: 'absent';
	}

	async function checkHealth(ifname: DeviceIfname): Promise<RouterHealth> {
		const presence = await probePresence(ifname);
		const failureKinds: RouterProbeFailureKind[] = [];
		const gateway =
			presence === 'present'
				? await bounded(resolveGateway(ifname), timeoutMs).catch((error: unknown) => {
						failureKinds.push(classifyRouterProbeFailure(error));
						return undefined;
					})
				: undefined;
		const gatewayReachable =
			gateway !== undefined &&
			(await bounded(ping(gateway, ifname), timeoutMs).catch((error: unknown) => {
				failureKinds.push(classifyRouterProbeFailure(error));
				return false;
			}));
		const egressHealthy =
			gatewayReachable &&
			(await bounded(ping(probeHost, ifname), timeoutMs).catch((error: unknown) => {
				failureKinds.push(classifyRouterProbeFailure(error));
				return false;
			}));
		const health = { presence, gatewayReachable, egressHealthy, observedAt: now() };
		Object.defineProperty(health, 'failureKinds', { value: failureKinds, enumerable: true });
		return health;
	}

	return { probePresence, checkHealth };
}
