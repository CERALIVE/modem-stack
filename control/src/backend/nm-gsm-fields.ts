// Pure nmcli GSM-connection argv builders — the FULL nine-field write parity today's
// CeraUI carried (modem-registration.ts `sanitizeModemConfigForNetworkManager` +
// `addConnectionForModem`), rebuilt from scratch for the device-exact adapter so the
// greenfield port loses nothing the wrap-first path wrote.
//
// The nine fields and their exact NM conventions (`gsm.*` + `connection.*` setting
// semantics) are the contract A4.1 must not regress:
//   gsm.apn / gsm.username / gsm.password  — creds ("" when unset)
//   gsm.password-flags                     — "4" NOT_REQUIRED (no password),
//                                            "0" NONE / system-stored (password set)
//   gsm.home-only                          — "yes" ⇒ roaming DISABLED
//   gsm.network-id                         — manual operator PLMN, only while roaming
//   gsm.auto-config                        — "yes" ⇒ Auto-APN (creds MUST be empty)
//   connection.autoconnect                 — always "yes"
//   connection.autoconnect-retries         — "2"

import type { ConnectionId, GsmProfile, GsmProfileInput, GsmProfilePatch } from '../ports';

// Empty-string fallback; Bun runtime limitation with empty CLI args: a bare
// `undefined` reaching `Bun.spawn` argv drops the slot and shifts every following
// token, so every optional nmcli value is coerced to "" first — the same `value || ""`
// convention CeraUI documented on gsm.apn / gsm.username / gsm.password.
export const cliArg = (value: string | undefined): string => value || '';

/** NM secret-flags: no password ⇒ NOT_REQUIRED ("4"); password set ⇒ NONE ("0"). */
export const passwordFlags = (password: string | undefined): string => (password ? '0' : '4');

/** `gsm.network-id` — the manual operator id, and only while roaming (home-only off). */
const networkIdField = (input: GsmProfileInput): string =>
	input.homeOnly ? '' : cliArg(input.networkId);

/**
 * The nine `gsm.*` + `connection.*` key/value pairs for a profile, in stable order.
 * With `autoConfig` set the creds are forced empty (NM rejects `auto-config yes` while
 * any credential is present — nm-setting-gsm.c:440-447), so an Auto-APN create is always
 * NM-valid by construction.
 */
export function gsmFieldPairs(input: GsmProfileInput): Array<[string, string]> {
	const auto = input.autoConfig;
	return [
		['gsm.apn', auto ? '' : cliArg(input.apn)],
		['gsm.username', auto ? '' : cliArg(input.username)],
		['gsm.password', auto ? '' : cliArg(input.password)],
		['gsm.password-flags', passwordFlags(auto ? undefined : input.password)],
		['gsm.home-only', input.homeOnly ? 'yes' : 'no'],
		['gsm.network-id', networkIdField(input)],
		['gsm.auto-config', auto ? 'yes' : 'no'],
		['connection.autoconnect', 'yes'],
		['connection.autoconnect-retries', '2'],
	];
}

/** Flatten key/value pairs into the alternating argv nmcli expects. */
export function flattenPairs(pairs: ReadonlyArray<readonly [string, string]>): string[] {
	return pairs.flat();
}

/** `connection add type gsm con-name <name> <nine fields>` — device-exact create argv. */
export function createGsmArgs(input: GsmProfileInput): string[] {
	return [
		'connection',
		'add',
		'type',
		'gsm',
		'con-name',
		input.connectionName,
		...flattenPairs(gsmFieldPairs(input)),
	];
}

/**
 * The key/value pairs for a `connection modify`. Roaming (home-only) and the manual
 * operator id move together — turning roaming off clears `gsm.network-id`, honoring the
 * `gsm.network-id = roaming ? id : ""` invariant in the SAME modify.
 */
export function patchPairs(patch: GsmProfilePatch): string[] {
	const pairs: string[] = [];
	if (patch.connectionName !== undefined) {
		pairs.push('connection.id', patch.connectionName);
	}
	if (patch.apn !== undefined) {
		pairs.push('gsm.apn', cliArg(patch.apn));
	}
	if (patch.username !== undefined) {
		pairs.push('gsm.username', cliArg(patch.username));
	}
	if (patch.password !== undefined) {
		pairs.push(
			'gsm.password',
			cliArg(patch.password),
			'gsm.password-flags',
			passwordFlags(patch.password),
		);
	}
	if (patch.autoConfig !== undefined) {
		pairs.push('gsm.auto-config', patch.autoConfig ? 'yes' : 'no');
	}
	if (patch.homeOnly !== undefined) {
		pairs.push('gsm.home-only', patch.homeOnly ? 'yes' : 'no');
		pairs.push('gsm.network-id', patch.homeOnly ? '' : cliArg(patch.networkId));
	} else if (patch.networkId !== undefined) {
		pairs.push('gsm.network-id', cliArg(patch.networkId));
	}
	return pairs;
}

/** Map an nmcli terse readback back onto a `GsmProfile` (inverse of the write parity). */
export function buildProfile(id: ConnectionId, settings: Map<string, string>): GsmProfile {
	const username = settings.get('gsm.username') ?? '';
	const password = settings.get('gsm.password') ?? '';
	const networkId = settings.get('gsm.network-id') ?? '';
	return {
		connectionId: id,
		connectionName: settings.get('connection.id') ?? '',
		apn: settings.get('gsm.apn') ?? '',
		homeOnly: settings.get('gsm.home-only') === 'yes',
		autoConfig: settings.get('gsm.auto-config') === 'yes',
		...(username !== '' ? { username } : {}),
		...(password !== '' ? { password } : {}),
		...(networkId !== '' ? { networkId } : {}),
	};
}
