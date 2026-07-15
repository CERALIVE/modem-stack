// The catalog schema is a SAFETY BOUNDARY: the two invariants it enforces (only
// within-MM transitions are expressible; no unknown field slips through) are what
// keep an uncertified or MM↔router switch from ever becoming valid catalog data.

import { describe, expect, test } from 'bun:test';
import {
	CERTIFIED_CATALOG,
	findCatalogEntry,
	findPermittedTransition,
	loadCertifiedCatalog,
} from './catalog';
import { catalogEntrySchema, certifiedCatalogSchema } from './catalog-schema';

function validCatalog(): unknown {
	return {
		schemaVersion: 1,
		entries: [
			{
				vidPid: '2c7c:0125',
				model: 'TEST-SKU',
				firmwarePrefix: 'FW01',
				canonicalMode: 'qmi',
				permittedTransitions: [
					{
						from: 'qmi',
						to: 'mbim',
						atCommand: 'AT+QCFG="usbnet",2',
						expectedResponse: 'OK',
						expectsPortDrop: true,
						expectedDescriptors: {
							deviceClass: 0,
							interfaces: [{ interfaceClass: 2, interfaceSubClass: 14, interfaceProtocol: 0 }],
						},
					},
				],
			},
		],
	};
}

function firstTransition(catalog: ReturnType<typeof validCatalog>): Record<string, unknown> {
	// biome-ignore lint/suspicious/noExplicitAny: test helper reaching into a plain fixture
	return (catalog as any).entries[0].permittedTransitions[0];
}

function firstEntry(catalog: ReturnType<typeof validCatalog>): Record<string, unknown> {
	// biome-ignore lint/suspicious/noExplicitAny: test helper reaching into a plain fixture
	return (catalog as any).entries[0];
}

describe('certified catalog schema — accepts valid data', () => {
	test('a well-formed catalog parses', () => {
		expect(certifiedCatalogSchema.safeParse(validCatalog()).success).toBe(true);
	});

	test('a router-ethernet SKU with NO transitions is valid', () => {
		const catalog = validCatalog() as { entries: Array<Record<string, unknown>> };
		catalog.entries[0] = {
			vidPid: '12d1:14db',
			model: 'HILINK-STICK',
			firmwarePrefix: 'HILINK',
			canonicalMode: 'router-ethernet',
			permittedTransitions: [],
		};
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(true);
	});
});

describe('certified catalog schema — rejects MM↔router transitions (schema-invalid)', () => {
	test('a transition TO router-ethernet fails to parse', () => {
		const catalog = validCatalog();
		firstTransition(catalog).to = 'router-ethernet';
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(false);
	});

	test('a transition FROM router-ethernet fails to parse', () => {
		const catalog = validCatalog();
		firstTransition(catalog).from = 'router-ethernet';
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(false);
	});

	test('a transition touching rndis fails to parse', () => {
		const catalog = validCatalog();
		firstTransition(catalog).to = 'rndis';
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(false);
	});

	test('a router-ethernet SKU may NOT declare any transition', () => {
		const catalog = validCatalog();
		firstEntry(catalog).canonicalMode = 'router-ethernet';
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(false);
	});
});

describe('certified catalog schema — strict mode rejects unknown fields', () => {
	test('an unknown field on the catalog root is rejected', () => {
		const catalog = validCatalog() as Record<string, unknown>;
		catalog.smuggled = true;
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(false);
	});

	test('an unknown field on an entry is rejected', () => {
		const catalog = validCatalog();
		firstEntry(catalog).hidden = 'x';
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(false);
	});

	test('an unknown field on a transition is rejected', () => {
		const catalog = validCatalog();
		firstTransition(catalog).sneaky = 1;
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(false);
	});
});

describe('certified catalog schema — field validation', () => {
	test('a self-transition (from === to) is rejected', () => {
		const catalog = validCatalog();
		firstTransition(catalog).to = 'qmi';
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(false);
	});

	test('a malformed VID:PID is rejected', () => {
		const catalog = validCatalog();
		firstEntry(catalog).vidPid = '2c7c-0125';
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(false);
	});

	test('a schemaVersion other than 1 is rejected', () => {
		const catalog = validCatalog() as Record<string, unknown>;
		catalog.schemaVersion = 2;
		expect(certifiedCatalogSchema.safeParse(catalog).success).toBe(false);
	});

	test('a valid evidence-bundle sha256 is accepted; a malformed one is rejected', () => {
		const good = validCatalog();
		firstTransition(good).evidenceBundleSha256 = 'a'.repeat(64);
		expect(certifiedCatalogSchema.safeParse(good).success).toBe(true);

		const bad = validCatalog();
		firstTransition(bad).evidenceBundleSha256 = 'nothex';
		expect(certifiedCatalogSchema.safeParse(bad).success).toBe(false);
	});

	test('loadCertifiedCatalog throws on invalid input', () => {
		expect(() => loadCertifiedCatalog({ schemaVersion: 1 })).toThrow();
	});

	test('a lone entry also validates against catalogEntrySchema', () => {
		const entry = (validCatalog() as { entries: unknown[] }).entries[0];
		expect(catalogEntrySchema.safeParse(entry).success).toBe(true);
	});
});

describe('the shipped certified catalog', () => {
	test('validates and exposes the synthetic test SKU with within-MM transitions', () => {
		const sku = {
			vidPid: '2c7c:0125',
			model: 'CERALIVE-SYNTHETIC-TEST-SKU',
			firmwarePrefix: 'SYNTHETICFW01',
		};
		const entry = findCatalogEntry(CERTIFIED_CATALOG, sku);
		expect(entry).toBeDefined();
		expect(entry?.canonicalMode).toBe('qmi');
		const transition =
			entry !== undefined ? findPermittedTransition(entry, 'qmi', 'mbim') : undefined;
		expect(transition?.atCommand).toBe('AT+QCFG="usbnet",2');
		// A transition the catalog does NOT declare is absent (never a guess).
		expect(
			entry !== undefined ? findPermittedTransition(entry, 'mbim', 'ecm-ncm') : undefined,
		).toBeUndefined();
	});

	test('an unmatched SKU discriminator returns undefined (uncertified)', () => {
		const entry = findCatalogEntry(CERTIFIED_CATALOG, {
			vidPid: '2c7c:0125',
			model: 'CERALIVE-SYNTHETIC-TEST-SKU',
			firmwarePrefix: 'WRONGFW',
		});
		expect(entry).toBeUndefined();
	});
});
