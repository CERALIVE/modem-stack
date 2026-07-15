// `/proc/net/dev` parser — proves rx+tx cumulative totals over the real fixed-column
// format, header skipping, and fail-soft handling of malformed rows.

import { describe, expect, test } from 'bun:test';
import { parseProcNetDev } from './proc-net-dev';

// A real capture (columns: rx bytes packets errs drop fifo frame compressed multicast
// | tx bytes packets errs drop fifo colls carrier compressed).
const REAL = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 160183007830 18519510    0    0    0     0          0         0 160183007830 18519510    0    0    0     0       0          0
  eno2: 88166142004 86575608    0    0   48     0          0    146660 25843393633 48414413    0    3    0     0       0          0
 wlan0: 44865976  194892    0    0    0     0          0         0  5698312   36057    0   23    0     0       0          0
`;

describe('parseProcNetDev', () => {
	test('reads rx+tx cumulative bytes for each interface, skipping the 2-line header', () => {
		const counters = parseProcNetDev(REAL);
		expect(counters.size).toBe(3);
		// lo: 160183007830 (rx) + 160183007830 (tx).
		expect(counters.get('lo')).toBe(160183007830 + 160183007830);
		// eno2: rx 88166142004 + tx 25843393633.
		expect(counters.get('eno2')).toBe(88166142004 + 25843393633);
		// wlan0: rx 44865976 + tx 5698312.
		expect(counters.get('wlan0')).toBe(44865976 + 5698312);
	});

	test('handles bridge-style names with no leading space and long names', () => {
		const text = `h1
h2
br-d739ee545df1: 575402021  542380    0    0    0     0          0         0 450821722  810015    0    4    0     0       0          0
docker0: 1750867165 1097738    0    0    0     0          0         0 5810268898 1237921    0 12223    0     0       0          0
`;
		const counters = parseProcNetDev(text);
		expect(counters.get('br-d739ee545df1')).toBe(575402021 + 450821722);
		expect(counters.get('docker0')).toBe(1750867165 + 5810268898);
	});

	test('ignores malformed / short rows without throwing', () => {
		const text = `h1
h2
    lo: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0
garbage-without-colon 1 2 3
  short: 1 2 3
   nan: x 1 0 0 0 0 0 0 y 2 0 0 0 0 0 0
`;
		const counters = parseProcNetDev(text);
		// Only the well-formed `lo` row survives.
		expect(counters.size).toBe(1);
		expect(counters.get('lo')).toBe(300);
	});

	test('empty input yields an empty map', () => {
		expect(parseProcNetDev('').size).toBe(0);
	});
});
