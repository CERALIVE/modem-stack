// The device-exact NetworkManager adapter: a FRESH nmcli-based `NetworkManagerPort`
// (no reused CeraUI code) with the full nine-field GSM write parity, verify-then-
// device-disconnect deactivation (never id-only `connection down`), abandoned-lease
// quiesce, and atomic Auto-APN transitions.

import { epochMillis } from '../domain';
import {
	type ConnectionId,
	connectionId,
	type DeviceIfname,
	type GsmProfile,
	type GsmProfileInput,
	type GsmProfilePatch,
	type NetworkManagerPort,
	type QuiesceLease,
	type Receipt,
	receipt,
} from '../ports';
import {
	AUTO_APN_ADVISORY,
	type AutoApnTransitionResult,
	classifyActivation,
	type ManualApn,
	toAutoArgs,
	toManualArgs,
} from './nm-auto-apn';
import { buildProfile, createGsmArgs, patchPairs } from './nm-gsm-fields';
import { type NmcliResult, type NmcliRunner, parseTerse, runNmcli } from './nmcli-runner';

const READBACK_FIELDS = [
	'connection.id',
	'gsm.apn',
	'gsm.username',
	'gsm.password',
	'gsm.password-flags',
	'gsm.home-only',
	'gsm.network-id',
	'gsm.auto-config',
	'connection.autoconnect',
	'connection.autoconnect-retries',
];

/** Default abandoned-lease TTL: a held quiesce lease older than this auto-releases. */
const DEFAULT_LEASE_TTL_MS = 60_000;

export interface NmcliNmPortOptions {
	readonly runner: NmcliRunner;
	/** Resolved once at boot by the capability probe; default `true`. */
	readonly autoApnCapable?: boolean;
	readonly leaseTtlMs?: number;
	readonly now?: () => number;
}

export class NmcliNmPort implements NetworkManagerPort {
	readonly #runner: NmcliRunner;
	readonly #autoApnCapable: boolean;
	readonly #leaseTtlMs: number;
	readonly #now: () => number;
	readonly #leases = new Set<QuiesceLease>();

	constructor(options: NmcliNmPortOptions) {
		this.#runner = options.runner;
		this.#autoApnCapable = options.autoApnCapable ?? true;
		this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
		this.#now = options.now ?? Date.now;
	}

	async createGsmProfile(profile: GsmProfileInput): Promise<GsmProfile> {
		const result = await runNmcli(this.#runner, createGsmArgs(profile));
		const uuid = /\(([^)]+)\) successfully added/.exec(result.stdout)?.[1];
		if (uuid === undefined) {
			throw new Error(`nmcli connection add failed: ${result.stderr || result.stdout}`);
		}
		return this.#requireProfile(connectionId(uuid));
	}

	async readGsmProfile(id: ConnectionId): Promise<GsmProfile | undefined> {
		const result = await runNmcli(this.#runner, [
			'-t',
			'-f',
			READBACK_FIELDS.join(','),
			'connection',
			'show',
			id,
		]);
		if (result.exitCode !== 0) {
			return undefined;
		}
		return buildProfile(id, parseTerse(result.stdout));
	}

	async updateGsmProfile(id: ConnectionId, patch: GsmProfilePatch): Promise<GsmProfile> {
		const result = await runNmcli(this.#runner, ['connection', 'modify', id, ...patchPairs(patch)]);
		if (result.exitCode !== 0) {
			throw new Error(`nmcli connection modify failed: ${result.stderr}`);
		}
		return this.#requireProfile(id);
	}

	async deleteGsmProfile(id: ConnectionId): Promise<void> {
		await runNmcli(this.#runner, ['connection', 'delete', id]);
	}

	async activate(id: ConnectionId, ifname: DeviceIfname): Promise<Receipt> {
		const result = await runNmcli(this.#runner, ['connection', 'up', id, 'ifname', ifname]);
		return activationReceipt(result, `activated ${id} on ${ifname}`);
	}

	async deactivate(id: ConnectionId, ifname: DeviceIfname): Promise<Receipt> {
		if ((await this.#activeUuidOn(ifname)) !== id) {
			return receipt('enabled', 'applied', `${id} not active on ${ifname}; nothing to deactivate`);
		}
		const result = await runNmcli(this.#runner, ['device', 'disconnect', ifname]);
		return activationReceipt(result, `deactivated ${id} on ${ifname}`);
	}

	async acquireQuiesceLease(id: ConnectionId, ifname: DeviceIfname): Promise<QuiesceLease> {
		if ((await this.#activeUuidOn(ifname)) === id) {
			await runNmcli(this.#runner, ['device', 'disconnect', ifname]);
		}
		const lease: QuiesceLease = {
			connectionId: id,
			deviceIfname: ifname,
			acquiredAt: epochMillis(this.#now()),
		};
		this.#leases.add(lease);
		return lease;
	}

	async releaseQuiesceLease(lease: QuiesceLease): Promise<void> {
		if (this.#leases.delete(lease)) {
			await this.#reactivate(lease);
		}
	}

	/** Reactivate every lease held past the TTL — the abandoned-lease watchdog. */
	async sweepExpiredLeases(now: number = this.#now()): Promise<void> {
		for (const lease of [...this.#leases]) {
			if (now - lease.acquiredAt >= this.#leaseTtlMs) {
				this.#leases.delete(lease);
				await this.#reactivate(lease);
			}
		}
	}

	/** Flip a profile to Auto-APN via ONE atomic modify, then reactivate + classify. */
	async transitionToAuto(id: ConnectionId, ifname: DeviceIfname): Promise<AutoApnTransitionResult> {
		if (!this.#autoApnCapable) {
			return {
				receipt: receipt('connection', 'unsupported', 'Auto-APN requires NetworkManager >= 1.22'),
				advisory: AUTO_APN_ADVISORY,
			};
		}
		const modify = await runNmcli(this.#runner, toAutoArgs(id));
		if (modify.exitCode !== 0) {
			return {
				receipt: receipt('connection', 'failed', modify.stderr || 'auto-config modify rejected'),
			};
		}
		return this.#reactivateAndClassify(id, ifname, true);
	}

	/** Flip a profile to manual APN via ONE atomic modify, then reactivate + classify. */
	async transitionToManual(
		id: ConnectionId,
		ifname: DeviceIfname,
		creds: ManualApn,
	): Promise<AutoApnTransitionResult> {
		const modify = await runNmcli(this.#runner, toManualArgs(id, creds));
		if (modify.exitCode !== 0) {
			return {
				receipt: receipt('connection', 'failed', modify.stderr || 'manual-apn modify rejected'),
			};
		}
		return this.#reactivateAndClassify(id, ifname, false);
	}

	async #reactivateAndClassify(
		id: ConnectionId,
		ifname: DeviceIfname,
		underAuto: boolean,
	): Promise<AutoApnTransitionResult> {
		const up = await runNmcli(this.#runner, ['connection', 'up', id, 'ifname', ifname]);
		return classifyActivation(up, { underAuto });
	}

	async #reactivate(lease: QuiesceLease): Promise<void> {
		await runNmcli(this.#runner, [
			'connection',
			'up',
			lease.connectionId,
			'ifname',
			lease.deviceIfname,
		]);
	}

	async #activeUuidOn(ifname: DeviceIfname): Promise<string | undefined> {
		const result = await runNmcli(this.#runner, [
			'-t',
			'-f',
			'UUID,DEVICE',
			'connection',
			'show',
			'--active',
		]);
		for (const line of result.stdout.split('\n')) {
			const [uuid, device] = line.split(':');
			if (device === ifname && uuid) {
				return uuid;
			}
		}
		return undefined;
	}

	async #requireProfile(id: ConnectionId): Promise<GsmProfile> {
		const profile = await this.readGsmProfile(id);
		if (profile === undefined) {
			throw new Error(`nmcli: profile ${id} did not read back`);
		}
		return profile;
	}
}

function activationReceipt(result: NmcliResult, appliedReason: string): Receipt {
	return result.exitCode === 0
		? receipt('enabled', 'applied', appliedReason)
		: receipt('enabled', 'failed', result.stderr || 'nmcli returned a non-zero exit code');
}
