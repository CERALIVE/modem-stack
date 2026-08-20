// The saved-vs-applied boundary, proven against A2.3's stateful nmcli harness.
//
// The harness is a real state machine over the nmcli argv grammar, so a profile read
// back after a write is exactly what was written — which is what lets these tests tell
// "the desired slot echoed the request" apart from "the desired slot was seeded from
// the readback". No bus and no subprocess: this suite always runs.
//
// The headline scenario is re-enumeration: NM reports an interface, then stops
// reporting it. The applied bearer must be reported LOST while the desired profile
// survives byte-for-byte — an operator's configuration is not un-asked by a device
// disappearing, and a controller that lost it would have nothing to restore.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FakeNetworkManagerPort } from '../../../test-support/fake-nm';
import { fixtureContext } from '../../../test-support/observation-fixtures';
import { deviceGeneration, epochMillis, sourceEpoch } from '../../domain';
import {
	type ConnectionId,
	connectionId,
	type DeviceIfname,
	deviceIfname,
	type GsmProfileInput,
	type NetworkManagerPort,
	receipt,
} from '../../ports';
import { NetworkManagerAdapter } from './adapter';
import type { NmObservedDevice } from './types';

const WWAN0 = deviceIfname('wwan0');
const WWAN1 = deviceIfname('wwan1');

const PROFILE: GsmProfileInput = {
	connectionName: 'cell-primary',
	apn: 'internet',
	username: 'operator',
	password: 's3cr3t',
	homeOnly: true,
	autoConfig: false,
};

const APPLY = { operationId: 'op-1', generation: deviceGeneration(7) } as const;

/** A device NM reports as carrying `id` and nothing unusual. */
function activatedOn(ifname: DeviceIfname, id: ConnectionId, apn = 'internet'): NmObservedDevice {
	return {
		ifname,
		state: 'activated',
		activeConnection: { connectionId: id, apn, autoConfig: false, homeOnly: true },
	};
}

/** Save a profile and put it into force — the state every applied-side test starts from. */
async function applied(port: NetworkManagerPort = new FakeNetworkManagerPort()): Promise<{
	adapter: NetworkManagerAdapter;
	id: ConnectionId;
}> {
	const adapter = new NetworkManagerAdapter({ port });
	const saved = await adapter.saveDesiredProfile({
		profile: PROFILE,
		deviceIfname: WWAN0,
		requestedBy: 'rpc:setApn',
	});
	if (!saved.ok) {
		throw new Error(`fixture could not save a profile: ${saved.receipt.reason}`);
	}
	const result = await adapter.applyDesired(saved.connectionId, APPLY);
	if (!result.ok) {
		throw new Error(`fixture could not apply: ${result.receipt.reason}`);
	}
	return { adapter, id: saved.connectionId };
}

describe('NetworkManagerAdapter — desired profiles (the saved side)', () => {
	test('a save writes NM and records the REQUEST, not the readback', async () => {
		const port = new FakeNetworkManagerPort();
		const adapter = new NetworkManagerAdapter({ port, now: () => 1_000 });

		const saved = await adapter.saveDesiredProfile({
			profile: PROFILE,
			deviceIfname: WWAN0,
			requestedBy: 'rpc:setApn',
		});

		expect(saved.ok).toBe(true);
		if (!saved.ok) {
			return;
		}
		const desired = adapter.desiredFor(saved.connectionId);
		expect(desired?.kind).toBe('desired');
		expect(desired?.requestedBy).toBe('rpc:setApn');
		expect(desired?.requestedAt).toBe(epochMillis(1_000));
		expect(desired?.profile).toEqual({
			kind: 'bound',
			binding: {
				connectionId: saved.connectionId,
				deviceIfname: WWAN0,
				apn: 'internet',
				autoConfig: false,
				homeOnly: true,
			},
		});
	});

	test('the saved profile reads back out of NM itself', async () => {
		const port = new FakeNetworkManagerPort();
		const adapter = new NetworkManagerAdapter({ port });
		const saved = await adapter.saveDesiredProfile({
			profile: PROFILE,
			deviceIfname: WWAN0,
			requestedBy: 'rpc:setApn',
		});
		if (!saved.ok) {
			throw new Error('save failed');
		}

		const readBack = await adapter.readSavedProfile(saved.connectionId);

		expect(readBack?.apn).toBe('internet');
		expect(readBack?.connectionName).toBe('cell-primary');
		expect(readBack?.homeOnly).toBe(true);
	});

	test('a save with a connection id MODIFIES rather than creating a second profile', async () => {
		const port = new FakeNetworkManagerPort();
		const adapter = new NetworkManagerAdapter({ port });
		const first = await adapter.saveDesiredProfile({
			profile: PROFILE,
			deviceIfname: WWAN0,
			requestedBy: 'rpc:setApn',
		});
		if (!first.ok) {
			throw new Error('save failed');
		}

		const second = await adapter.saveDesiredProfile({
			connectionId: first.connectionId,
			profile: { ...PROFILE, apn: 'iot.example' },
			deviceIfname: WWAN0,
			requestedBy: 'rpc:setApn',
		});

		expect(second.ok).toBe(true);
		expect(adapter.trackedConnections()).toEqual([first.connectionId]);
		expect(port.runner.calls.filter((call) => call[1] === 'add')).toHaveLength(1);
		expect(port.runner.calls.filter((call) => call[1] === 'modify')).toHaveLength(1);
		expect((await adapter.readSavedProfile(first.connectionId))?.apn).toBe('iot.example');
	});

	test('desired records what was ASKED, even when NM stores something else', async () => {
		// NM lets `gsm.auto-config` drive the APN, so the concrete apn an operator typed
		// is NOT what NM ends up holding. Seeding desired from the readback would erase
		// the request and make the divergence below structurally unreportable.
		const port = autoApnDrivesApn(new FakeNetworkManagerPort());
		const adapter = new NetworkManagerAdapter({ port });

		const saved = await adapter.saveDesiredProfile({
			profile: { ...PROFILE, autoConfig: true },
			deviceIfname: WWAN0,
			requestedBy: 'rpc:setApn',
		});
		if (!saved.ok) {
			throw new Error('save failed');
		}
		const result = await adapter.applyDesired(saved.connectionId, APPLY);

		expect(saved.desired.profile).toEqual({
			kind: 'bound',
			binding: {
				connectionId: saved.connectionId,
				deviceIfname: WWAN0,
				apn: 'internet',
				autoConfig: true,
				homeOnly: true,
			},
		});
		expect((await adapter.readSavedProfile(saved.connectionId))?.apn).toBe('');
		expect(result.ok && result.applied.configuration).toEqual({
			kind: 'bound',
			binding: {
				connectionId: saved.connectionId,
				deviceIfname: WWAN0,
				apn: '',
				autoConfig: true,
				homeOnly: true,
			},
		});
		expect(adapter.divergence(saved.connectionId, fixtureContext())?.desiredVsApplied).toEqual({
			status: 'diverged',
		});
	});

	test('the desired slot never carries the connection password', async () => {
		const { adapter, id } = await applied();

		expect(JSON.stringify(adapter.desiredFor(id))).not.toContain('s3cr3t');
		expect(JSON.stringify(adapter.appliedFor(id))).not.toContain('s3cr3t');
		// The credential IS in NM — this adapter simply does not mirror it into a slot.
		expect((await adapter.readSavedProfile(id))?.password).toBe('s3cr3t');
	});

	test('a rejected write is a typed refusal and records NO desired state', async () => {
		const adapter = new NetworkManagerAdapter({ port: new FakeNetworkManagerPort() });
		const ghost = connectionId('no-such-uuid');

		const result = await adapter.saveDesiredProfile({
			connectionId: ghost,
			profile: PROFILE,
			deviceIfname: WWAN0,
			requestedBy: 'rpc:setApn',
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.reason).toBe('write-failed');
		expect(result.receipt.status).toBe('failed');
		expect(adapter.desiredFor(ghost)).toBeNull();
		expect(adapter.trackedConnections()).toEqual([]);
	});
});

describe('NetworkManagerAdapter — applied bearers resolve to an interface', () => {
	test('an applied bearer names the exact device it landed on', async () => {
		const { adapter, id } = await applied();

		const bearer = adapter.appliedFor(id);
		expect(bearer?.kind).toBe('applied');
		expect(bearer?.generation).toBe(APPLY.generation);
		expect(bearer?.operationId).toBe('op-1');
		expect(bearer?.configuration).toEqual({
			kind: 'bound',
			binding: {
				connectionId: id,
				deviceIfname: WWAN0,
				apn: 'internet',
				autoConfig: false,
				homeOnly: true,
			},
		});
		expect(adapter.resolveAppliedInterface(id)).toBe(WWAN0);
	});

	test('applied is built from NM\u2019s readback, so a drifted profile diverges from desired', async () => {
		const port = new FakeNetworkManagerPort();
		const adapter = new NetworkManagerAdapter({ port });
		const saved = await adapter.saveDesiredProfile({
			profile: PROFILE,
			deviceIfname: WWAN0,
			requestedBy: 'rpc:setApn',
		});
		if (!saved.ok) {
			throw new Error('save failed');
		}
		// Somebody else edits the profile in NM between the save and the activation.
		await port.updateGsmProfile(saved.connectionId, { apn: 'someone-elses.apn' });

		const result = await adapter.applyDesired(saved.connectionId, APPLY);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.applied.configuration).toEqual({
			kind: 'bound',
			binding: {
				connectionId: saved.connectionId,
				deviceIfname: WWAN0,
				apn: 'someone-elses.apn',
				autoConfig: false,
				homeOnly: true,
			},
		});
		expect(adapter.desiredFor(saved.connectionId)?.profile).toEqual({
			kind: 'bound',
			binding: {
				connectionId: saved.connectionId,
				deviceIfname: WWAN0,
				apn: 'internet',
				autoConfig: false,
				homeOnly: true,
			},
		});
		expect(adapter.divergence(saved.connectionId, fixtureContext())?.desiredVsApplied).toEqual({
			status: 'diverged',
		});
	});

	test('applying with no desired profile is refused, not attempted', async () => {
		const port = new FakeNetworkManagerPort();
		const adapter = new NetworkManagerAdapter({ port });

		const result = await adapter.applyDesired(connectionId('unknown'), APPLY);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.reason).toBe('no-desired-profile');
		expect(port.runner.calls).toEqual([]);
	});

	test('a profile deleted out from under us refuses without touching desired', async () => {
		const port = new FakeNetworkManagerPort();
		const adapter = new NetworkManagerAdapter({ port });
		const saved = await adapter.saveDesiredProfile({
			profile: PROFILE,
			deviceIfname: WWAN0,
			requestedBy: 'rpc:setApn',
		});
		if (!saved.ok) {
			throw new Error('save failed');
		}
		const before = adapter.desiredFor(saved.connectionId);
		// The adapter itself has no delete verb; only the port can do this.
		await port.deleteGsmProfile(saved.connectionId);

		const result = await adapter.applyDesired(saved.connectionId, APPLY);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.reason).toBe('profile-absent');
		expect(adapter.desiredFor(saved.connectionId)).toBe(before);
		expect(adapter.appliedFor(saved.connectionId)).toBeNull();
	});

	test('a failed activation records NO applied state', async () => {
		const port = new FakeNetworkManagerPort();
		const adapter = new NetworkManagerAdapter({ port: refusingActivation(port) });
		const saved = await adapter.saveDesiredProfile({
			profile: PROFILE,
			deviceIfname: WWAN0,
			requestedBy: 'rpc:setApn',
		});
		if (!saved.ok) {
			throw new Error('save failed');
		}

		const result = await adapter.applyDesired(saved.connectionId, APPLY);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.reason).toBe('activation-failed');
		expect(adapter.appliedFor(saved.connectionId)).toBeNull();
		expect(adapter.resolveAppliedInterface(saved.connectionId)).toBeNull();
		expect(adapter.desiredFor(saved.connectionId)).not.toBeNull();
	});

	test('a released bearer applies as UNBOUND and resolves to no interface', async () => {
		const { adapter, id } = await applied();

		const released = adapter.releaseDesired(id, 'rpc:stopBearer');
		expect(released.ok).toBe(true);
		const result = await adapter.applyDesired(id, {
			operationId: 'op-2',
			generation: APPLY.generation,
		});

		expect(result.ok).toBe(true);
		expect(adapter.appliedFor(id)?.configuration).toEqual({
			kind: 'unbound',
			deviceIfname: WWAN0,
		});
		expect(adapter.resolveAppliedInterface(id)).toBeNull();
	});
});

describe('NetworkManagerAdapter — observed state never overwrites desired', () => {
	test('a readout that contradicts the profile leaves the desired slot identical', async () => {
		const { adapter, id } = await applied();
		const before = adapter.desiredFor(id);

		const result = adapter.observe({
			context: fixtureContext(),
			devices: [activatedOn(WWAN0, id, 'carrier-pushed.apn')],
		});

		expect(result.kind).toBe('accepted');
		expect(adapter.desiredFor(id)).toBe(before);
		expect(adapter.desiredFor(id)?.profile).toEqual({
			kind: 'bound',
			binding: {
				connectionId: id,
				deviceIfname: WWAN0,
				apn: 'internet',
				autoConfig: false,
				homeOnly: true,
			},
		});
		const observed = adapter.observedFor(id);
		expect(observed?.kind).toBe('observed');
		expect(observed?.observation.value).toEqual({
			kind: 'bound',
			binding: {
				connectionId: id,
				deviceIfname: WWAN0,
				apn: 'carrier-pushed.apn',
				autoConfig: false,
				homeOnly: true,
			},
		});
		expect(adapter.divergence(id, fixtureContext())).toEqual({
			desiredVsApplied: { status: 'aligned' },
			appliedVsObserved: { status: 'diverged' },
		});
	});

	test('the three slots stay three slots, each with its own discriminant', async () => {
		const { adapter, id } = await applied();
		adapter.observe({ context: fixtureContext(), devices: [activatedOn(WWAN0, id)] });

		const view = adapter.stateView(id, fixtureContext());

		expect(view?.desired?.kind).toBe('desired');
		expect(view?.applied?.kind).toBe('applied');
		expect(view?.observed.kind).toBe('observed');
	});

	test('an unobserved connection reports unavailable rather than borrowing a slot', async () => {
		const { adapter, id } = await applied();

		const view = adapter.stateView(id, fixtureContext());

		expect(view?.observed.observation.freshness).toEqual({
			state: 'unavailable',
			since: fixtureContext().observedAt,
			reason: 'provider-unavailable',
		});
		expect(view?.observed.observation.value).toBeNull();
		expect(adapter.divergence(id, fixtureContext())?.appliedVsObserved).toEqual({
			status: 'indeterminate',
			missing: 'observed',
		});
	});
});

describe('NetworkManagerAdapter — re-enumeration loses the bearer, never the profile', () => {
	test('an interface that disappears is an applied LOSS with the desired profile intact', async () => {
		const { adapter, id } = await applied();
		const desiredBefore = adapter.desiredFor(id);
		const appliedBefore = adapter.appliedFor(id);

		const present = adapter.observe({
			context: fixtureContext(),
			devices: [activatedOn(WWAN0, id)],
		});
		expect(present.kind === 'accepted' && present.losses).toEqual([]);
		expect(present.kind === 'accepted' && present.outcomes[0]?.outcome.status).toBe('retained');

		// The modem re-enumerates: a NEW generation, and `wwan0` is simply not there.
		const gone = adapter.observe({
			context: fixtureContext({
				generation: deviceGeneration(8),
				sourceEpoch: sourceEpoch(43),
				observedAt: epochMillis(1_700_000_060_000),
			}),
			devices: [{ ifname: WWAN1, state: 'disconnected' }],
		});

		expect(gone.kind).toBe('accepted');
		if (gone.kind !== 'accepted') {
			return;
		}
		expect(gone.losses).toHaveLength(1);
		expect(gone.losses[0]).toEqual({
			connectionId: id,
			deviceIfname: WWAN0,
			reason: 'interface-absent',
			lostAt: epochMillis(1_700_000_060_000),
			generation: APPLY.generation,
			// biome-ignore lint/style/noNonNullAssertion: the fixture asserted this is set.
			previous: appliedBefore!,
		});

		// APPLIED clears, OBSERVED reflects reality, DESIRED is untouched.
		expect(adapter.appliedFor(id)).toBeNull();
		expect(adapter.resolveAppliedInterface(id)).toBeNull();
		expect(adapter.observedFor(id)?.observation.freshness).toEqual({
			state: 'unavailable',
			since: epochMillis(1_700_000_060_000),
			reason: 'device-absent',
		});
		expect(adapter.observedFor(id)?.observation.value).toBeNull();
		expect(adapter.desiredFor(id)).toBe(desiredBefore);
		expect(adapter.divergence(id, fixtureContext())?.desiredVsApplied).toEqual({
			status: 'indeterminate',
			missing: 'applied',
		});
	});

	test('the surviving desired profile is enough to re-apply once the device returns', async () => {
		const { adapter, id } = await applied();
		adapter.observe({ context: fixtureContext(), devices: [] });
		expect(adapter.appliedFor(id)).toBeNull();

		// No new save: the desired slot still holds everything the re-apply needs.
		const again = await adapter.applyDesired(id, {
			operationId: 'op-3',
			generation: deviceGeneration(8),
		});

		expect(again.ok).toBe(true);
		expect(adapter.resolveAppliedInterface(id)).toBe(WWAN0);
		expect(adapter.appliedFor(id)?.generation).toBe(deviceGeneration(8));
	});

	test('a device present but carrying nothing is a FRESH observation, not an unavailable one', async () => {
		const { adapter, id } = await applied();

		const result = adapter.observe({
			context: fixtureContext(),
			devices: [{ ifname: WWAN0, state: 'disconnected' }],
		});

		expect(result.kind === 'accepted' && result.losses[0]?.reason).toBe('interface-detached');
		expect(adapter.observedFor(id)?.observation.freshness).toEqual({ state: 'fresh' });
		expect(adapter.observedFor(id)?.observation.value).toEqual({
			kind: 'unbound',
			deviceIfname: WWAN0,
		});
		expect(adapter.appliedFor(id)).toBeNull();
		expect(adapter.desiredFor(id)).not.toBeNull();
	});

	test('another connection on our device is a replacement, not a detachment', async () => {
		const { adapter, id } = await applied();

		const result = adapter.observe({
			context: fixtureContext(),
			devices: [activatedOn(WWAN0, connectionId('someone-else'))],
		});

		expect(result.kind === 'accepted' && result.losses[0]?.reason).toBe('connection-replaced');
		expect(adapter.appliedFor(id)).toBeNull();
		expect(adapter.desiredFor(id)).not.toBeNull();
	});

	test('a device NM reports as failed loses the bearer with that reason', async () => {
		const { adapter, id } = await applied();

		const result = adapter.observe({
			context: fixtureContext(),
			devices: [{ ...activatedOn(WWAN0, id), state: 'failed' }],
		});

		expect(result.kind === 'accepted' && result.losses[0]?.reason).toBe('activation-failed');
		expect(adapter.appliedFor(id)).toBeNull();
	});

	test('a device still settling is PENDING — an activation in flight is not a loss', async () => {
		const { adapter, id } = await applied();

		const result = adapter.observe({
			context: fixtureContext(),
			devices: [{ ...activatedOn(WWAN0, id), state: 'ip-config' }],
		});

		expect(result.kind).toBe('accepted');
		if (result.kind !== 'accepted') {
			return;
		}
		expect(result.losses).toEqual([]);
		expect(result.outcomes[0]?.outcome).toEqual({
			status: 'pending',
			// biome-ignore lint/style/noNonNullAssertion: asserted non-null immediately above.
			applied: adapter.appliedFor(id)!,
			deviceState: 'ip-config',
		});
		expect(adapter.resolveAppliedInterface(id)).toBe(WWAN0);
	});

	test('a readout from a superseded generation cannot clear applied state', async () => {
		const { adapter, id } = await applied();
		adapter.observe({
			context: fixtureContext({ generation: deviceGeneration(9) }),
			devices: [activatedOn(WWAN0, id)],
		});

		const late = adapter.observe({
			context: fixtureContext({ generation: deviceGeneration(8) }),
			devices: [],
		});

		expect(late).toEqual({
			kind: 'refused',
			reason: 'superseded-generation',
			currentGeneration: deviceGeneration(9),
		});
		expect(adapter.resolveAppliedInterface(id)).toBe(WWAN0);
	});

	test('a saved-but-never-applied connection reports unapplied, not lost', async () => {
		const port = new FakeNetworkManagerPort();
		const adapter = new NetworkManagerAdapter({ port });
		const saved = await adapter.saveDesiredProfile({
			profile: PROFILE,
			deviceIfname: WWAN0,
			requestedBy: 'rpc:setApn',
		});
		if (!saved.ok) {
			throw new Error('save failed');
		}

		const result = adapter.observe({ context: fixtureContext(), devices: [] });

		expect(result.kind === 'accepted' && result.losses).toEqual([]);
		expect(result.kind === 'accepted' && result.outcomes).toEqual([
			{ connectionId: saved.connectionId, outcome: { status: 'unapplied' } },
		]);
	});
});

describe('NetworkManagerAdapter — scope boundary', () => {
	// The adapter owns bearers and ONLY bearers. Radio/SIM verbs belong to the
	// ModemManager provider, profile deletion is outside the port-tagged `NmOp` set,
	// and physical modem identity belongs to the domain layer — so none of those
	// identifiers may appear in this module's executable source.
	const FORBIDDEN = [
		'setRadioModes',
		'setPrimarySimSlot',
		'sendPin',
		'sendPuk',
		'scanNetworks',
		'setCurrentBands',
		'deleteGsmProfile',
		'PhysicalModemId',
		'physicalModemId',
	];

	const sources = ['adapter.ts', 'types.ts', 'index.ts'].map((name) => ({
		name,
		code: stripComments(readFileSync(new URL(name, import.meta.url), 'utf8')),
	}));

	test('the comment strip is non-vacuous in both directions', () => {
		expect(
			stripComments('const a = 1; // setRadioModes\n/* sendPin */\nconst b = 2;'),
		).not.toContain('setRadioModes');
		expect(stripComments('const a = 1; // setRadioModes')).toContain('const a = 1;');
		expect(sources.every((source) => source.code.includes('export'))).toBe(true);
	});

	for (const forbidden of FORBIDDEN) {
		test(`no executable source names ${forbidden}`, () => {
			for (const source of sources) {
				expect(`${source.name}:${source.code.includes(forbidden)}`).toBe(`${source.name}:false`);
			}
		});
	}
});

function delegating(port: FakeNetworkManagerPort): NetworkManagerPort {
	return {
		createGsmProfile: (profile) => port.createGsmProfile(profile),
		readGsmProfile: (id) => port.readGsmProfile(id),
		updateGsmProfile: (id, patch) => port.updateGsmProfile(id, patch),
		deleteGsmProfile: (id) => port.deleteGsmProfile(id),
		activate: (id, ifname) => port.activate(id, ifname),
		deactivate: (id, ifname) => port.deactivate(id, ifname),
		acquireQuiesceLease: (id, ifname) => port.acquireQuiesceLease(id, ifname),
		releaseQuiesceLease: (lease) => port.releaseQuiesceLease(lease),
	};
}

function refusingActivation(port: FakeNetworkManagerPort): NetworkManagerPort {
	return {
		...delegating(port),
		activate: async () => receipt('enabled', 'failed', 'No suitable device found for connection'),
	};
}

function autoApnDrivesApn(port: FakeNetworkManagerPort): NetworkManagerPort {
	return {
		...delegating(port),
		createGsmProfile: (profile) =>
			port.createGsmProfile(profile.autoConfig ? { ...profile, apn: '' } : profile),
		updateGsmProfile: (id, patch) =>
			port.updateGsmProfile(id, patch.autoConfig === true ? { ...patch, apn: '' } : patch),
	};
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}
