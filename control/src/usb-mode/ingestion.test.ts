// The ingestion seam's contract: a bundle round-trips into a schema-valid catalog entry
// and a real-shaped classifier fixture, the sha256 links the two, and a synthetic bundle
// is REFUSED for catalog promotion with a typed reason rather than silently accepted.

import { describe, expect, test } from 'bun:test';
import { classifyDevice, detectUsbMode } from '../backend/device-classifier';
import { catalogEntrySchema } from './catalog-schema';
import {
	buildCatalogEntryCandidate,
	buildClassifierFixture,
	type IngestionRequest,
	parseIngestionRequest,
} from './ingestion';
import { renderPromotionReview } from './promotion-review';
import { parseUsbDevices, selectUniqueDevice } from './usb-devices-parse';

const SHA = 'a'.repeat(64);

/** Verbatim-shaped `usb-devices` output for a QMI stick plus one unrelated hub. */
const USB_DEVICES = `
T:  Bus=04 Lev=01 Prnt=01 Port=00 Cnt=01 Dev#=  2 Spd=5000 MxCh= 4
D:  Ver= 3.20 Cls=09(hub  ) Sub=00 Prot=03 MxPS= 9 #Cfgs=  1
P:  Vendor=0bda ProdID=0411 Rev=01.01
S:  Manufacturer=Generic
S:  Product=USB3.2 Hub
I:  If#= 0 Alt= 0 #EPs= 1 Cls=09(hub  ) Sub=00 Prot=00 Driver=hub

T:  Bus=04 Lev=03 Prnt=04 Port=03 Cnt=01 Dev#=  7 Spd=480 MxCh= 0
D:  Ver= 2.00 Cls=00(>ifc ) Sub=00 Prot=00 MxPS=64 #Cfgs=  1
P:  Vendor=2c7c ProdID=0125 Rev=03.18
S:  Manufacturer=Quectel
S:  Product=SYNTHETIC-BENCH-STICK
I:  If#= 2 Alt= 0 #EPs= 3 Cls=ff(vend.) Sub=00 Prot=00 Driver=option
I:  If#= 4 Alt= 0 #EPs= 3 Cls=ff(vend.) Sub=ff Prot=ff Driver=qmi_wwan
`;

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		synthetic: false,
		capturedAtMs: 1_760_000_000_000,
		slot: 'Modem/2',
		sku: {
			vidPid: '2c7c:0125',
			model: 'CERALIVE-SYNTHETIC-TEST-SKU',
			firmwarePrefix: 'SYNTHETICFW01',
		},
		usb: {
			usbDevices: USB_DEVICES,
			udevProperties: {
				ID_PATH: 'platform-xhci-hcd.0.auto-usb-0:1.4.4',
				ID_VENDOR_ID: '2c7c',
				ID_MODEL_ID: '0125',
				INTERFACE: 'wwan0',
			},
		},
		// Fields the real bundle carries and the ingestion VIEW deliberately ignores.
		usbExtra: { lsusb: 'Device Descriptor:' },
		modemManager: { mmcliKeyfile: {}, managedObjects: {}, signalWindow: [] },
		...overrides,
	};
}

const request = (overrides: Record<string, unknown> = {}, sha = SHA): IngestionRequest => ({
	bundle: bundle(overrides),
	bundleSha256: sha,
});

const TRANSITION = {
	from: 'qmi',
	to: 'mbim',
	atCommand: 'AT+QCFG="usbnet",2',
	expectedResponse: 'OK',
	expectsPortDrop: true,
	afterDescriptors: {
		deviceClass: 0,
		interfaces: [
			{ interfaceClass: 2, interfaceSubClass: 14, interfaceProtocol: 0 },
			{ interfaceClass: 10, interfaceSubClass: 0, interfaceProtocol: 2 },
		],
	},
	timeline: [{ event: 'command-sent', atMs: 1 }],
};

describe('parseUsbDevices — the descriptor source a base bundle actually carries', () => {
	test('parses every device, its bDeviceClass, and each interface driver', () => {
		const devices = parseUsbDevices(USB_DEVICES);
		expect(devices).toHaveLength(2);
		const stick = devices[1];
		expect(stick?.vidPid).toBe('2c7c:0125');
		expect(stick?.bDeviceClass).toBe(0);
		expect(stick?.product).toBe('SYNTHETIC-BENCH-STICK');
		expect(stick?.interfaces).toEqual([
			{ interfaceClass: 0xff, interfaceSubClass: 0x00, interfaceProtocol: 0x00, driver: 'option' },
			{
				interfaceClass: 0xff,
				interfaceSubClass: 0xff,
				interfaceProtocol: 0xff,
				driver: 'qmi_wwan',
			},
		]);
	});

	test('a block with no P: line yields no record — identity is never invented', () => {
		expect(parseUsbDevices('T:  Bus=01\nI:  If#= 0 Cls=ff Sub=ff Prot=ff Driver=x')).toEqual([]);
	});

	test('a duplicate VID:PID is AMBIGUOUS, not first-wins (the Huawei HiLink pair)', () => {
		const pair = `${USB_DEVICES}\nT:  Bus=01 Lev=01\nD:  Cls=00\nP:  Vendor=2c7c ProdID=0125 Rev=03.18\nI:  If#= 0 Cls=ff Sub=ff Prot=ff Driver=qmi_wwan\n`;
		const selected = selectUniqueDevice(parseUsbDevices(pair), '2c7c:0125');
		expect(selected).toEqual({ ambiguousMatches: 2 });
	});
});

describe('buildClassifierFixture — the real udev shape, not a hand-typed approximation', () => {
	test('produces a snapshot the REAL classifier classifies correctly', () => {
		const outcome = buildClassifierFixture(request());
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		const { snapshot, provenance } = outcome.value;
		expect(snapshot.vendorId).toBe('2c7c');
		expect(snapshot.productId).toBe('0125');
		expect(snapshot.model).toBe('CERALIVE-SYNTHETIC-TEST-SKU');
		expect(snapshot.firmwareRevision).toBe('SYNTHETICFW01');
		expect(snapshot.physicalUid).toBe('platform-xhci-hcd.0.auto-usb-0:1.4.4');
		expect(snapshot.ifname).toBe('wwan0');
		// The whole point of deriving from real capture text: the fixture must survive
		// the production classifier, not merely typecheck.
		expect(classifyDevice(snapshot).deviceClass).toBe('mm-managed');
		expect(detectUsbMode(snapshot)).toBe('qmi');
		expect(provenance.bundleSha256).toBe(SHA);
		expect(provenance.synthetic).toBe(false);
	});

	test('a SYNTHETIC bundle still yields a fixture, stamped synthetic in provenance', () => {
		const outcome = buildClassifierFixture(request({ synthetic: true }));
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.value.provenance.synthetic).toBe(true);
		}
	});

	test('refuses a bundle with no sku (blocker B2 shape) rather than inventing one', () => {
		const outcome = buildClassifierFixture(request({ sku: undefined }));
		expect(outcome).toMatchObject({ ok: false, reason: 'sku-missing' });
	});

	test('refuses when the SKU is absent from the usb-devices capture', () => {
		const outcome = buildClassifierFixture(
			request({ sku: { ...(bundle().sku as object), vidPid: '1199:9071' } }),
		);
		expect(outcome).toMatchObject({ ok: false, reason: 'device-not-in-capture' });
	});
});

describe('buildCatalogEntryCandidate — schema round-trip and sha linkage', () => {
	test('a stage-1 bundle yields an entry with NO permitted transitions', () => {
		const outcome = buildCatalogEntryCandidate(request(), { canonicalMode: 'qmi' });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		expect(outcome.value.permittedTransitions).toEqual([]);
		// Round-trip through the AUTHORITATIVE schema, not the builder's own view.
		expect(catalogEntrySchema.parse(outcome.value)).toEqual(outcome.value);
	});

	test('a stage-2 bundle links the transition to THIS bundle sha256', () => {
		const sha = 'b'.repeat(64);
		const outcome = buildCatalogEntryCandidate(
			{ bundle: bundle({ transition: TRANSITION }), bundleSha256: sha },
			{ canonicalMode: 'qmi' },
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		const [transition] = outcome.value.permittedTransitions;
		expect(transition?.evidenceBundleSha256).toBe(sha);
		expect(transition?.expectedDescriptors).toEqual(TRANSITION.afterDescriptors);
		expect(transition?.atCommand).toBe('AT+QCFG="usbnet",2');
		expect(catalogEntrySchema.parse(outcome.value)).toEqual(outcome.value);
	});

	test('REFUSES a synthetic:true bundle for catalog promotion — typed, not silent', () => {
		const outcome = buildCatalogEntryCandidate(request({ synthetic: true }), {
			canonicalMode: 'qmi',
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) {
			return;
		}
		expect(outcome.reason).toBe('synthetic-bundle');
		expect(outcome.detail).toContain('synthetic:true');
	});

	test('refuses a claimed mode that contradicts the captured transition.from', () => {
		const outcome = buildCatalogEntryCandidate(
			{ bundle: bundle({ transition: TRANSITION }), bundleSha256: SHA },
			{ canonicalMode: 'mbim' },
		);
		expect(outcome).toMatchObject({ ok: false, reason: 'transition-mode-mismatch' });
	});

	test('refuses a router-mode SKU that carries a transition (schema invariant)', () => {
		const outcome = buildCatalogEntryCandidate(
			{ bundle: bundle({ transition: TRANSITION }), bundleSha256: SHA },
			{ canonicalMode: 'router-ethernet' },
		);
		// The mode cross-check fires first; either refusal is correct, neither is an accept.
		expect(outcome.ok).toBe(false);
	});

	test('accepts a router-mode SKU with no transitions (the RB-15 shape)', () => {
		const outcome = buildCatalogEntryCandidate(request(), { canonicalMode: 'router-ethernet' });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.value.canonicalMode).toBe('router-ethernet');
			expect(outcome.value.permittedTransitions).toEqual([]);
		}
	});

	test('refuses a malformed sha256 before reading the bundle at all', () => {
		expect(parseIngestionRequest({ bundle: bundle(), bundleSha256: 'nope' })).toMatchObject({
			ok: false,
			reason: 'sha256-malformed',
		});
	});

	test('refuses a bundle that fails the view schema', () => {
		expect(
			parseIngestionRequest({ bundle: { schemaVersion: 2 }, bundleSha256: SHA }),
		).toMatchObject({ ok: false, reason: 'bundle-malformed' });
	});
});

describe('renderPromotionReview — the review artifact, including for refusals', () => {
	test('renders the entry, the fixture, and a checklist on success', () => {
		const req = request();
		const comment = renderPromotionReview({
			context: { runbook: 'RB-11', evidencePath: 'test-results/modem-phase-b/08/x/bundle.json' },
			entry: buildCatalogEntryCandidate(req, { canonicalMode: 'qmi' }),
			fixture: buildClassifierFixture(req),
		});
		expect(comment).toContain('Proposed `certified-catalog.json` entry');
		expect(comment).toContain('Proposed classifier fixture');
		expect(comment).toContain('Reviewer checklist');
		expect(comment).toContain('RB-11');
		expect(comment).toContain('**This comment promotes');
	});

	test('a refused promotion renders the refusal and NO checklist', () => {
		const req = request({ synthetic: true });
		const comment = renderPromotionReview({
			context: { runbook: 'RB-11', evidencePath: 'x.json' },
			entry: buildCatalogEntryCandidate(req, { canonicalMode: 'qmi' }),
			fixture: buildClassifierFixture(req),
		});
		expect(comment).toContain('Catalog entry — REFUSED');
		expect(comment).toContain('`synthetic-bundle`');
		expect(comment).toContain('### No checklist');
		expect(comment).not.toContain('Reviewer checklist');
		// The fixture half still renders — synthetic fixtures are legitimate test data.
		expect(comment).toContain('Derived from a **synthetic** bundle');
	});
});
