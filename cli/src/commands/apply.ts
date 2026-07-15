// `modem-control apply --policy <file>` — reconcile a desired-state policy.
//
// Reads the policy spec, selects the target modem, DERIVES its durable binding key from
// the live identity (refusing a low-confidence / ambiguous modem — a policy can never
// bind to one), runs the pure reconcile planner (A2.2) against the observed state, then
// applies the resulting port-tagged ops through the MM / NM ports and prints one honest
// receipt per policy dimension.

import {
	type AppliedCellularState,
	type CellularSnapshot,
	canBindPolicy,
	deviceIfname,
	type ModemCapabilities,
	type PortTaggedOp,
	planReconcile,
	policyBindingKey,
	type RadioAccessTechnology,
} from '@ceralive/modem-control';
import type { StackContext } from '../context';
import type { CliIo } from '../io';
import { type PolicyFileSpec, toDesiredPolicy } from '../policy-file';
import { selectModem } from '../select';

const ALL_RATS: readonly RadioAccessTechnology[] = ['gsm', 'umts', 'lte', '5gnr'];

/** Derive the planner's "is" state from an observed snapshot (bench-conservative). */
function currentState(snapshot: CellularSnapshot): AppliedCellularState {
	const name = snapshot.dataInterface.present ? snapshot.dataInterface.name : undefined;
	const activeSlot = snapshot.simSlots.find((slot) => slot.active)?.index;
	return {
		nmActivation: snapshot.nmActivation,
		hasProfile: false,
		...(name !== undefined ? { deviceIfname: deviceIfname(name) } : {}),
		...(activeSlot !== undefined ? { activePrimarySlot: activeSlot } : {}),
	};
}

/** Bench capability set — the full RAT set, observed slot count, Auto-APN assumed. */
function capabilities(snapshot: CellularSnapshot): ModemCapabilities {
	return {
		supportedRats: new Set(ALL_RATS),
		simSlotCount: Math.max(1, snapshot.simSlots.length),
		supportsAutoApn: true,
	};
}

/** Apply one port-tagged op, printing its outcome. */
async function applyOp(
	ctx: StackContext,
	modem: CellularSnapshot,
	op: PortTaggedOp,
	io: CliIo,
): Promise<void> {
	const ref = modem.identity.runtimePath;
	if (op.port === 'nm') {
		switch (op.op.kind) {
			case 'createGsmProfile': {
				const profile = await ctx.nm.createGsmProfile(op.op.profile);
				io.out(`  applied nm.createGsmProfile -> ${profile.connectionId}`);
				return;
			}
			case 'updateGsmProfile':
				await ctx.nm.updateGsmProfile(op.op.connectionId, op.op.patch);
				io.out(`  applied nm.updateGsmProfile ${op.op.connectionId}`);
				return;
			case 'activate': {
				const receipt = await ctx.nm.activate(op.op.connectionId, op.op.deviceIfname);
				io.out(`  applied nm.activate -> ${receipt.status}: ${receipt.reason}`);
				return;
			}
			case 'deactivate': {
				const receipt = await ctx.nm.deactivate(op.op.connectionId, op.op.deviceIfname);
				io.out(`  applied nm.deactivate -> ${receipt.status}: ${receipt.reason}`);
				return;
			}
		}
	}
	switch (op.op.kind) {
		case 'setRadioModes': {
			const receipt = await ctx.backend.setRadioModes(ref, op.op.preference);
			io.out(`  applied mm.setRadioModes -> ${receipt.status}: ${receipt.reason}`);
			return;
		}
		case 'setPrimarySimSlot': {
			const receipt = await ctx.backend.setPrimarySimSlot(ref, op.op.slotIndex);
			io.out(`  applied mm.setPrimarySimSlot -> ${receipt.status}: ${receipt.reason}`);
			return;
		}
	}
}

/** Run the reconcile: plan, apply the ops, and print the receipts. Returns an exit code. */
export async function runApply(
	ctx: StackContext,
	io: CliIo,
	spec: PolicyFileSpec,
): Promise<number> {
	const list = await ctx.backend.start();
	const modem = selectModem(list.rows, spec.slot);
	if (modem === undefined) {
		io.err(
			`apply: no modem${spec.slot !== undefined ? ` matching slot '${spec.slot}'` : ''} observed`,
		);
		return 1;
	}
	if (!canBindPolicy(modem.identity)) {
		io.err(
			`apply: refusing — modem ${modem.identity.runtimePath} has a low-confidence identity; cannot bind durable policy`,
		);
		return 1;
	}
	const desired = toDesiredPolicy(spec, policyBindingKey(modem.identity));
	const plan = planReconcile(currentState(modem), desired, capabilities(modem));

	io.out(`apply: modem ${modem.identity.runtimePath} — ${plan.ops.length} op(s)`);
	for (const op of plan.ops) {
		await applyOp(ctx, modem, op, io);
	}
	io.out('receipts:');
	for (const receipt of plan.receipts) {
		io.out(`  ${receipt.dimension}: ${receipt.status} — ${receipt.reason}`);
	}
	return 0;
}
