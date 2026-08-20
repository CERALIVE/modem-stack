import { describe, expect, it } from 'bun:test';

import {
	fccUnlockRuntimeBinary,
	fccUnlockVendorScript,
	isFccUnlockKey,
	MM_FCC_UNLOCK_COVERAGE,
	MM_FCC_UNLOCK_VENDOR_SCRIPTS,
	normalizeVidPid,
	resolveFccUnlockCoverage,
} from './coverage';

describe('the ModemManager 1.24.2 coverage catalog', () => {
	it('Given the pinned release, When the catalog is read, Then it is the 14 shipped entries over 4 vendor scripts', () => {
		expect(Object.keys(MM_FCC_UNLOCK_COVERAGE)).toHaveLength(14);
		expect(Object.keys(MM_FCC_UNLOCK_VENDOR_SCRIPTS).sort()).toEqual([
			'105b',
			'1199',
			'14c3',
			'2c7c',
		]);
		for (const script of Object.values(MM_FCC_UNLOCK_COVERAGE)) {
			expect(script in MM_FCC_UNLOCK_VENDOR_SCRIPTS).toBe(true);
		}
	});

	it('Given every catalog key, When its shape is checked, Then all are the dispatcher <vid>:<pid> form', () => {
		for (const key of Object.keys(MM_FCC_UNLOCK_COVERAGE)) {
			expect(isFccUnlockKey(key)).toBe(true);
		}
	});

	// The whole reason the key is <vid>:<pid>: one silicon vendor, three USB vendor
	// ids. A vendor-keyed rule would miss the HP and Dell rebrands entirely.
	it('Given Sierra silicon under three vendor ids, When resolved, Then all three map to the 1199 script', () => {
		expect(fccUnlockVendorScript('1199:9079')).toBe('1199');
		expect(fccUnlockVendorScript('03f0:4e1d')).toBe('1199');
		expect(fccUnlockVendorScript('413c:81a3')).toBe('1199');
	});

	it('Given a covered key, When its interpreter is asked, Then it names the packaged binary', () => {
		expect(fccUnlockRuntimeBinary('2c7c:0801')).toBe('qmicli');
		expect(fccUnlockRuntimeBinary('14c3:4d75')).toBe('mbimcli');
		expect(fccUnlockRuntimeBinary('12d1:14dc')).toBeUndefined();
	});
});

describe('normalizeVidPid', () => {
	it('Given mixed case and a 0x prefix, When normalized, Then it folds to the dispatcher spelling', () => {
		expect(normalizeVidPid('2C7C', '0801')).toBe('2c7c:0801');
		expect(normalizeVidPid('0x2c7c', '0x0801')).toBe('2c7c:0801');
		expect(normalizeVidPid(' 2c7c ', ' 0801 ')).toBe('2c7c:0801');
	});

	it('Given an id that is not 4 hex digits, When normalized, Then it is refused rather than padded', () => {
		expect(normalizeVidPid('2c7', '0801')).toBeUndefined();
		expect(normalizeVidPid('2c7c', '00801')).toBeUndefined();
		expect(normalizeVidPid('zzzz', '0801')).toBeUndefined();
		expect(normalizeVidPid('', '')).toBeUndefined();
	});
});

describe('resolveFccUnlockCoverage — three answers, none interchangeable', () => {
	// The one fleet modem MM ships a procedure for (todo 2 bench inventory).
	it('Given the bench Quectel RM530N-GL, When coverage is resolved, Then it is present', () => {
		expect(resolveFccUnlockCoverage('2c7c', '0801')).toBe('present');
	});

	it.each([
		['Huawei E3372 HiLink', '12d1', '14dc'],
		['ZTE MF79U-class', '19d2', '1405'],
		['SIMCom SIM7600G-H', '1e0e', '9001'],
		['Qualcomm reference stick', '05c6', '9091'],
		// MM covers the FM350's PCIe identity 14c3:4d75; on the USB carrier board it
		// re-enumerates under MediaTek's own vendor id, which is NOT in the mapping.
		['Fibocom FM350-GL on a USB carrier', '0e8d', '7127'],
	])('Given %s, When coverage is resolved, Then it is a positive absent', (_name, vid, pid) => {
		expect(resolveFccUnlockCoverage(vid, pid)).toBe('absent');
	});

	it('Given the FM350 native PCIe identity, When coverage is resolved, Then it is present', () => {
		expect(resolveFccUnlockCoverage('14c3', '4d75')).toBe('present');
	});

	// A statement about the READ is not a statement about the DEVICE. Folding this
	// into `absent` would hide the module on hardware that may well be covered.
	it.each([
		['no ids at all', undefined, undefined],
		['a missing pid', '2c7c', undefined],
		['an unparseable id', 'nope', '0801'],
	])('Given %s, When coverage is resolved, Then it is unknown', (_name, vid, pid) => {
		expect(resolveFccUnlockCoverage(vid, pid)).toBe('unknown');
	});
});
