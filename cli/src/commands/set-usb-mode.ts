// `modem-control set-usb-mode <slot> <target> --confirm` — a certified USB-mode switch.
//
// The `--confirm` flag maps DIRECTLY to the transaction's `confirm: true` precondition
// (A4.2). Omitting it MUST refuse the transition at entry with ZERO side effects (the
// A4.2 TIER-A entry refusal): the transaction never enters the actor, so no NM / MM / AT
// call is issued. `set-usb-mode` builds the request (physical facts resolved from the
// stack) and lets the transaction decide — the CLI never bypasses the entry gate.

import type {
	MmUsbMode,
	UsbModeTransition,
	UsbModeTransitionRequest,
} from '@ceralive/modem-control';
import type { CliIo } from '../io';

/** Parsed `set-usb-mode` arguments. */
export interface UsbModeArgs {
	readonly slot: string;
	readonly target: MmUsbMode;
	/** From the `--confirm` flag — maps to the transaction's `confirm` precondition. */
	readonly confirm: boolean;
	/** Bench runs are a maintenance context; the second A4.2 gate. */
	readonly maintenance: boolean;
}

/** Resolve the physical transition request for a slot, or explain why it cannot. */
export type RequestResolver = (
	args: UsbModeArgs,
) => Promise<
	| { readonly ok: true; readonly request: UsbModeTransitionRequest }
	| { readonly ok: false; readonly error: string }
>;

/** Run the transition and report its outcome. Returns a process exit code. */
export async function runSetUsbMode(
	io: CliIo,
	resolve: RequestResolver,
	transition: UsbModeTransition,
	args: UsbModeArgs,
): Promise<number> {
	const resolved = await resolve(args);
	if (!resolved.ok) {
		io.err(`set-usb-mode: ${resolved.error}`);
		return 1;
	}
	const outcome = await transition.execute(resolved.request);
	switch (outcome.status) {
		case 'refused':
			io.out(`set-usb-mode: REFUSED (${outcome.stage}) — ${outcome.reason}`);
			io.out(
				`steps: ${outcome.steps.length > 0 ? outcome.steps.join(' -> ') : '(none — zero side effects)'}`,
			);
			return 1;
		case 'failed':
			io.out(`set-usb-mode: FAILED${outcome.degraded ? ' (degraded)' : ''} — ${outcome.reason}`);
			io.out(`steps: ${outcome.steps.join(' -> ')}`);
			return 1;
		case 'succeeded':
			io.out(`set-usb-mode: OK ${args.slot} -> ${args.target} on ${outcome.newIfname}`);
			io.out(`steps: ${outcome.steps.join(' -> ')}`);
			return 0;
	}
}
