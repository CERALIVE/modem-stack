import type { Brand } from './brand';
import { DomainError } from './errors';

export type PhysicalModemId = Brand<string, 'PhysicalModemId'>;
export type StableKey = Brand<string, 'StableKey'>;
export type PhysicalIdentitySource = 'serial' | 'id-path' | 'fallback';

export type PhysicalIdentityFacts = {
	readonly serial?: string;
	readonly idPath?: string;
	readonly fallback?: string;
};

export type ResolvedPhysicalModemIdentity = {
	readonly physicalModemId: PhysicalModemId;
	readonly stableKey: StableKey;
	readonly source: PhysicalIdentitySource;
};

export type PhysicalModemIdentityErrorReason =
	| 'empty'
	| 'unsupported-shape'
	| 'mm-object-path'
	| 'interface-name'
	| 'ip-address'
	| 'equipment-identifier'
	| 'subscriber-identifier'
	| 'fallback-too-long'
	| 'no-identity-facts';

export class PhysicalModemIdentityError extends DomainError {
	override readonly name = 'PhysicalModemIdentityError';

	constructor(readonly reason: PhysicalModemIdentityErrorReason) {
		super(`physical modem identity refused: ${reason}`);
	}
}

const PHYSICAL_ID_PREFIXES = [
	['serial', 'serial:'],
	['id-path', 'id-path:'],
	['fallback', 'fallback:'],
] as const;
const FALLBACK_MAX_LENGTH = 128;
const MM_OBJECT_PATH = /^\/org\/freedesktop\/ModemManager1\/Modem(?:\/|$)/;
const INTERFACE_NAME =
	/^(?:wwan|eth|enp|ens|eno|wlan|wl|ppp|usb|rmnet|cdc-wdm|ttyUSB|ttyACM)\d[\w.-]*$/i;
const EQUIPMENT_IDENTIFIER = /^\d{14,16}$/;
const SUBSCRIBER_IDENTIFIER = /^(?:89\d{16,30}|\d{18,32})$/;

function isIpv4(value: string): boolean {
	const octets = value.split('.');
	return (
		octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
	);
}

function isIpv6(value: string): boolean {
	if (!value.includes(':') || !/^[0-9a-f:]+$/i.test(value)) {
		return false;
	}
	const groups = value.split(':');
	const hasCompression = value.includes('::');
	const populatedGroups = groups.filter((group) => group.length > 0);
	return (
		populatedGroups.every((group) => group.length <= 4) &&
		(hasCompression ? populatedGroups.length < 8 : populatedGroups.length === 8)
	);
}

function assertSafeIdentityPart(value: string): void {
	if (value.length === 0) {
		throw new PhysicalModemIdentityError('empty');
	}
	if (MM_OBJECT_PATH.test(value)) {
		throw new PhysicalModemIdentityError('mm-object-path');
	}
	if (INTERFACE_NAME.test(value)) {
		throw new PhysicalModemIdentityError('interface-name');
	}
	if (isIpv4(value) || isIpv6(value)) {
		throw new PhysicalModemIdentityError('ip-address');
	}
	if (SUBSCRIBER_IDENTIFIER.test(value)) {
		throw new PhysicalModemIdentityError('subscriber-identifier');
	}
	if (EQUIPMENT_IDENTIFIER.test(value)) {
		throw new PhysicalModemIdentityError('equipment-identifier');
	}
}

function splitPhysicalModemId(value: string): readonly [PhysicalIdentitySource, string] {
	for (const [source, prefix] of PHYSICAL_ID_PREFIXES) {
		if (value.startsWith(prefix)) {
			return [source, value.slice(prefix.length)];
		}
	}
	throw new PhysicalModemIdentityError('unsupported-shape');
}

/** Construct only from a canonical serial/ID_PATH/bounded-fallback identity. */
export function physicalModemId(value: string): PhysicalModemId {
	const [source, identityPart] = splitPhysicalModemId(value.trim());
	assertSafeIdentityPart(identityPart);
	if (source === 'fallback' && identityPart.length > FALLBACK_MAX_LENGTH) {
		throw new PhysicalModemIdentityError('fallback-too-long');
	}
	return `${source}:${identityPart}` as PhysicalModemId;
}

/** Construct the actor/storage key for a validated physical modem identity. */
export function stableKeyFromPhysicalModemId(id: PhysicalModemId): StableKey {
	return `modem:${id}` as StableKey;
}

/** Parse a canonical stable key while re-validating its embedded physical identity. */
export function stableKey(value: string): StableKey {
	if (!value.startsWith('modem:')) {
		throw new PhysicalModemIdentityError('unsupported-shape');
	}
	return stableKeyFromPhysicalModemId(physicalModemId(value.slice('modem:'.length)));
}

/** Resolve one identity with the frozen serial → ID_PATH → bounded-fallback precedence. */
export function resolvePhysicalModemIdentity(
	facts: PhysicalIdentityFacts,
): ResolvedPhysicalModemIdentity {
	const candidates = [
		['serial', facts.serial],
		['id-path', facts.idPath],
		['fallback', facts.fallback],
	] as const;

	for (const [source, candidate] of candidates) {
		const normalized = candidate?.trim();
		if (normalized !== undefined && normalized.length > 0) {
			const id = physicalModemId(`${source}:${normalized}`);
			return { physicalModemId: id, stableKey: stableKeyFromPhysicalModemId(id), source };
		}
	}

	throw new PhysicalModemIdentityError('no-identity-facts');
}
