import { describe, expect, test } from 'bun:test';
import { resolvePortablePhysicalIdentity } from './physical-identity';

describe('portable physical identity', () => {
	test('keeps one identity across a dual-mode VID:PID change', () => {
		const router = resolvePortablePhysicalIdentity({
			ifname: 'enx0',
			vendorId: '05c6',
			serial: '2b16081',
			idPath: 'usb-0:1.4.1',
		});
		const qmi = resolvePortablePhysicalIdentity({
			ifname: 'wwan0',
			vendorId: '05C6',
			serial: '2b16081',
			idPath: 'usb-0:1.4.1',
		});
		expect(qmi).toEqual(router);
		expect(router.anchor).toBe('usb-serial');
		expect(router.linkId).toMatch(/^lnk_[0-9a-f]{16}$/);
		expect(router.linkId).not.toContain('2b16081');
	});

	test('uses same-port identity when no serial exists', () => {
		expect(resolvePortablePhysicalIdentity({ ifname: 'eth1', idPath: 'usb-0:1.4.2' }).anchor).toBe(
			'id-path',
		);
		expect(resolvePortablePhysicalIdentity({ ifname: 'eth1' }).anchor).toBe('ifname');
	});
});
