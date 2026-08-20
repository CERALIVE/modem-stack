import { afterEach, describe, expect, test } from 'bun:test';
import { FakeModemManager, type ModemSpec, modemPath } from '../../../test-support/fake-mm';
import {
	hasSessionBus,
	sessionBusAddress,
	warnSkippedWithoutBus,
} from '../../../test-support/session-bus';
import { deviceGeneration, physicalModemId, runtimePath } from '../../domain';
import { REDACTED, redact } from '../../redact';
import { createDbusTransport, type DbusTransport } from '../../transport';
import { createProviderMatcher } from '../matcher';
import { createProviderRegistry } from '../registry';
import { createModemManagerProvider, type ModemManagerProvider } from './provider';

warnSkippedWithoutBus('typed ModemManager provider');

const UNKNOWN_MODEM: ModemSpec = {
	index: 73,
	manufacturer: 'Future Radios Ltd',
	model: 'Uncatalogued-X1',
	revision: '99.0-new',
	signalQuality: 64,
	sims: [
		{
			index: 73,
			iccid: '8900000000000000073',
			imsi: '001010000000073',
			active: true,
			simType: 1,
		},
	],
};

const request = {
	physicalModemId: physicalModemId('serial:fake-device-73'),
	generation: deviceGeneration(1),
	transport: 'modemmanager' as const,
	passiveFacts: [],
	composition: 'future-unlisted-modem',
};

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('waitFor timed out');
		await Bun.sleep(5);
	}
}

describe.skipIf(!hasSessionBus())('ModemManagerProvider on the private session bus', () => {
	let fake: FakeModemManager;
	let transport: DbusTransport;
	let provider: ModemManagerProvider;

	afterEach(async () => {
		await provider.stop();
		await transport.disconnect();
		await fake.stop();
	});

	test('an unknown modem receives generic mode, signal, SIM, and power controls from runtime facts', async () => {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, modems: [UNKNOWN_MODEM] });
		transport = createDbusTransport({ busAddress });
		provider = createModemManagerProvider({ transport });

		const registry = createProviderRegistry();
		registry.register(provider.definition);
		const match = await createProviderMatcher(registry).match(request);
		expect(match).toMatchObject({
			status: 'selected',
			provider: 'modemmanager',
			profile: 'generic-mm',
		});

		const snapshot = await provider.readSnapshot({ ...request, profile: 'generic-mm' });
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.modemPath).toBe(modemPath(73));
		expect(snapshot.capabilities).toMatchObject({
			modeRead: true,
			signalRead: true,
			simRead: true,
			powerRead: true,
		});
		expect(snapshot.radio.current.allowed).toBe(7);
		expect(snapshot.signal.quality).toBe(64);
		expect(snapshot.sim).toMatchObject({ present: true, slotCount: 1 });
		expect(snapshot.power).toBe('on');
		expect(snapshot.observation.value?.hardware.label).toMatchObject({
			state: 'known',
			value: 'Uncatalogued-X1',
		});
	});

	test('ObjectManager signals drive provider lifecycle events without touching a bearer', async () => {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, modems: [UNKNOWN_MODEM] });
		transport = createDbusTransport({ busAddress });
		provider = createModemManagerProvider({ transport });
		const events: string[][] = [];
		provider.observe((list) => {
			events.push(list.rows.map((row) => String(row.identity.runtimePath)));
		});
		await provider.start();

		fake.addModem({
			index: 74,
			sims: [{ index: 74, iccid: '8900000000000000074', imsi: '001010000000074' }],
		});
		await waitFor(() => events.some((paths) => paths.includes(modemPath(74))));

		expect(events.some((paths) => paths.includes(modemPath(74)))).toBe(true);
		expect(fake.callLog.some((entry) => /Connect|CreateBearer|Disconnect/.test(entry))).toBe(false);
	});

	test('runtime absence refuses a generic read instead of consulting a model catalog', async () => {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({
			busAddress,
			modems: [{ ...UNKNOWN_MODEM, hasSignal: false }],
		});
		transport = createDbusTransport({ busAddress });
		provider = createModemManagerProvider({ transport });

		const controls = provider.definition.operations('generic-mm');
		const signal = await controls.signal.read({ ...request, profile: 'generic-mm' });
		expect(signal.status).toBe('applied');
		if (signal.status === 'applied') {
			expect(signal.value.extendedAvailable).toBe(false);
			expect(signal.value.quality).toBe(64);
		}
	});

	test('band reads remain generic while uncertified band writes are refused before dispatch', async () => {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({
			busAddress,
			modems: [{ ...UNKNOWN_MODEM, supportedBands: [33, 378], currentBands: [256] }],
		});
		transport = createDbusTransport({ busAddress });
		provider = createModemManagerProvider({ transport });
		const controls = provider.definition.operations('generic-mm');
		const context = { ...request, profile: 'generic-mm' };

		expect(await controls.bands.read(context)).toMatchObject({
			status: 'applied',
			value: { supported: ['eutran-3', 'ngran-78'], current: ['any'] },
		});
		expect(await controls.bands.write(context, ['eutran-3'])).toMatchObject({
			status: 'refused',
			reason: 'band-write-certification-required',
		});
		expect(fake.callLog.some((entry) => entry.includes('SetCurrentBands'))).toBe(false);
		expect(controls.fccCoverage('2c7c', '0801')).toBe('present');
	});

	test('the provider returns the existing location, SMS, and USSD adapters for the resolved modem', async () => {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, modems: [UNKNOWN_MODEM] });
		transport = createDbusTransport({ busAddress });
		provider = createModemManagerProvider({ transport });
		const controls = provider.definition.operations('generic-mm');
		const context = { ...request, profile: 'generic-mm' };

		expect((await controls.location.status(context)).ok).toBe(false);
		expect((await controls.sms(context)).ok).toBe(false);
		expect(controls.ussd.snapshot(runtimePath(modemPath(73))).state).toBe('idle');
	});

	test('GPS capability, enable, bounded no-fix, disable, and signal-location privacy use the existing location module', async () => {
		let now = 1_000;
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({
			busAddress,
			modems: [
				{
					...UNKNOWN_MODEM,
					location: { capabilities: 7, enabled: 1, fix: [] },
					messaging: true,
					ussd: { state: 1, initiateReply: 'private balance' },
				},
			],
		});
		transport = createDbusTransport({ busAddress });
		provider = createModemManagerProvider({ transport, now: () => now });
		const controls = provider.definition.operations('generic-mm');
		const context = { ...request, profile: 'generic-mm' };

		const status = await controls.location.status(context);
		expect(status.ok && status.status.gnssCapable).toBe(true);
		expect((await controls.location.enable(context, ['gps-raw'])).outcome).toBe('applied');
		const enableCalls = fake.locationSetupCalls;
		expect(enableCalls[enableCalls.length - 1]).toMatchObject({
			signalLocation: false,
			sources: 3,
		});
		expect((await controls.location.readFix(context)).outcome).toBe('no-fix');
		expect(controls.location.state(context).kind).toBe('acquiring');

		now += 120_001;
		expect(controls.location.tick(context)).toMatchObject({
			kind: 'no-fix',
			reason: 'acquire-timeout',
		});
		expect((await controls.location.disable(context)).outcome).toBe('applied');
		expect(controls.location.state(context).kind).toBe('off');
		const disableCalls = fake.locationSetupCalls;
		expect(disableCalls[disableCalls.length - 1]).toMatchObject({
			signalLocation: false,
			sources: 1,
		});

		const sms = await controls.sms(context);
		expect(sms.ok && (await sms.port.list())).toEqual({ ok: true, messages: [] });
		expect((await controls.initiateUssd(context, '*123#')).ussdReply).toBe('private balance');
	});

	test('a live GPS fix expires in memory and is redacted by the existing privacy class', async () => {
		let now = 10_000;
		const rawFix = [
			[
				2,
				[
					'a{sv}',
					[
						['latitude', ['d', 4.60971]],
						['longitude', ['d', -74.08175]],
						['altitude', ['d', 2640]],
					],
				],
			],
		];
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({
			busAddress,
			modems: [{ ...UNKNOWN_MODEM, location: { capabilities: 6, enabled: 2, fix: rawFix } }],
		});
		transport = createDbusTransport({ busAddress });
		provider = createModemManagerProvider({ transport, now: () => now });
		const controls = provider.definition.operations('generic-mm');
		const context = { ...request, profile: 'generic-mm' };

		const read = await controls.location.readFix(context);
		expect(read.outcome).toBe('fix');
		if (read.outcome !== 'fix') return;
		expect(redact({ coordinates: read.fix })).toEqual({ coordinates: REDACTED });
		expect(controls.location.state(context).kind).toBe('fix');
		now += 30_001;
		expect(controls.location.tick(context)).toMatchObject({
			kind: 'no-fix',
			reason: 'fix-expired',
		});
	});

	test('a typed Core.Unauthorized fake-MM error maps to the exact domain refusal', async () => {
		const busAddress = sessionBusAddress();
		fake = await FakeModemManager.start({ busAddress, modems: [UNKNOWN_MODEM] });
		transport = createDbusTransport({ busAddress });
		provider = createModemManagerProvider({ transport });
		fake.failNext('SetCurrentModes', 'org.freedesktop.ModemManager1.Error.Core.Unauthorized');
		const controls = provider.definition.operations('generic-mm');

		const result = await controls.radio.write(
			{ ...request, profile: 'generic-mm' },
			{ preferenceOrdered: ['lte'] },
		);
		expect(result).toMatchObject({ status: 'refused', reason: 'unauthorized' });
	});
});
