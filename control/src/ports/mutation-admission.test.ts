import { describe, expect, test } from 'bun:test';
import { physicalModemId } from '../domain';
import { acquireMutationAdmission, type MutationAdmissionPort } from './mutation-admission';

const modemId = physicalModemId('serial:admission-test');

describe('MutationAdmissionPort', () => {
	test('Given required admission and no port, When admission is requested, Then it is refused with a typed reason', async () => {
		const result = await acquireMutationAdmission(
			{
				operationId: 'set-radio-mode',
				physicalModemId: modemId,
				impact: 'disruptive',
				requirement: { required: true, reason: 'external controller approval is required' },
			},
			undefined,
		);

		expect(result).toEqual({ status: 'refused', reason: 'admission-port-missing' });
	});

	test('Given an injected refusing port, When admission is requested, Then its typed refusal is preserved', async () => {
		const port: MutationAdmissionPort = {
			acquire: () =>
				Promise.resolve({
					status: 'refused',
					reason: 'admission-refused',
					detail: 'controller lease unavailable',
				}),
		};

		const result = await acquireMutationAdmission(
			{
				operationId: 'set-radio-mode',
				physicalModemId: modemId,
				impact: 'write',
				requirement: { required: true, reason: 'controller approval' },
			},
			port,
		);

		expect(result).toEqual({
			status: 'refused',
			reason: 'admission-refused',
			detail: 'controller lease unavailable',
		});
	});

	test('Given admission is not required, When no port is injected, Then no synthetic lease is invented', async () => {
		const result = await acquireMutationAdmission(
			{
				operationId: 'read-signal',
				physicalModemId: modemId,
				impact: 'read',
				requirement: { required: false },
			},
			undefined,
		);

		expect(result).toEqual({ status: 'not-required' });
	});
});
