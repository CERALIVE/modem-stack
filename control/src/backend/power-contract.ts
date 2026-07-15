// The modem power-control capability contract — recovery ladder rung 4.
//
// Power control becomes a first-class v1 CONTRACT (draft §gap sweep: Sixfab GPIO26
// power-cut + PWRKEY-pulse boards, BELABOX-reported RM520N USB instability needing a
// powered carrier). The FIELDS ship in Phase A; the board-specific GPIO / USB-hub
// IMPLEMENTATIONS stay hardware-gated. Only the `none` capability is implemented (a
// no-op), so ladder rung 4 always returns `unsupported` on today's hardware — every
// real mechanism is a typed-but-unsupported placeholder.

import type { EpochMillis } from '../domain';

/** How a board can power-cycle a modem. Only `none` is implemented in Phase A. */
export type PowerCapabilityKind = 'none' | 'gpio-cut' | 'pwrkey-pulse' | 'usb-hub-port-cycle';

/**
 * The USB data mode a modem should re-enumerate into after a power cycle. A4.2 owns
 * the certified USB-mode catalog; the power contract only records the operator's
 * preferred post-cycle enumeration mode.
 */
export type PreferredUsbMode = 'qmi' | 'mbim' | 'ecm-ncm' | 'rndis' | 'router-ethernet';

/** A board's modem power-control capability description. */
export interface PowerCapability {
	readonly power: PowerCapabilityKind;
	/** The board can pulse a USB-level reset on the modem's port. */
	readonly usbReset?: boolean;
	/** How long to wait for the modem to re-enumerate after a cycle. */
	readonly enumerationTimeoutMs: number;
	/** Which USB mode to prefer when the modem re-enumerates (A4.2 catalog vocabulary). */
	readonly preferredUsbMode?: PreferredUsbMode;
}

/** The Phase-A capability: no board power control exists — a no-op. */
export const NONE_POWER_CAPABILITY: PowerCapability = {
	power: 'none',
	enumerationTimeoutMs: 30_000,
};

/** Outcome of asking the power hook to cycle a modem. */
export interface PowerCycleResult {
	readonly status: 'applied' | 'unsupported' | 'failed';
	readonly reason: string;
}

/** The minimal context handed to the power hook. */
export interface PowerCycleContext {
	readonly stableKey: string;
	readonly at: EpochMillis;
}

/**
 * The pluggable power-cycle hook (recovery ladder rung 4). Phase A ships only the
 * `none` no-op; a real GPIO / PWRKEY / USB-hub implementation is hardware-gated and
 * injected later without changing the ladder.
 */
export interface PowerHook {
	readonly capability: PowerCapability;
	cycle(context: PowerCycleContext): Promise<PowerCycleResult>;
}

/**
 * Build a Phase-A power hook for `capability`. EVERY capability returns
 * `unsupported`: `none` because there is nothing to cut, and every real mechanism
 * because its hardware driver is not implemented yet — the contract field exists so
 * a board can DECLARE the capability, but rung 4 never actuates in Phase A.
 */
export function unsupportedPowerHook(capability: PowerCapability): PowerHook {
	return {
		capability,
		cycle(): Promise<PowerCycleResult> {
			return Promise.resolve({
				status: 'unsupported',
				reason:
					capability.power === 'none'
						? "power capability 'none' — no board power control exists"
						: `power capability '${capability.power}' is declared but not implemented in Phase A`,
			});
		},
	};
}

/** The Phase-A default power hook: describes `none` and always returns `unsupported`. */
export const NONE_POWER_HOOK: PowerHook = unsupportedPowerHook(NONE_POWER_CAPABILITY);
