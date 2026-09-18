// The router-ethernet probe is ADVISORY: presence, gateway reachability, and egress
// health are reported, never gated. `checkHealth` must never throw — a throwing probe
// degrades to `false`, it does not blow up the caller.

import { describe, expect, test } from 'bun:test';
import { deviceIfname } from '../ports';
import {
	classifyRouterProbeFailure,
	createRouterEthernetProbe,
	type RouterEthernetProbeDeps,
} from './router-ethernet';

const IFNAME = deviceIfname('eth1');

function probeWith(overrides: RouterEthernetProbeDeps) {
	return createRouterEthernetProbe(overrides);
}

describe('createRouterEthernetProbe — presence', () => {
	test('a link that is up is present; a link that is down is absent', async () => {
		const up = probeWith({ checkLinkUp: () => Promise.resolve(true) });
		const down = probeWith({ checkLinkUp: () => Promise.resolve(false) });
		expect(await up.probePresence(IFNAME)).toBe('present');
		expect(await down.probePresence(IFNAME)).toBe('absent');
	});
});

describe('createRouterEthernetProbe — advisory health', () => {
	test('present + gateway + egress all healthy', async () => {
		const probe = probeWith({
			checkLinkUp: () => Promise.resolve(true),
			resolveGateway: () => Promise.resolve('192.168.8.1'),
			ping: () => Promise.resolve(true),
		});
		const health = await probe.checkHealth(IFNAME);
		expect(health.presence).toBe('present');
		expect(health.gatewayReachable).toBe(true);
		expect(health.egressHealthy).toBe(true);
	});

	test('present but no gateway → degraded health, but still returned (not thrown)', async () => {
		const probe = probeWith({
			checkLinkUp: () => Promise.resolve(true),
			resolveGateway: () => Promise.resolve(undefined),
			ping: () => Promise.resolve(true),
		});
		const health = await probe.checkHealth(IFNAME);
		expect(health.presence).toBe('present');
		expect(health.gatewayReachable).toBe(false);
		expect(health.egressHealthy).toBe(false);
	});

	test('gateway reachable but egress down → egressHealthy false only', async () => {
		const probe = probeWith({
			checkLinkUp: () => Promise.resolve(true),
			resolveGateway: () => Promise.resolve('192.168.8.1'),
			ping: (host) => Promise.resolve(host === '192.168.8.1'),
		});
		const health = await probe.checkHealth(IFNAME);
		expect(health.gatewayReachable).toBe(true);
		expect(health.egressHealthy).toBe(false);
	});

	test('checkHealth NEVER throws, even when a probe throws', async () => {
		const probe = probeWith({
			checkLinkUp: () => Promise.reject(new Error('ip crashed')),
			resolveGateway: () => Promise.reject(new Error('route crashed')),
			ping: () => Promise.reject(new Error('ping crashed')),
		});
		const health = await probe.checkHealth(IFNAME);
		expect(health.presence).toBe('absent');
		expect(health.gatewayReachable).toBe(false);
		expect(health.egressHealthy).toBe(false);
	});

	test('uses the injected egress host', async () => {
		const hosts: string[] = [];
		const probe = probeWith({
			probeHost: '198.51.100.7',
			checkLinkUp: () => Promise.resolve(true),
			resolveGateway: () => Promise.resolve('192.168.8.1'),
			ping: (host) => {
				hosts.push(host);
				return Promise.resolve(true);
			},
		});
		await probe.checkHealth(IFNAME);
		expect(hosts).toEqual(['192.168.8.1', '198.51.100.7']);
	});

	test('classifies command missing, timeout, nonzero exit, and unreachable failures', () => {
		expect(
			classifyRouterProbeFailure(Object.assign(new Error('missing'), { code: 'ENOENT' })),
		).toBe('command-missing');
		expect(
			classifyRouterProbeFailure(Object.assign(new Error('hung'), { name: 'TimeoutError' })),
		).toBe('timeout');
		expect(classifyRouterProbeFailure(new Error('exit 1'))).toBe('nonzero-exit');
		expect(
			classifyRouterProbeFailure(
				Object.assign(new Error('unreachable'), { name: 'UnreachableError' }),
			),
		).toBe('unreachable');
	});

	test('a fake hung subprocess is bounded by the configured timeout', async () => {
		const started = performance.now();
		const probe = probeWith({
			subprocessTimeoutMs: 5,
			checkLinkUp: () => new Promise<boolean>(() => undefined),
		});
		const health = await probe.checkHealth(IFNAME);
		expect(health.presence).toBe('absent');
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
