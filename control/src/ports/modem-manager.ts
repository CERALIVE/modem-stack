// The ModemManager port — radio, SIM, scan, inhibit, and observation.
//
// CRITICAL INVARIANT (the single most safety-critical constraint in the package):
// this port has NO bearer / connection verb. There is no connect, no createBearer,
// no bearerConnect — MM's Simple.Connect / CreateBearer / Bearer.Connect are NEVER
// callable through here. NetworkManager is the sole owner of bearers and activation
// (see README ownership table). `forbidden-surface.test.ts` fails the build if any
// such method is ever added to this file.

import type { DesiredRadio, EpochMillis, RuntimePath } from '../domain';
import type { ModemObservationPort } from './observation';
import type { Receipt } from './receipts';

/** A live handle to one modem — its ModemManager D-Bus object path (per-boot). */
export type ModemRef = RuntimePath;

/** Outcome of a SIM PIN unlock attempt. */
export interface SimUnlockResult {
	readonly outcome: 'unlocked' | 'incorrect-pin' | 'sim-puk-required' | 'unsupported' | 'error';
	readonly remainingAttempts?: number;
	readonly reason: string;
}

/** Outcome of a SIM PUK unblock attempt. */
export interface SimPukUnlockResult {
	readonly outcome: 'unlocked' | 'incorrect-puk' | 'permanently-blocked' | 'unsupported' | 'error';
	readonly remainingAttempts?: number;
	readonly reason: string;
}

/** One operator returned by a network scan. */
export interface ScannedNetwork {
	/** MCC+MNC operator code. */
	readonly operatorCode: string;
	readonly operatorName?: string;
	readonly availability: 'available' | 'current' | 'forbidden' | 'unknown';
}

/** Result of a network scan — discriminated, retaining the reason on failure. */
export type NetworkScanResult =
	| { readonly ok: true; readonly networks: readonly ScannedNetwork[] }
	| { readonly ok: false; readonly reason: string };

/** A held inhibition over a modem, released via `uninhibit`. */
export interface InhibitLease {
	/** The equipment UID the inhibition is keyed to. */
	readonly uid: string;
	readonly acquiredAt: EpochMillis;
}

/**
 * The ModemManager port — EXTENDS the read-only observation port with the modem
 * mutations MM legitimately owns: radio modes, primary SIM slot, PIN / PUK unlock,
 * network scan, and inhibit / uninhibit. It owns NO bearer / connection lifecycle;
 * bearers and activation belong to `NetworkManagerPort`.
 */
export interface ModemManagerPort extends ModemObservationPort {
	/** Set the modem's radio access-technology preference. */
	setRadioModes(modem: ModemRef, preference: DesiredRadio): Promise<Receipt>;
	/** Select the primary SIM slot (multi-slot modems only). */
	setPrimarySimSlot(modem: ModemRef, slotIndex: number): Promise<Receipt>;
	/** Submit a SIM PIN (exactly-once; read-before-submit is the adapter's job). */
	sendPin(modem: ModemRef, pin: string): Promise<SimUnlockResult>;
	/** Submit a SIM PUK plus the new PIN (exactly-once). */
	sendPuk(modem: ModemRef, puk: string, newPin: string): Promise<SimPukUnlockResult>;
	/** Scan for visible networks (long-running). */
	scanNetworks(modem: ModemRef): Promise<NetworkScanResult>;
	/** Inhibit MM from managing a device (for a maintenance lease), keyed by UID. */
	inhibit(uid: string): Promise<InhibitLease>;
	/** Release a previously-taken inhibition. */
	uninhibit(lease: InhibitLease): Promise<void>;
}
