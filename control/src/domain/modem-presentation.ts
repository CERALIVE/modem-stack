const BARE_NUMERAL_RE = /^\d{1,4}$/;
const MMCLI_EMPTY = '--';

export interface ModemHardwareIdentity {
	readonly model?: string;
	readonly manufacturer?: string;
	readonly firmwareRevision?: string;
	readonly equipmentId?: string;
}

export function isUninformativeIdentity(value: string | undefined): boolean {
	const trimmed = value?.trim();
	return (
		trimmed === undefined ||
		trimmed === '' ||
		trimmed === MMCLI_EMPTY ||
		BARE_NUMERAL_RE.test(trimmed)
	);
}

export function firmwareIdentityLabel(revision: string | undefined): string | undefined {
	const trimmed = revision?.trim();
	if (!trimmed || trimmed === MMCLI_EMPTY) return undefined;
	const head =
		trimmed
			.replace(/\s*\[[^\]]*]\s*$/, '')
			.trim()
			.split(/\s{2,}/)[0]
			?.trim() ?? '';
	return head.length >= 3 && /[A-Za-z]/.test(head) ? head : undefined;
}

export function modemHardwareLabel(identity: ModemHardwareIdentity): string {
	const model = identity.model?.trim();
	if (model !== undefined && !isUninformativeIdentity(model)) return model;
	const firmware = firmwareIdentityLabel(identity.firmwareRevision);
	if (firmware !== undefined) return firmware;
	const manufacturer = identity.manufacturer?.trim();
	return manufacturer !== undefined && !isUninformativeIdentity(manufacturer)
		? manufacturer
		: 'Cellular modem';
}

export function modemHardwareName(identity: ModemHardwareIdentity): string {
	const label = modemHardwareLabel(identity);
	const equipmentId = identity.equipmentId?.trim();
	return !equipmentId || equipmentId === MMCLI_EMPTY
		? label
		: `${label} - ${equipmentId.slice(-5)}`;
}
