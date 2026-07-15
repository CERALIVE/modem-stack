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

import type { CanonicalUsbMode, ExpectedDescriptors } from '../usb-mode';

/** One USB interface's descriptor bytes plus its bound kernel driver, if any. */
export interface UsbInterface {
	readonly interfaceClass: number;
	readonly interfaceSubClass: number;
	readonly interfaceProtocol: number;
	/** The bound kernel driver (`qmi_wwan`, `cdc_mbim`, `option`, `cdc_ether`, …). */
	readonly driver?: string;
}

/** A single USB device as observed from udev/sysfs — the classifier's whole input. */
export interface UsbDeviceSnapshot {
	readonly vendorId: string;
	readonly productId: string;
	readonly model?: string;
	readonly firmwareRevision?: string;
	/** The device-descriptor `bDeviceClass` byte (0 ⇒ class is per-interface). */
	readonly bDeviceClass: number;
	readonly interfaces: readonly UsbInterface[];
	/** Stable physical-topology UID (udev `ID_PATH` / physdev) — survives a mode change. */
	readonly physicalUid?: string;
	/** The bound network interface name, if the device presents one (`wwan0`, `usb0`). */
	readonly ifname?: string;
	/** Raw udev properties (`ID_USB_MODESWITCH`, `ID_MM_CANDIDATE`, …). */
	readonly udevProperties?: Readonly<Record<string, string>>;
}

/** The four device classes. `pending-modeswitch` is distinct from `unmanaged`. */
export type DeviceClass = 'mm-managed' | 'router-mode' | 'unmanaged' | 'pending-modeswitch';

/** A classification plus a human-readable reason (always populated). */
export interface DeviceClassification {
	readonly deviceClass: DeviceClass;
	readonly reason: string;
}

// USB-IF class / subclass / protocol codes used below.
const CLASS_COMM = 0x02; // CDC communications (control interface)
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
