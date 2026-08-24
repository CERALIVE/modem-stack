import { describe, expect, test } from 'bun:test';
import { deviceGeneration, physicalModemId } from '../../domain';
import type { ProviderExecutionContext } from '../contracts';
import { createRuntimeCompositionOperation } from './runtime-composition-operation';

const CONTEXT: ProviderExecutionContext = {
	physicalModemId: physicalModemId('serial:runtime-composition-query-failure'),
	generation: deviceGeneration(7),
	transport: 'modemmanager',
	passiveFacts: [],
	composition: 'qmi',
	firmware: 'fixture',
	profile: 'generic-mm',
};

describe('runtime composition query failures', () => {
	test.each([
		{ name: 'both queries fail', currentOk: false, enumerationOk: false },
		{ name: 'the current query fails', currentOk: false, enumerationOk: true },
		{ name: 'the enumeration query fails', currentOk: true, enumerationOk: false },
	])('offers no transition when $name despite parseable response data', async (fixture) => {
		const transportCalls: string[] = [];
		const operation = createRuntimeCompositionOperation({
			vendor: () => 'fibocom',
			provisioningEnabled: () => true,
			blockedReason: () => undefined,
			atSender: {
				send: (command) => {
					transportCalls.push(command);
					const currentQuery = command === 'AT+GTUSBMODE?';
					const ok = currentQuery ? fixture.currentOk : fixture.enumerationOk;
					const data = currentQuery ? '+GTUSBMODE: 41' : '+GTUSBMODE: (40,41)';
					return Promise.resolve({ ok, raw: `${data}\r\n${ok ? 'OK' : 'ERROR'}` });
				},
			},
			transition: () => Promise.reject(new Error('query failure must suppress the transition')),
		});

		const state = await operation.capability(CONTEXT);

		expect(state).toEqual({
			status: 'suppressed',
			reason: 'no-return-path',
			detail: 'A runtime composition query failed',
			current: null,
			enumerated: [],
			offerable: [],
		});
		expect(transportCalls).toEqual(['AT+GTUSBMODE?', 'AT+GTUSBMODE=?']);
	});
});
