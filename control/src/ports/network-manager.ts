// The NetworkManager port — NM is the SOLE owner of bearers, APN, auth, roaming,
// autoconnect, and activation (see README ownership table). This port is the ONLY
// way the controller touches any of those resources; the ModemManager port has no
// bearer / connection verbs at all.

import type { Brand, EpochMillis } from '../domain';
import { nonEmptyString } from '../domain';
import type { Receipt } from './receipts';

/** A NetworkManager connection-profile UUID. */
export type ConnectionId = Brand<string, 'ConnectionId'>;

/** A kernel network-device interface name (e.g. `wwan0`). */
export type DeviceIfname = Brand<string, 'DeviceIfname'>;

/** Construct a `ConnectionId` from a non-empty NM connection UUID. */
export function connectionId(value: string): ConnectionId {
	return nonEmptyString(value, 'connectionId') as ConnectionId;
}

/** Construct a `DeviceIfname` from a non-empty interface name. */
export function deviceIfname(value: string): DeviceIfname {
	return nonEmptyString(value, 'deviceIfname') as DeviceIfname;
}

/**
 * A GSM connection profile — NM's `gsm.*` setting group. `password` is SENSITIVE
 * and MUST be redacted in every log / output (see `../redact`). The full nine-field
 * nmcli write parity lands with the concrete adapter (A4.1); this is the port
 * contract that adapter fulfils.
 */
export interface GsmProfileInput {
	readonly connectionName: string;
	/** Concrete APN, or the empty string when `autoConfig` drives it (A4.1). */
	readonly apn: string;
	readonly username?: string;
	/** SENSITIVE — redact everywhere. */
	readonly password?: string;
	/** `true` ⇒ `gsm.home-only` (roaming disabled). */
	readonly homeOnly: boolean;
	/** `true` ⇒ `gsm.auto-config yes` (Auto-APN); mutually exclusive with creds. */
	readonly autoConfig: boolean;
	/** Manual operator selection (`gsm.network-id`); empty unless roaming-pinned. */
	readonly networkId?: string;
}

/** A persisted GSM profile as read back from NM, keyed by its connection id. */
export interface GsmProfile extends GsmProfileInput {
	readonly connectionId: ConnectionId;
}

/** A partial update to an existing GSM profile. */
export type GsmProfilePatch = Partial<GsmProfileInput>;

/**
 * A quiesce lease — a held guarantee that the connection on THIS exact device stays
 * deactivated while a disruptive MM operation runs, then is reactivated on release.
 * Bound to BOTH `connectionId` and `deviceIfname` so it can never quiesce the wrong
 * device (the two-device isolation invariant, A4.1).
 */
export interface QuiesceLease {
	readonly connectionId: ConnectionId;
	readonly deviceIfname: DeviceIfname;
	readonly acquiredAt: EpochMillis;
}

/**
 * The NetworkManager port. Activation and deactivation take BOTH the connection id
 * AND the device interface name — never an id alone. This encodes, at the type
 * level, that we address a connection on an EXACT device (`nmcli connection up
 * <uuid> ifname <dev>` / verify-then-`device disconnect <ifname>`); the id-only
 * `nmcli connection down` is structurally impossible to express here (A4.1).
 */
export interface NetworkManagerPort {
	createGsmProfile(profile: GsmProfileInput): Promise<GsmProfile>;
	readGsmProfile(id: ConnectionId): Promise<GsmProfile | undefined>;
	updateGsmProfile(id: ConnectionId, patch: GsmProfilePatch): Promise<GsmProfile>;
	deleteGsmProfile(id: ConnectionId): Promise<void>;
	/** Activate `id` on the EXACT device `ifname`. */
	activate(id: ConnectionId, ifname: DeviceIfname): Promise<Receipt>;
	/** Deactivate `id` on the EXACT device `ifname`. */
	deactivate(id: ConnectionId, ifname: DeviceIfname): Promise<Receipt>;
	/** Take a quiesce lease over `id` on the EXACT device `ifname`. */
	acquireQuiesceLease(id: ConnectionId, ifname: DeviceIfname): Promise<QuiesceLease>;
	/** Release a quiesce lease, reactivating the connection it held down. */
	releaseQuiesceLease(lease: QuiesceLease): Promise<void>;
}
