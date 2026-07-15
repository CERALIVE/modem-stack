// Text rendering for the bench CLI's `probe` / `watch` output.
//
// Pure string builders — no I/O — so they are trivially unit-testable and shared by
// both commands. The one hard rule: the SENSITIVE subscription id (ICCID / EID) is
// NEVER printed raw; it is shown as a redacted presence marker only.

import type {
	CellReading,
	CellularSnapshot,
	DeviceClassification,
	MmFeatures,
	ModemEnrichment,
	ModemIdentity,
	ResolvedIdentity,
	UsbDeviceSnapshot,
} from '@ceralive/modem-control';

/** A redacted marker for a present-but-sensitive value. */
const REDACTED = '[redacted]';

/** Render the equipment id as `provenance:value(confidence)` — value is not sensitive. */
function renderEquipment(identity: ModemIdentity): string {
	const equipment = identity.equipmentId;
	if (equipment.provenance === 'none') {
		return `none(${equipment.confidence})`;
	}
	return `${equipment.provenance}:${equipment.value}(${equipment.confidence})`;
}

/** Render a modem identity line; the subscription id is redacted, never shown raw. */
export function renderIdentity(identity: ModemIdentity): string {
	const parts = [
		`path=${identity.runtimePath}`,
		`equipment=${renderEquipment(identity)}`,
		`slot=${identity.logicalSlotId ?? '-'}`,
		`sim=${identity.subscriptionId !== undefined ? REDACTED : '-'}`,
	];
	return parts.join(' ');
}

/** Render the identity-ladder resolution (slot source, confidence, stable key). */
export function renderResolvedIdentity(resolved: ResolvedIdentity): string {
	return `ladder: source=${resolved.slotSource} confidence=${resolved.confidence} key=${resolved.stableKey}`;
}

/** Render the orthogonal lifecycle state of a snapshot. */
export function renderState(snapshot: CellularSnapshot): string {
	const rats = [...snapshot.registration.activeRats].join('+') || '-';
	return [
		`presence=${snapshot.presence}`,
		`health=${snapshot.sourceHealth}`,
		`mm=${snapshot.mmState}`,
		`radio=${snapshot.radioPower}`,
		`reg=${snapshot.registration.status}(${rats})`,
		`nm=${snapshot.nmActivation}`,
		`rev=${snapshot.revision}`,
	].join(' ');
}

/** Render the MM feature-detection result. */
export function renderFeatures(features: MmFeatures): string {
	return [
		`physdev=${features.physdev}`,
		`cellInfo=${features.cellInfo}`,
		`esim=${features.esimStatus}`,
		`opSerialization=${features.opSerialization}`,
	].join(' ');
}

/** Render one normalized cell reading. */
export function renderCellReading(reading: CellReading): string {
	const parts = [reading.serving ? 'serving' : 'neighbor'];
	if (reading.cellId !== undefined) parts.push(`cellId=${reading.cellId}`);
	if (reading.pci !== undefined) parts.push(`pci=${reading.pci}`);
	if (reading.rsrp !== undefined) parts.push(`rsrp=${reading.rsrp}`);
	if (reading.rsrq !== undefined) parts.push(`rsrq=${reading.rsrq}`);
	if (reading.sinr !== undefined) parts.push(`sinr=${reading.sinr}`);
	if (reading.band !== undefined) parts.push(`band=${reading.band}`);
	return parts.join(' ');
}

/** Render the read-only enrichment (firmware, eSIM, signal cadence, serving cell). */
export function renderEnrichment(enrichment: ModemEnrichment): string {
	return [
		`firmware=${enrichment.revision ?? '-'}`,
		`simType=${enrichment.esim.simType}`,
		`esimStatus=${enrichment.esim.esimStatus}`,
		`signalCadence=${enrichment.signalCadence}`,
	].join(' ');
}

/** Render one classified USB device (class + observed mode). */
export function renderUsbDevice(
	device: UsbDeviceSnapshot,
	classification: DeviceClassification,
	mode: string | undefined,
): string {
	return [
		`${device.vendorId}:${device.productId}`,
		`class=${classification.deviceClass}`,
		`mode=${mode ?? 'unknown'}`,
		`reason=${classification.reason}`,
	].join(' ');
}
