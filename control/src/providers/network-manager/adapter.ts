// The thin NetworkManager adapter: desired profiles, applied bearers, and the
// interface each one landed on — the saved-vs-applied boundary and nothing else.
//
// It is the ONLY bearer/APN authority surface in the package. `ModemManagerPort` has
// no connect verb by construction (`ports/forbidden-surface.test.ts`), and the
// ModemManager provider has no bearer operation, so nothing else can put a bearer into
// force. Correspondingly, this adapter performs no radio, band, SIM or power operation:
// those belong to the ModemManager provider, and expressing them here would create a
// second writer for a resource the ownership matrix gives to exactly one.
//
// Two rules shape every method below.
//
// 1. OBSERVED STATE NEVER WRITES THE DESIRED SLOT. `observe()` may clear the applied
//    slot and always rewrites the observed one; it does not touch `desired` on any
//    path. Reality overtaking a write does not un-ask the question the operator asked
//    — and if it did, a re-enumeration would silently erase the configuration the
//    controller is supposed to restore.
// 2. WRITES GO THROUGH THE PORT'S TYPED OPERATIONS, AND ONLY THOSE. The NM half of the
//    port-tagged op set (`ports/ops.ts` `NmOp`) is create / update / activate /
//    deactivate. There is deliberately no delete path here: profile removal is not in
//    that set, so this adapter cannot express it.

import type { DeviceGeneration } from '../../domain';
import { epochMillis } from '../../domain';
import type {
	AppliedConfiguration,
	DesiredProfile,
	ModemStateView,
	NormalizationContext,
	ObservedState,
	StateDivergence,
} from '../../observations';
import { appliedConfiguration, desiredProfile } from '../../observations';
import type {
	ConnectionId,
	DeviceIfname,
	GsmProfile,
	NetworkManagerPort,
	Receipt,
} from '../../ports';
import { receipt } from '../../ports';
import { projectDivergence } from './divergence';
import { foldObservation } from './observe-fold';
import { projectStateView } from './projection';
import type { ConnectionSlots } from './state';
import { slotsFor, targetIfname } from './state';
import type {
	NmAdapterRefusalReason,
	NmApplyResult,
	NmBearerState,
	NmDesiredRequest,
	NmObservationInput,
	NmObservationResult,
	NmSaveResult,
} from './types';
import { boundBearer, unboundBearer } from './types';

export interface NetworkManagerAdapterOptions {
	readonly port: NetworkManagerPort;
	/** Clock for the desired/applied slots only; observations carry their own. */
	readonly now?: () => number;
}

export interface NmApplyOptions {
	readonly operationId: string;
	readonly generation: DeviceGeneration;
}

export class NetworkManagerAdapter {
	readonly #port: NetworkManagerPort;
	readonly #now: () => number;
	readonly #slots = new Map<ConnectionId, ConnectionSlots>();
	#observedGeneration: DeviceGeneration | null = null;

	constructor(options: NetworkManagerAdapterOptions) {
		this.#port = options.port;
		this.#now = options.now ?? Date.now;
	}

	/** Every connection this adapter holds a slot for, in insertion order. */
	trackedConnections(): readonly ConnectionId[] {
		return [...this.#slots.keys()];
	}

	// ── desired ────────────────────────────────────────────────────────────────

	/**
	 * Save an operator's profile and record it as DESIRED.
	 *
	 * The desired slot is built from what the caller ASKED for, not from what NM read
	 * back. That is the whole point of the slot: if NM normalized a field on the way
	 * in, the next `describeStateDivergence` is supposed to report it, and seeding
	 * desired from the readback would make that divergence structurally invisible.
	 */
	async saveDesiredProfile(request: NmDesiredRequest): Promise<NmSaveResult> {
		let saved: GsmProfile;
		try {
			saved =
				request.connectionId === undefined
					? await this.#port.createGsmProfile(request.profile)
					: await this.#port.updateGsmProfile(request.connectionId, request.profile);
		} catch (error: unknown) {
			return {
				ok: false,
				reason: 'write-failed',
				receipt: receipt('connection', 'failed', describeError(error)),
			};
		}
		const id = saved.connectionId;
		const desired = desiredProfile(
			boundBearer({
				connectionId: id,
				deviceIfname: request.deviceIfname,
				apn: request.profile.apn,
				autoConfig: request.profile.autoConfig,
				homeOnly: request.profile.homeOnly,
			}),
			epochMillis(this.#now()),
			request.requestedBy,
		);
		slotsFor(this.#slots, id).desired = desired;
		return { ok: true, connectionId: id, desired };
	}

	/**
	 * Record that the operator wants NO bearer on this connection's device.
	 *
	 * It performs no I/O on purpose — desired is a record of intent, and the
	 * deactivation it implies happens when `applyDesired` is called, so a request and
	 * its execution stay two separately observable facts.
	 */
	releaseDesired(id: ConnectionId, requestedBy: string): NmSaveResult {
		const slots = this.#slots.get(id);
		const ifname = slots === undefined ? undefined : targetIfname(slots);
		if (ifname === undefined) {
			return {
				ok: false,
				reason: 'no-desired-profile',
				receipt: receipt('connection', 'failed', `no tracked device for connection ${id}`),
			};
		}
		const desired = desiredProfile(unboundBearer(ifname), epochMillis(this.#now()), requestedBy);
		slotsFor(this.#slots, id).desired = desired;
		return { ok: true, connectionId: id, desired };
	}

	desiredFor(id: ConnectionId): DesiredProfile<NmBearerState> | null {
		return this.#slots.get(id)?.desired ?? null;
	}

	/** The saved profile as NM itself holds it — a straight read, no slot involved. */
	async readSavedProfile(id: ConnectionId): Promise<GsmProfile | undefined> {
		return await this.#port.readGsmProfile(id);
	}

	// ── applied ────────────────────────────────────────────────────────────────

	/**
	 * Put the desired state into force and record what was applied.
	 *
	 * The applied slot is built from the profile NM READ BACK, not from the request:
	 * "what was actually put into force" is a claim about NM's content, and asserting
	 * it from the input would make a silently-rejected field look applied.
	 */
	async applyDesired(id: ConnectionId, options: NmApplyOptions): Promise<NmApplyResult> {
		const desired = this.desiredFor(id);
		if (desired === null) {
			return refuse('no-desired-profile', `connection ${id} has no desired profile`);
		}
		return desired.profile.kind === 'unbound'
			? await this.#deactivate(id, desired.profile.deviceIfname, options)
			: await this.#activate(id, desired.profile, options);
	}

	appliedFor(id: ConnectionId): AppliedConfiguration<NmBearerState> | null {
		return this.#slots.get(id)?.applied ?? null;
	}

	/**
	 * The interface the applied bearer landed on, or `null` when no bearer is in
	 * force. An applied `unbound` state resolves to `null` rather than to its device:
	 * there is a device, but no bearer on it, and returning the name would read as one.
	 */
	resolveAppliedInterface(id: ConnectionId): DeviceIfname | null {
		const applied = this.appliedFor(id);
		if (applied === null || applied.configuration.kind !== 'bound') {
			return null;
		}
		return applied.configuration.binding.deviceIfname;
	}

	// ── observed ───────────────────────────────────────────────────────────────

	/**
	 * Fold one complete NM readout.
	 *
	 * Never touches the desired slot. Clears the applied slot only when the readout
	 * positively contradicts it, and always says which of the four contradictions it
	 * was.
	 */
	observe(input: NmObservationInput): NmObservationResult {
		const folded = foldObservation(this.#slots, this.#observedGeneration, input);
		this.#observedGeneration = folded.generation;
		return folded.result;
	}

	observedFor(id: ConnectionId): ObservedState<NmBearerState> | null {
		return this.#slots.get(id)?.observed ?? null;
	}

	/**
	 * The three-slot view. `context` supplies the provenance for the "we have not
	 * observed this yet" case — this layer has no clock or epoch counter of its own
	 * for observations, so it cannot manufacture one.
	 */
	stateView(
		id: ConnectionId,
		context: NormalizationContext,
	): ModemStateView<NmBearerState, NmBearerState, NmBearerState> | null {
		return projectStateView(this.#slots, id, context);
	}

	/** `desiredVsApplied` ("did our write happen") and `appliedVsObserved` ("did it stick"). */
	divergence(id: ConnectionId, context: NormalizationContext): StateDivergence | null {
		return projectDivergence(this.#slots, id, context);
	}

	// ── internals ──────────────────────────────────────────────────────────────

	async #activate(
		id: ConnectionId,
		desired: NmBearerState,
		options: NmApplyOptions,
	): Promise<NmApplyResult> {
		if (desired.kind !== 'bound') {
			return refuse('no-desired-profile', `connection ${id} has no bearer to activate`);
		}
		const ifname = desired.binding.deviceIfname;
		const saved = await this.#port.readGsmProfile(id);
		if (saved === undefined) {
			return refuse('profile-absent', `connection ${id} is no longer saved in NetworkManager`);
		}
		let activation: Receipt;
		try {
			activation = await this.#port.activate(id, ifname);
		} catch (error: unknown) {
			return refuse('activation-failed', describeError(error));
		}
		if (activation.status !== 'applied') {
			return { ok: false, reason: 'activation-failed', receipt: activation };
		}
		const applied = appliedConfiguration<NmBearerState>({
			configuration: boundBearer({
				connectionId: id,
				deviceIfname: ifname,
				apn: saved.apn,
				autoConfig: saved.autoConfig,
				homeOnly: saved.homeOnly,
			}),
			appliedAt: epochMillis(this.#now()),
			generation: options.generation,
			operationId: options.operationId,
		});
		slotsFor(this.#slots, id).applied = applied;
		return { ok: true, applied, receipt: activation };
	}

	async #deactivate(
		id: ConnectionId,
		ifname: DeviceIfname,
		options: NmApplyOptions,
	): Promise<NmApplyResult> {
		let result: Receipt;
		try {
			result = await this.#port.deactivate(id, ifname);
		} catch (error: unknown) {
			return refuse('deactivation-failed', describeError(error));
		}
		if (result.status !== 'applied') {
			return { ok: false, reason: 'deactivation-failed', receipt: result };
		}
		const applied = appliedConfiguration<NmBearerState>({
			configuration: unboundBearer(ifname),
			appliedAt: epochMillis(this.#now()),
			generation: options.generation,
			operationId: options.operationId,
		});
		slotsFor(this.#slots, id).applied = applied;
		return { ok: true, applied, receipt: result };
	}
}

function refuse(reason: NmAdapterRefusalReason, message: string): NmApplyResult {
	return { ok: false, reason, receipt: receipt('connection', 'failed', message) };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : 'NetworkManager rejected the request';
}
