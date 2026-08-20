import { describe, expect, test } from 'bun:test';
import { classifyShadowDivergences, foldGenerations, foldSignalBucket } from './shadow-divergence';

describe('shadow divergence', () => {
	test('compares only mutually reported fields', () => {
		expect(
			classifyShadowDivergences(
				[{ deviceKey: 'd-a', present: true, operatorName: 'Carrier' }],
				[{ deviceKey: 'd-a', present: true }],
			),
		).toEqual([]);
	});

	test('reports roster and field mismatches', () => {
		const result = classifyShadowDivergences(
			[
				{ deviceKey: 'd-a', present: true, networkType: '5G' },
				{ deviceKey: 'd-b', present: true },
			],
			[
				{ deviceKey: 'd-a', present: true, networkType: '4G' },
				{ deviceKey: 'd-c', present: true },
			],
		);
		expect(result.map((entry) => entry.kind)).toEqual([
			'field-mismatch',
			'only-in-mmcli',
			'only-in-dbus',
		]);
	});

	test('folds generation and signal vocabularies', () => {
		expect(foldGenerations(['lte', '5gnr'])).toBe('5G');
		expect(foldSignalBucket(74)).toBe('good');
	});
});
