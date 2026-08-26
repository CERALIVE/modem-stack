// Device classification — deciding, from a udev/sysfs snapshot alone, whether a USB
// device is a ModemManager-manageable modem, a router-ethernet uplink MM cannot
// control, a modem still in mass-storage installer mode, or something we simply do
// not recognize.
//
// THE HONESTY RULE (draft §gap sweep, matrix §1): the classifier NEVER guesses. An
// ambiguous descriptor set returns `unmanaged` with a truthful reason, not a
// confident-sounding wrong class. A control-port presence — not a vendor id — decides
// `mm-managed`; a bare vendor-specific interface with no recognized driver is NOT a
// modem. `pending-modeswitch` is a DISTINCT state (a modem installer awaiting
// `usb_modeswitch`), never conflated with `unmanaged`.
//
// SCOPE — USB ONLY: the whole input here is a `UsbDeviceSnapshot`, a udev/sysfs view of a
// USB device. PCIe modems are out of scope by construction and get NO entry in this model —
// a PCI `vendor:device` pair is never smuggled in as a pseudo-USB identity. The Fibocom
// FM350 is the canonical example: it is a PCIe module (PCI `14c3:4d75`, bound by the
// `mtk_t7xx` driver on the `wwan`/`net` subsystems, with no USB VID:PID), so it is
// documented-deferred rather than classified here. See `docs/FM350-DECISION.md` for the
// evidence and the three-gate ledger behind that decision.

import type { CanonicalUsbMode, ExpectedDescriptors } from '../usb-mode';
import type { UsbDeviceSnapshot, UsbInterface } from './usb-device-snapshot';

export type { UsbDeviceSnapshot, UsbInterface } from './usb-device-snapshot';

/** The four device classes. `pending-modeswitch` is distinct from `unmanaged`. */
export type DeviceClass = 'mm-managed' | 'router-mode' | 'unmanaged' | 'pending-modeswitch';
export type UsbNetClass = 'mm-managed' | 'router-cellular' | 'wired-ethernet' | 'unknown';

/** A classification plus a human-readable reason (always populated). */
export interface DeviceClassification {
	readonly deviceClass: DeviceClass;
	readonly reason: string;
}

export interface UsbNetClassification {
	readonly deviceClass: UsbNetClass;
	readonly reason: string;
}

// USB-IF class / subclass / protocol codes used below.
const CLASS_COMM = 0x02; // CDC communications (control interface)
const CLASS_CDC_DATA = 0x0a;
const CLASS_MASS_STORAGE = 0x08;
const CLASS_WIRELESS = 0xe0; // wireless controller (RNDIS lives here)
const CLASS_VENDOR = 0xff;
const SUB_ACM = 0x02; // abstract control model (AT commands)
const SUB_ECM = 0x06;
const SUB_NCM = 0x0d;
const SUB_MBIM = 0x0e;
const SUB_RNDIS_WIRELESS = 0x01;
const PROTO_VENDOR = 0xff;
const PROTO_RNDIS = 0x03;

const QMI_DRIVERS: ReadonlySet<string> = new Set(['qmi_wwan']);
const AT_DRIVERS: ReadonlySet<string> = new Set(['option', 'qcserial', 'cdc_acm']);
const ECM_NCM_DRIVERS: ReadonlySet<string> = new Set(['cdc_ether', 'cdc_ncm']);
const RNDIS_DRIVERS: ReadonlySet<string> = new Set(['rndis_host']);
const STORAGE_DRIVERS: ReadonlySet<string> = new Set(['usb-storage', 'uas']);

export type CellularModelEvidenceTier =
	| 'modemmanager-1.24.2-fcc'
	| 'mainline-kernel'
	| 'usb-ids-registry';

/**
 * A POSITIVE, sourced claim that a labelled family is a router appliance whose only
 * control surface is a vendor web UI — no ModemManager plugin, no kernel modem driver
 * claiming its application PID. ABSENCE OF THIS FIELD IS NOT A CLAIM: it does not say
 * a family is a modem module, only that nothing here asserts otherwise. Same tri-state
 * discipline as `fcc/coverage.ts` — `unknown` is never folded into `absent`.
 *
 * It also does not, and must not, decide a DEVICE CLASS. `classifyDevice` reads live
 * interfaces and bound drivers; this label is model-family evidence sitting beside it.
 */
export type CellularModelFamilyKind = 'router-webui';

export interface CellularModelEvidence {
	readonly vendor: string;
	readonly family: string;
	readonly evidenceTier: CellularModelEvidenceTier;
	readonly familyKind?: CellularModelFamilyKind;
}

/** Where each evidence tier's rows were read from, so a reviewer can re-check them. */
export const CELLULAR_MODEL_EVIDENCE_SOURCES = {
	'modemmanager-1.24.2-fcc': {
		source: 'ModemManager 1.24.2 data/dispatcher-fcc-unlock/meson.build',
		pin: 'f2b9ab1ad78d322f32134a444b5b54c6e8160e19',
	},
	'mainline-kernel': {
		source: 'Linux drivers/net/usb/qmi_wwan.c + drivers/usb/serial/option.c',
		pin: '45c13f3f9e3bb15fd89ff2864c6f627a3b4b4229',
	},
	'usb-ids-registry': {
		source: 'The USB ID Repository (linux-usb.org/usb.ids)',
		pin: '2026.06.26',
	},
} as const satisfies Record<CellularModelEvidenceTier, { source: string; pin: string }>;

/**
 * Exact model-family evidence. This table may label a known VID:PID, but it never
 * decides whether the device is MM-managed: live interface/driver evidence below
 * remains authoritative. The pinned ModemManager FCC map is the strongest tier;
 * `mainline-kernel` rows are application-mode PIDs named by Linux's own qmi_wwan /
 * qcserial / option device tables; `usb-ids-registry` is the weakest and is used only
 * where NO kernel modem driver claims the id at all — which is itself the evidence
 * that the device is a router appliance rather than a controllable module.
 *
 * EVERY ROW IS AN EXACT VID:PID. A vendor range is never inferred, and that is not a
 * stylistic preference: NETGEAR's `0846` and u-blox's `1546` both carry non-cellular
 * products (Wi-Fi/Ethernet adapters and GNSS receivers respectively), so a
 * vendor-keyed rule on either would label hardware that has no radio.
 */
export const CELLULAR_USB_MODEL_ROWS: ReadonlyMap<string, CellularModelEvidence> = new Map([
	[
		'03f0:4e1d',
		{ vendor: 'Sierra Wireless', family: 'EM74xx', evidenceTier: 'modemmanager-1.24.2-fcc' },
	],
	['1199:9071', { vendor: 'Sierra Wireless', family: 'EM74xx', evidenceTier: 'mainline-kernel' }],
	[
		'1199:9079',
		{ vendor: 'Sierra Wireless', family: 'EM74xx', evidenceTier: 'modemmanager-1.24.2-fcc' },
	],
	['1199:907b', { vendor: 'Sierra Wireless', family: 'EM74xx', evidenceTier: 'mainline-kernel' }],
	['1199:9091', { vendor: 'Sierra Wireless', family: 'EM75xx', evidenceTier: 'mainline-kernel' }],
	['1199:90d3', { vendor: 'Sierra Wireless', family: 'EM919x', evidenceTier: 'mainline-kernel' }],
	['1199:c081', { vendor: 'Sierra Wireless', family: 'EM75xx', evidenceTier: 'mainline-kernel' }],
	[
		'413c:81a3',
		{ vendor: 'Sierra Wireless', family: 'EM74xx', evidenceTier: 'modemmanager-1.24.2-fcc' },
	],
	[
		'413c:81a8',
		{ vendor: 'Sierra Wireless', family: 'EM74xx', evidenceTier: 'modemmanager-1.24.2-fcc' },
	],
	['1bc7:1031', { vendor: 'Telit', family: 'LE910C1-EUX', evidenceTier: 'mainline-kernel' }],
	['1bc7:1034', { vendor: 'Telit', family: 'LE910C4-WWX', evidenceTier: 'mainline-kernel' }],
	['1bc7:1040', { vendor: 'Telit', family: 'LE922A', evidenceTier: 'mainline-kernel' }],
	['1bc7:1050', { vendor: 'Telit', family: 'FN980', evidenceTier: 'mainline-kernel' }],
	['1bc7:1060', { vendor: 'Telit', family: 'LN920', evidenceTier: 'mainline-kernel' }],
	['1bc7:1070', { vendor: 'Telit', family: 'FN990A', evidenceTier: 'mainline-kernel' }],
	['1bc7:1080', { vendor: 'Telit', family: 'FE990A', evidenceTier: 'mainline-kernel' }],
	['1bc7:10a0', { vendor: 'Telit', family: 'FN920C04', evidenceTier: 'mainline-kernel' }],
	['1bc7:1100', { vendor: 'Telit', family: 'ME910', evidenceTier: 'mainline-kernel' }],
	['1bc7:1200', { vendor: 'Telit', family: 'LE920', evidenceTier: 'mainline-kernel' }],
	['1546:1311', { vendor: 'u-blox', family: 'LARA-R6', evidenceTier: 'mainline-kernel' }],
	['1546:1312', { vendor: 'u-blox', family: 'LARA-R6', evidenceTier: 'mainline-kernel' }],
	['1546:1313', { vendor: 'u-blox', family: 'LARA-R6', evidenceTier: 'mainline-kernel' }],
	['1546:1341', { vendor: 'u-blox', family: 'LARA-L6', evidenceTier: 'mainline-kernel' }],
	['1546:1342', { vendor: 'u-blox', family: 'LARA-L6', evidenceTier: 'mainline-kernel' }],
	['1546:1343', { vendor: 'u-blox', family: 'LARA-L6', evidenceTier: 'mainline-kernel' }],
	[
		'0846:68e1',
		{
			vendor: 'NETGEAR',
			family: 'LB1120',
			evidenceTier: 'usb-ids-registry',
			familyKind: 'router-webui',
		},
	],
]);

/**
 * Vendor ids whose ENTIRE USB range is cellular, so the vendor id alone is honest
 * evidence of a radio. Membership is a claim about the whole range, which is why
 * NETGEAR's `0846` is deliberately ABSENT despite having a row above: the USB ID
 * Repository lists that vendor's Wi-Fi and Ethernet adapters under it, so a
 * vendor-keyed rule there would report a Wi-Fi dongle as a cellular uplink.
 */
export const CELLULAR_USB_VENDOR_IDS: ReadonlyMap<string, string> = new Map([
	['05c6', 'Qualcomm'],
	['0af0', 'Option'],
	['1199', 'Sierra Wireless'],
	['12d1', 'Huawei'],
	['1546', 'u-blox'],
	['19d2', 'ZTE'],
	['1bbb', 'TCL/Alcatel'],
	['1bc7', 'Telit'],
	['1c9e', 'Longcheer'],
	['1e0e', 'SIMCom'],
	['2c7c', 'Quectel'],
	['2cb7', 'Fibocom'],
	['413c', 'Dell'],
]);

function isMbimControl(i: UsbInterface): boolean {
	return i.interfaceClass === CLASS_COMM && i.interfaceSubClass === SUB_MBIM;
}

function isQmiControl(i: UsbInterface): boolean {
	return i.interfaceClass === CLASS_VENDOR && i.driver !== undefined && QMI_DRIVERS.has(i.driver);
}

function isAtControl(i: UsbInterface): boolean {
	// Standard CDC-ACM AT port (protocol 0xff on 0x02/0x02 is RNDIS, not AT).
	if (
		i.interfaceClass === CLASS_COMM &&
		i.interfaceSubClass === SUB_ACM &&
		i.interfaceProtocol !== PROTO_VENDOR
	) {
		return true;
	}
	// Vendor-specific serial port bound to a known AT driver.
	return i.interfaceClass === CLASS_VENDOR && i.driver !== undefined && AT_DRIVERS.has(i.driver);
}

function isRndis(i: UsbInterface): boolean {
	if (
		i.interfaceClass === CLASS_WIRELESS &&
		i.interfaceSubClass === SUB_RNDIS_WIRELESS &&
		i.interfaceProtocol === PROTO_RNDIS
	) {
		return true;
	}
	if (
		i.interfaceClass === CLASS_COMM &&
		i.interfaceSubClass === SUB_ACM &&
		i.interfaceProtocol === PROTO_VENDOR
	) {
		return true;
	}
	return i.driver !== undefined && RNDIS_DRIVERS.has(i.driver);
}

function isEcmNcmData(i: UsbInterface): boolean {
	if (
		i.interfaceClass === CLASS_COMM &&
		(i.interfaceSubClass === SUB_ECM || i.interfaceSubClass === SUB_NCM)
	) {
		return true;
	}
	return i.driver !== undefined && ECM_NCM_DRIVERS.has(i.driver);
}

function isMassStorage(i: UsbInterface): boolean {
	if (i.interfaceClass === CLASS_MASS_STORAGE) {
		return true;
	}
	return i.driver !== undefined && STORAGE_DRIVERS.has(i.driver);
}

function isVendorSpecific(i: UsbInterface): boolean {
	return i.interfaceClass === CLASS_VENDOR;
}

function controlKind(i: UsbInterface): string {
	if (isMbimControl(i)) {
		return 'MBIM';
	}
	return isQmiControl(i) ? 'QMI' : 'AT';
}

/** Whether a mass-storage device is a modem awaiting `usb_modeswitch` (not a plain disk). */
function isModeswitchCandidate(snapshot: UsbDeviceSnapshot): boolean {
	const flag = snapshot.udevProperties?.ID_USB_MODESWITCH;
	if (flag !== undefined && flag !== '' && flag !== '0') {
		return true;
	}
	const model = (snapshot.model ?? '').toLowerCase();
	return ['cd-rom', 'installer', 'zerocd', 'autoinstall'].some((marker) => model.includes(marker));
}

function unmanagedReason(snapshot: UsbDeviceSnapshot, hasStorage: boolean): string {
	if (hasStorage) {
		return 'mass-storage device with no usb_modeswitch trigger — not a recognized modem installer';
	}
	if (snapshot.interfaces.some(isVendorSpecific)) {
		return 'vendor-specific interface(s) with no recognized modem driver — cannot confidently classify';
	}
	return 'no recognized modem control port, Ethernet tether, or installer interface';
}

/**
 * Classify one USB device from its udev/sysfs snapshot. Precedence:
 *   1. a recognized MM control port (MBIM / QMI / AT) ⇒ `mm-managed`;
 *   2. a network tether with NO control port (ECM / NCM / RNDIS) ⇒ `router-mode`;
 *   3. mass storage with a `usb_modeswitch` trigger ⇒ `pending-modeswitch`;
 *   4. anything else ⇒ `unmanaged`, with an honest reason — NEVER a guessed class.
 */
export function classifyDevice(snapshot: UsbDeviceSnapshot): DeviceClassification {
	const ifaces = snapshot.interfaces;

	const control = ifaces.find((i) => isMbimControl(i) || isQmiControl(i) || isAtControl(i));
	if (control !== undefined) {
		return {
			deviceClass: 'mm-managed',
			reason: `recognized ${controlKind(control)} control interface — ModemManager-manageable`,
		};
	}

	const tether = ifaces.find((i) => isRndis(i) || isEcmNcmData(i));
	if (tether !== undefined) {
		const kind = isRndis(tether) ? 'RNDIS' : 'ECM/NCM';
		return {
			deviceClass: 'router-mode',
			reason: `${kind} Ethernet tether with no modem control port — router-ethernet class, not MM-manageable`,
		};
	}

	const hasStorage = ifaces.some(isMassStorage) || snapshot.bDeviceClass === CLASS_MASS_STORAGE;
	if (hasStorage && isModeswitchCandidate(snapshot)) {
		return {
			deviceClass: 'pending-modeswitch',
			reason: 'mass-storage installer mode with a usb_modeswitch trigger — awaiting mode switch',
		};
	}

	return { deviceClass: 'unmanaged', reason: unmanagedReason(snapshot, hasStorage) };
}

export function cellularVendorName(vendorId: string): string | undefined {
	return CELLULAR_USB_VENDOR_IDS.get(vendorId.toLowerCase());
}

export function cellularModelEvidence(
	device: Pick<UsbDeviceSnapshot, 'vendorId' | 'productId'>,
): CellularModelEvidence | undefined {
	return CELLULAR_USB_MODEL_ROWS.get(`${device.vendorId}:${device.productId}`.toLowerCase());
}

export function cellularEvidence(device: UsbDeviceSnapshot): string | undefined {
	const vendor = cellularVendorName(device.vendorId);
	if (vendor !== undefined)
		return `USB vendor ${device.vendorId} is ${vendor}, a cellular-module vendor`;
	const modeswitch = device.udevProperties?.ID_USB_MODESWITCH;
	if (modeswitch !== undefined && modeswitch !== '' && modeswitch !== '0')
		return 'device carries a usb_modeswitch trigger — a mode-switching dongle';
	return device.interfaces.some(isMassStorage)
		? 'device also presents a mass-storage installer interface — the ZeroCD personality of a router-mode dongle'
		: undefined;
}

export function classifyUsbNetDevice(device: UsbDeviceSnapshot): UsbNetClassification {
	const control = device.interfaces.find(
		(i) => isMbimControl(i) || isQmiControl(i) || isAtControl(i),
	);
	if (control !== undefined)
		return {
			deviceClass: 'mm-managed',
			reason: `recognized ${controlKind(control)} control interface — ModemManager-manageable`,
		};
	const tether = device.interfaces.find(
		(i) => isRndis(i) || isEcmNcmData(i) || i.interfaceClass === CLASS_CDC_DATA,
	);
	if (tether !== undefined) {
		const kind = isRndis(tether) ? 'RNDIS' : 'ECM/NCM';
		const evidence = cellularEvidence(device);
		return evidence === undefined
			? {
					deviceClass: 'wired-ethernet',
					reason: `${kind} Ethernet tether with no modem control port and no cellular evidence — a USB network adapter`,
				}
			: {
					deviceClass: 'router-cellular',
					reason: `${kind} Ethernet tether with no modem control port; ${evidence}`,
				};
	}
	return {
		deviceClass: 'unknown',
		reason: unmanagedReason(
			device,
			device.interfaces.some(isMassStorage) || device.bDeviceClass === CLASS_MASS_STORAGE,
		),
	};
}

export function publishesGenericIdentity(device: UsbDeviceSnapshot): boolean {
	const manufacturer = device.manufacturer?.trim();
	const product = device.product?.trim();
	return Boolean(manufacturer && product && manufacturer.toLowerCase() === product.toLowerCase());
}

export function vendorLabel(device: UsbDeviceSnapshot): string {
	const published = device.manufacturer?.trim();
	if (published && !publishesGenericIdentity(device)) return published;
	return cellularVendorName(device.vendorId) ?? device.databaseVendor?.trim() ?? device.vendorId;
}

export function modelLabel(device: UsbDeviceSnapshot): string {
	const published = device.product?.trim();
	if (published && !publishesGenericIdentity(device)) return published;
	return device.databaseModel?.trim() ?? device.productId;
}

export function unitDiscriminator(device: UsbDeviceSnapshot): string | undefined {
	const serial = device.serialNumber?.trim();
	if (!serial) return undefined;
	const folded = serial.toLowerCase();
	return folded === device.manufacturer?.trim().toLowerCase() ||
		folded === device.product?.trim().toLowerCase()
		? undefined
		: serial;
}

/**
 * Derive the USB composition MODE a device is currently in (for a transition's
 * postcondition). Distinct from `classifyDevice`: this reads the data-plane
 * composition, MBIM and RNDIS being unambiguous descriptor signatures, an ECM/NCM
 * data interface being `ecm-ncm` only when a control/vendor port accompanies it
 * (else it is a dumb `router-ethernet` tether), and a bare vendor interface being
 * `qmi`. Returns `undefined` when nothing recognizable is present.
 */
export function detectUsbMode(snapshot: UsbDeviceSnapshot): CanonicalUsbMode | undefined {
	const ifaces = snapshot.interfaces;
	if (ifaces.some(isMbimControl)) {
		return 'mbim';
	}
	if (ifaces.some(isRndis)) {
		return 'rndis';
	}
	if (ifaces.some(isEcmNcmData)) {
		const hasControl = ifaces.some((i) => isAtControl(i) || isVendorSpecific(i));
		return hasControl ? 'ecm-ncm' : 'router-ethernet';
	}
	if (ifaces.some((i) => isQmiControl(i) || isVendorSpecific(i))) {
		return 'qmi';
	}
	return undefined;
}

/**
 * Whether a device presents (at least) the descriptors a catalog transition expects
 * after re-enumeration — the descriptor half of the postcondition. Every expected
 * interface triple must be present and `bDeviceClass` must match.
 */
export function descriptorsMatch(
	snapshot: UsbDeviceSnapshot,
	expected: ExpectedDescriptors,
): boolean {
	if (snapshot.bDeviceClass !== expected.deviceClass) {
		return false;
	}
	return expected.interfaces.every((exp) =>
		snapshot.interfaces.some(
			(i) =>
				i.interfaceClass === exp.interfaceClass &&
				i.interfaceSubClass === exp.interfaceSubClass &&
				i.interfaceProtocol === exp.interfaceProtocol,
		),
	);
}
