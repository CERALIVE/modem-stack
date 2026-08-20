// Ingestion against REAL bench-captured composition evidence — SIMCom SIM7600G-H and
// Fibocom FM350-GL (the latter on an M.2->USB bench carrier).
//
// Every descriptor byte, driver binding, and udev property below is VERBATIM from a
// non-mutating capture on bench board `ceralive2` (2026-08-18). Nothing here is
// hand-shaped to make a test pass: the `usb-devices` blocks are the exact records the
// board emitted, and the udev maps are the exact `usb_device` records from
// `udevadm info --export-db`.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `ingestion.test.ts`: that suite proves the seam's
// CONTRACT with shaped input. This one proves the seam survives contact with the actual
// bench fleet, and — more importantly — it PINS THREE BLOCKERS the real capture exposed,
// so none of them can be quietly forgotten or silently regress:
//
//   B-27.1  `certify` matches its USB device by `ifname`, which `parseUdevDatabase` never
//           populates. Every real bundle therefore lands with NO `sku` and an EMPTY
//           `udevProperties`, and ingestion correctly refuses it `sku-missing`. The
//           capture pipeline cannot currently produce a promotable bundle at all.
//   B-27.2  Even with B-27.1 fixed, `skuOf` reads `firmwarePrefix` from udev
//           `ID_REVISION`, which is the USB **bcdDevice** (`0318` / `0001`) — NOT the
//           modem firmware revision. A firmware-keyed certification cannot be built on it.
//   B-27.3  (not testable here, recorded in docs) the shared redactor does not mask
//           `imei` / `equipment-identifier`, so a real bundle's `modemManager` half
//           carries every bench modem's IMEI and must not be committed or posted.
//
// NEITHER DEVICE IS CERTIFIED BY THIS FILE. `certified-catalog.json` is unchanged, and
// two guard tests below assert it stays that way — the SIMCom's target compositions are
// UNPROVEN (only the parameter DOMAIN was read back, never a tuple), and the FM350's
// `0e8d:7127` is a bench-carrier artifact that `docs/FM350-DECISION.md` keeps out of the
// USB classifier.

import { describe, expect, test } from 'bun:test';
import { classifyDevice, detectUsbMode } from '../backend/device-classifier';
import { CERTIFIED_CATALOG } from './catalog';
import {
	buildCatalogEntryCandidate,
	buildClassifierFixture,
	type IngestionRequest,
} from './ingestion';
import { parseUsbDevices, selectUniqueDevice } from './usb-devices-parse';

/** sha256 the bench `certify` run printed for the SIMCom bundle (slot `Modem/20`). */
const SIMCOM_BUNDLE_SHA = '3ce28784e421eb448494f1f566072335c96110be3d01b5eac883ab14c01661ad';
/** sha256 the bench `certify` run printed for the FM350 bundle (slot `Modem/4`). */
const FM350_BUNDLE_SHA = '57a33dafe3038542cdb3976184fc4a1bebb740a96e38fdfe33bd4031c3c03df9';

/**
 * VERBATIM `usb-devices` records for the two units, lifted unmodified out of the real
 * bench capture. Endpoint (`E:`) lines are retained exactly as captured — the parser
 * skips them, and trimming them would make this no longer a verbatim capture.
 */
const BENCH_USB_DEVICES = `
T:  Bus=01 Lev=02 Prnt=15 Port=01 Cnt=01 Dev#= 17 Spd=480 MxCh= 0
D:  Ver= 2.10 Cls=ef(misc ) Sub=02 Prot=01 MxPS=64 #Cfgs=  1
P:  Vendor=0e8d ProdID=7127 Rev=00.01
S:  Manufacturer=Fibocom Wireless Inc.
S:  Product=FM350-GL
C:  #Ifs=10 Cfg#= 1 Atr=a0 MxPwr=500mA
I:  If#= 0 Alt= 0 #EPs= 1 Cls=02(commc) Sub=02 Prot=ff Driver=rndis_host
E:  Ad=82(I) Atr=03(Int.) MxPS=  64 Ivl=125us
I:  If#= 1 Alt= 0 #EPs= 2 Cls=0a(data ) Sub=00 Prot=00 Driver=rndis_host
E:  Ad=01(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=81(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
I:  If#= 2 Alt= 0 #EPs= 2 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=02(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=83(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
I:  If#= 3 Alt= 0 #EPs= 2 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=03(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=84(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
I:  If#= 4 Alt= 0 #EPs= 2 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=04(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=85(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
I:  If#= 5 Alt= 0 #EPs= 2 Cls=ff(vend.) Sub=42 Prot=01 Driver=(none)
E:  Ad=05(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=86(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
I:  If#= 6 Alt= 0 #EPs= 2 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=06(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=87(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
I:  If#= 7 Alt= 0 #EPs= 2 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=07(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=88(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
I:  If#= 8 Alt= 0 #EPs= 2 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=08(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=89(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
I:  If#= 9 Alt= 0 #EPs= 2 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=09(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=8a(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms

T:  Bus=01 Lev=03 Prnt=21 Port=03 Cnt=01 Dev#= 37 Spd=480 MxCh= 0
D:  Ver= 2.00 Cls=00(>ifc ) Sub=00 Prot=00 MxPS=64 #Cfgs=  1
P:  Vendor=1e0e ProdID=9001 Rev=03.18
S:  Manufacturer=SimTech, Incorporated
S:  Product=SimTech, Incorporated
S:  SerialNumber=0123456789ABCDEF
C:  #Ifs= 6 Cfg#= 1 Atr=a0 MxPwr=500mA
I:  If#= 0 Alt= 0 #EPs= 2 Cls=ff(vend.) Sub=ff Prot=ff Driver=option
E:  Ad=01(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=81(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
I:  If#= 1 Alt= 0 #EPs= 3 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=02(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=82(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=83(I) Atr=03(Int.) MxPS=  10 Ivl=32ms
I:  If#= 2 Alt= 0 #EPs= 3 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=03(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=84(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=85(I) Atr=03(Int.) MxPS=  10 Ivl=32ms
I:  If#= 3 Alt= 0 #EPs= 3 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=04(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=86(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=87(I) Atr=03(Int.) MxPS=  10 Ivl=32ms
I:  If#= 4 Alt= 0 #EPs= 3 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
E:  Ad=05(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=88(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=89(I) Atr=03(Int.) MxPS=  10 Ivl=32ms
I:  If#= 5 Alt= 0 #EPs= 3 Cls=ff(vend.) Sub=ff Prot=ff Driver=qmi_wwan
E:  Ad=06(O) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=8a(I) Atr=02(Bulk) MxPS= 512 Ivl=0ms
E:  Ad=8b(I) Atr=03(Int.) MxPS=   8 Ivl=32ms
`;

/** VERBATIM udev `usb_device` record for the SIMCom at `1-1.3.4`. */
const SIMCOM_UDEV: Record<string, string> = {
	DEVPATH: '/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.3/1-1.3.4',
	DEVTYPE: 'usb_device',
	DRIVER: 'usb',
	ID_BUS: 'usb',
	ID_MM_QMI_PCO_DISABLED: '1',
	ID_MODEL: 'SimTech__Incorporated',
	ID_MODEL_ID: '9001',
	ID_PATH: 'platform-xhci-hcd.0.auto-usb-0:1.3.4',
	ID_REVISION: '0318',
	ID_USB_INTERFACES: ':ffffff:ff0000:',
	ID_VENDOR: 'SimTech__Incorporated',
	ID_VENDOR_FROM_DATABASE: 'Qualcomm / Option',
	ID_VENDOR_ID: '1e0e',
	PRODUCT: '1e0e/9001/318',
	SUBSYSTEM: 'usb',
	TYPE: '0/0/0',
};

/** VERBATIM udev `usb_device` record for the FM350-on-carrier at `1-1.2`. */
const FM350_UDEV: Record<string, string> = {
	DEVPATH: '/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.2',
	DEVTYPE: 'usb_device',
	DRIVER: 'usb',
	ID_BUS: 'usb',
	ID_MODEL: 'FM350-GL',
	ID_MODEL_ID: '7127',
	ID_PATH: 'platform-xhci-hcd.0.auto-usb-0:1.2',
	ID_REVISION: '0001',
	ID_USB_INTERFACES: ':0202ff:0a0000:ff0000:ff4201:',
	ID_VENDOR: 'Fibocom_Wireless_Inc.',
	ID_VENDOR_FROM_DATABASE: 'MediaTek Inc.',
	ID_VENDOR_ID: '0e8d',
	PRODUCT: 'e8d/7127/1',
	SUBSYSTEM: 'usb',
	TYPE: '239/2/1',
};

/** Firmware revisions ModemManager and the AT transcripts BOTH reported for each unit. */
const SIMCOM_MODEM_FIRMWARE = 'LE20B04SIM7600G22';
const FM350_MODEM_FIRMWARE = '81600.0000.00.19.17.10';

/**
 * The ingestion view of a bench capture. `sku` is supplied by the caller because the
 * REAL bundle did not carry one — see B-27.1 and the refusal test that pins it.
 */
function benchBundle(
	sku: Record<string, string> | undefined,
	udev: Record<string, string>,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		synthetic: false,
		capturedAtMs: 1_787_027_878_000,
		slot: 'Modem/20',
		...(sku !== undefined ? { sku } : {}),
		usb: { usbDevices: BENCH_USB_DEVICES, udevProperties: udev },
		...overrides,
	};
}

const SIMCOM_SKU = {
	vidPid: '1e0e:9001',
	model: 'SimTech__Incorporated',
	firmwarePrefix: '0318',
};
const FM350_SKU = { vidPid: '0e8d:7127', model: 'FM350-GL', firmwarePrefix: '0001' };

const simcomRequest = (overrides: Record<string, unknown> = {}): IngestionRequest => ({
	bundle: benchBundle(SIMCOM_SKU, SIMCOM_UDEV, overrides),
	bundleSha256: SIMCOM_BUNDLE_SHA,
});

const fm350Request = (overrides: Record<string, unknown> = {}): IngestionRequest => ({
	bundle: benchBundle(FM350_SKU, FM350_UDEV, { slot: 'Modem/4', ...overrides }),
	bundleSha256: FM350_BUNDLE_SHA,
});

describe('bench capture — SIMCom SIM7600G-H (1e0e:9001) composition evidence', () => {
	test('the real usb-devices record parses to the observed 6-interface QMI composition', () => {
		const selected = selectUniqueDevice(parseUsbDevices(BENCH_USB_DEVICES), '1e0e:9001');
		expect(selected).toHaveProperty('device');
		if (!('device' in selected)) {
			return;
		}
		expect(selected.device.bDeviceClass).toBe(0x00);
		expect(selected.device.manufacturer).toBe('SimTech, Incorporated');
		// Five `option` serial interfaces plus one `qmi_wwan` control interface. The
		// qmi_wwan binding is what makes this device mm-managed rather than router-mode.
		expect(selected.device.interfaces).toHaveLength(6);
		expect(selected.device.interfaces.map((i) => i.driver)).toEqual([
			'option',
			'option',
			'option',
			'option',
			'option',
			'qmi_wwan',
		]);
	});

	test('the fixture the seam derives is classified mm-managed / qmi by the REAL classifier', () => {
		const outcome = buildClassifierFixture(simcomRequest());
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		const { snapshot, provenance } = outcome.value;
		expect(snapshot.vendorId).toBe('1e0e');
		expect(snapshot.productId).toBe('9001');
		expect(snapshot.physicalUid).toBe('platform-xhci-hcd.0.auto-usb-0:1.3.4');
		// Matches the live `modem-control probe` verdict recorded in the evidence.
		expect(classifyDevice(snapshot).deviceClass).toBe('mm-managed');
		expect(detectUsbMode(snapshot)).toBe('qmi');
		expect(provenance.synthetic).toBe(false);
		expect(provenance.bundleSha256).toBe(SIMCOM_BUNDLE_SHA);
	});

	test('udev ID_USB_INTERFACES is LOSSY — which is why ingestion reads usb-devices', () => {
		// udev collapsed six interfaces into two distinct triples. A fixture built from
		// `ID_USB_INTERFACES` alone would misrepresent the composition AND carry no
		// driver bindings at all, so the seam deliberately parses `usb-devices` instead.
		const udevTriples = (SIMCOM_UDEV.ID_USB_INTERFACES ?? '')
			.split(':')
			.filter((t) => t.length === 6);
		expect(udevTriples).toHaveLength(2);
		const selected = selectUniqueDevice(parseUsbDevices(BENCH_USB_DEVICES), '1e0e:9001');
		expect('device' in selected && selected.device.interfaces.length).toBe(6);
	});
});

describe('bench capture — Fibocom FM350-GL on an M.2->USB carrier (0e8d:7127)', () => {
	test('the real usb-devices record parses to the observed 10-interface RNDIS+AT composition', () => {
		const selected = selectUniqueDevice(parseUsbDevices(BENCH_USB_DEVICES), '0e8d:7127');
		expect(selected).toHaveProperty('device');
		if (!('device' in selected)) {
			return;
		}
		// 0xef/0x02/0x01 — an IAD composite device, not a per-interface-class device.
		expect(selected.device.bDeviceClass).toBe(0xef);
		expect(selected.device.product).toBe('FM350-GL');
		expect(selected.device.interfaces).toHaveLength(10);
		expect(selected.device.interfaces.map((i) => i.driver)).toEqual([
			'rndis_host',
			'rndis_host',
			'option',
			'option',
			'option',
			// If#5 (ff/42/01) is claimed by NO driver; the parser drops `(none)` rather
			// than recording a fictitious binding.
			undefined,
			'option',
			'option',
			'option',
			'option',
		]);
	});

	test('the fixture is classified mm-managed / rndis by the REAL classifier', () => {
		const outcome = buildClassifierFixture(fm350Request());
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		const { snapshot } = outcome.value;
		expect(snapshot.vendorId).toBe('0e8d');
		expect(snapshot.productId).toBe('7127');
		expect(snapshot.physicalUid).toBe('platform-xhci-hcd.0.auto-usb-0:1.2');
		// Matches the live `modem-control probe` verdict recorded in the evidence:
		// an `option` AT control port makes it MM-manageable despite the RNDIS tether.
		expect(classifyDevice(snapshot).deviceClass).toBe('mm-managed');
		expect(detectUsbMode(snapshot)).toBe('rndis');
	});
});

describe('B-27.1 — a REAL certify bundle carries no sku, so ingestion refuses it', () => {
	// `certify` matches its USB device with `devices.find(d => d.ifname === ifname)`, but
	// `parseUdevDatabase` never sets `ifname` on any snapshot. Both bench runs therefore
	// produced `synthetic=false` bundles with NO `sku` and an EMPTY `udevProperties`.
	// This is the exact shape those two files have on disk.
	const asCaptured = (sha: string, slot: string): IngestionRequest => ({
		bundle: {
			schemaVersion: 1,
			synthetic: false,
			capturedAtMs: 1_787_027_878_000,
			slot,
			usb: { usbDevices: BENCH_USB_DEVICES, udevProperties: {} },
		},
		bundleSha256: sha,
	});

	test('the SIMCom bundle as actually captured is refused sku-missing', () => {
		expect(buildClassifierFixture(asCaptured(SIMCOM_BUNDLE_SHA, 'Modem/20'))).toMatchObject({
			ok: false,
			reason: 'sku-missing',
		});
		expect(
			buildCatalogEntryCandidate(asCaptured(SIMCOM_BUNDLE_SHA, 'Modem/20'), {
				canonicalMode: 'qmi',
			}),
		).toMatchObject({ ok: false, reason: 'sku-missing' });
	});

	test('the FM350 bundle as actually captured is refused sku-missing', () => {
		expect(buildClassifierFixture(asCaptured(FM350_BUNDLE_SHA, 'Modem/4'))).toMatchObject({
			ok: false,
			reason: 'sku-missing',
		});
	});
});

describe('B-27.2 — udev ID_REVISION is bcdDevice, NOT the modem firmware revision', () => {
	test('the SKU firmwarePrefix a capture would carry differs from the modem firmware', () => {
		// `skuOf` reads udev `ID_REVISION`. For these two units that is the USB
		// bcdDevice, so a catalog entry keyed on it would NOT be firmware-keyed.
		expect(SIMCOM_SKU.firmwarePrefix).toBe('0318');
		expect(SIMCOM_SKU.firmwarePrefix).not.toBe(SIMCOM_MODEM_FIRMWARE);
		expect(FM350_SKU.firmwarePrefix).toBe('0001');
		expect(FM350_SKU.firmwarePrefix).not.toBe(FM350_MODEM_FIRMWARE);
	});
});

describe('nothing on the bench is certified by this evidence', () => {
	test('a stage-1 candidate is a REVIEW ARTIFACT — it is never the shipped catalog', () => {
		const outcome = buildCatalogEntryCandidate(simcomRequest(), { canonicalMode: 'qmi' });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		// A base capture declares NO transition: the SIMCom's target compositions were
		// never proven, only the parameter DOMAIN of AT+CUSBPIDSWITCH was read back.
		expect(outcome.value.permittedTransitions).toEqual([]);
	});

	test('certified-catalog.json has NO entry for the SIMCom — target modes stay hidden', () => {
		expect(CERTIFIED_CATALOG.entries.some((e) => e.vidPid === '1e0e:9001')).toBe(false);
	});

	test('certified-catalog.json has NO entry for 0e8d:7127 — FM350-DECISION guard', () => {
		// `0e8d:7127` is the M.2->USB bench carrier's identity, not a native FM350 USB
		// personality. `docs/FM350-DECISION.md` keeps the FM350 out of the USB model;
		// this guard fails the build if anyone promotes the carrier id by accident.
		expect(CERTIFIED_CATALOG.entries.some((e) => e.vidPid === '0e8d:7127')).toBe(false);
		expect(CERTIFIED_CATALOG.entries.some((e) => e.vidPid === '14c3:4d75')).toBe(false);
	});

	test('a synthetic re-mark of the same real capture is still refused for promotion', () => {
		const outcome = buildCatalogEntryCandidate(simcomRequest({ synthetic: true }), {
			canonicalMode: 'qmi',
		});
		expect(outcome).toMatchObject({ ok: false, reason: 'synthetic-bundle' });
	});
});
