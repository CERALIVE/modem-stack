// The ModemManager USSD adapter, driven over a fake bus.
//
// Two properties are proved here that the pure machine cannot prove on its own:
// a REFUSED verb dispatches ZERO D-Bus calls (a doomed request must not disturb a
// live session, and must not cost a network round-trip), and an unanswered
// session closes at its bound AND best-effort releases the network's side.

import { expect, test } from 'bun:test';
import { MODEM_IFACE, MODEM3GPP_IFACE, MODEM3GPP_USSD_IFACE } from '../backend/constants';
import { ModemActor } from '../backend/modem-actor';
import { runtimePath } from '../domain';
import { REDACTED, redact } from '../redact';
import type { DbusTransport, MethodCall, MethodReply } from '../transport';
import { USSD_STATE_ACTIVE, USSD_STATE_IDLE, USSD_STATE_USER_RESPONSE } from './calls';
import { MmUssd, type UssdScheduler } from './mm-ussd';

const MODEM_PATH = '/org/freedesktop/ModemManager1/Modem/0';
const MODEM = runtimePath(MODEM_PATH);
const STABLE_KEY = 'platform-xhci-hcd.0.auto-usb-0:1.4.4';
const BALANCE_REPLY = 'Your balance is $4.20. Ref 998877';

const LTE_BIT = 1 << 14;
const UMTS_BIT = 1 << 5;

interface BusOptions {
	/** Value returned by `Initiate`/`Respond`, or an error to throw. */
	readonly reply?: string | Error;
	/** MM's post-call `Ussd.State`. */
	readonly ussdState?: number;
	readonly registrationState?: number;
	readonly accessTechnologies?: number;
	readonly cancelThrows?: boolean;
}

interface FakeBus {
	readonly transport: DbusTransport;
	readonly calls: MethodCall[];
	members(): string[];
}

function fakeBus(options: BusOptions = {}): FakeBus {
	const calls: MethodCall[] = [];
	const managedObjects = [
		[
			MODEM_PATH,
			[
				[
					MODEM_IFACE,
					[['AccessTechnologies', { signature: 'u', value: options.accessTechnologies ?? 0 }]],
				],
				[
					MODEM3GPP_IFACE,
					[['RegistrationState', { signature: 'u', value: options.registrationState ?? 1 }]],
				],
			],
		],
	];

	const transport = {
		connect: () => Promise.resolve(),
		disconnect: () => Promise.resolve(),
		isConnected: () => true,
		subscribeSignal: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
		on: () => undefined,
		off: () => undefined,
		subscriptionCount: () => 0,
		callMethod(call: MethodCall): Promise<MethodReply> {
			calls.push(call);
			if (call.member === 'GetManagedObjects') {
				return Promise.resolve({
					signature: 'a{oa{sa{sv}}}',
					body: [managedObjects],
				} as unknown as MethodReply);
			}
			if (call.member === 'Get') {
				return Promise.resolve({
					signature: 'v',
					body: [{ signature: 'u', value: options.ussdState ?? USSD_STATE_IDLE }],
				} as unknown as MethodReply);
			}
			if (call.member === 'Cancel') {
				return options.cancelThrows
					? Promise.reject(new Error('modem is not answering'))
					: Promise.resolve({ signature: '', body: [] });
			}
			const reply = options.reply ?? '';
			return reply instanceof Error
				? Promise.reject(reply)
				: Promise.resolve({ signature: 's', body: [reply] } as unknown as MethodReply);
		},
	} as unknown as DbusTransport;

	return {
		transport,
		calls,
		members: () => calls.map((call) => call.member),
	};
}

/** A scheduler that fires nothing until the test asks it to. */
function manualScheduler(): { scheduler: UssdScheduler; fire(): Promise<void> } {
	let pending: (() => void) | undefined;
	return {
		scheduler: (_delayMs, run) => {
			pending = run;
			return {
				cancel: () => {
					pending = undefined;
				},
			};
		},
		fire: async () => {
			pending?.();
			pending = undefined;
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

function build(bus: FakeBus, extra: Partial<ConstructorParameters<typeof MmUssd>[0]> = {}): MmUssd {
	return new MmUssd({
		transport: bus.transport,
		actor: new ModemActor(),
		resolveStableKey: () => STABLE_KEY,
		...extra,
	});
}

function dbusError(name: string): Error {
	const error = new Error('operation failed');
	error.name = name;
	return error;
}

test('an initiate that the network answers with a question opens the dialogue', async () => {
	const bus = fakeBus({ reply: BALANCE_REPLY, ussdState: USSD_STATE_USER_RESPONSE });
	const ussd = build(bus);

	const result = await ussd.initiate(MODEM, '*123#');

	expect(result.ok).toBe(true);
	expect(result.snapshot.state).toBe('awaiting-reply');
	expect(result.ussdReply).toBe(BALANCE_REPLY);
	expect(bus.calls[0]?.interface).toBe(MODEM3GPP_USSD_IFACE);
	expect(bus.calls[0]?.member).toBe('Initiate');
	expect(bus.calls[0]?.args).toEqual(['*123#']);
	ussd.stop();
});

test('an initiate the network releases completes the session in one shot', async () => {
	const bus = fakeBus({ reply: BALANCE_REPLY, ussdState: USSD_STATE_IDLE });
	const ussd = build(bus);

	const result = await ussd.initiate(MODEM, '*123#');

	expect(result.ok).toBe(true);
	expect(result.snapshot).toEqual({ state: 'closed', outcome: 'completed' });
	expect(result.ussdReply).toBe(BALANCE_REPLY);
	// The stored state resets, so the very next dialogue is admitted.
	expect(ussd.snapshot(MODEM).state).toBe('idle');
	ussd.stop();
});

test('a session the network holds open with nothing pending is `active`', async () => {
	const bus = fakeBus({ reply: 'Request accepted', ussdState: USSD_STATE_ACTIVE });
	const ussd = build(bus);

	const result = await ussd.initiate(MODEM, '*111#');

	expect(result.snapshot.state).toBe('active');
	expect(ussd.snapshot(MODEM).state).toBe('active');
	ussd.stop();
});

test('responding to a prompt continues the dialogue', async () => {
	const bus = fakeBus({ reply: 'Choose: 1) Data 2) Voice', ussdState: USSD_STATE_USER_RESPONSE });
	const ussd = build(bus);
	await ussd.initiate(MODEM, '*123#');

	const result = await ussd.respond(MODEM, '1');

	expect(result.ok).toBe(true);
	expect(result.snapshot.state).toBe('awaiting-reply');
	expect(bus.members()).toContain('Respond');
	expect(bus.calls.find((call) => call.member === 'Respond')?.args).toEqual(['1']);
	ussd.stop();
});

test('cancelling mid-dialogue closes the session and dispatches Cancel', async () => {
	const bus = fakeBus({ reply: 'Menu', ussdState: USSD_STATE_USER_RESPONSE });
	const ussd = build(bus);
	await ussd.initiate(MODEM, '*123#');

	const result = await ussd.cancel(MODEM);

	expect(result.ok).toBe(true);
	expect(result.snapshot).toEqual({ state: 'closed', outcome: 'cancelled' });
	expect(bus.members()).toContain('Cancel');
	expect(ussd.snapshot(MODEM).state).toBe('idle');
	ussd.stop();
});

test('an unanswered session closes at the bound and releases the network side', async () => {
	const bus = fakeBus({ reply: 'Menu', ussdState: USSD_STATE_USER_RESPONSE });
	const timer = manualScheduler();
	const seen: string[] = [];
	const ussd = build(bus, {
		scheduler: timer.scheduler,
		onSessionChange: (_key, snapshot) => seen.push(snapshot.state),
	});
	await ussd.initiate(MODEM, '*123#');
	expect(bus.members()).not.toContain('Cancel');

	await timer.fire();

	expect(ussd.snapshot(MODEM).state).toBe('idle');
	expect(seen.at(-1)).toBe('closed');
	expect(bus.members()).toContain('Cancel');
	ussd.stop();
});

test('a bound that fires while the modem is unreachable still closes the session', async () => {
	const bus = fakeBus({
		reply: 'Menu',
		ussdState: USSD_STATE_USER_RESPONSE,
		cancelThrows: true,
	});
	const timer = manualScheduler();
	const ussd = build(bus, { scheduler: timer.scheduler });
	await ussd.initiate(MODEM, '*123#');

	await timer.fire();

	expect(ussd.snapshot(MODEM).state).toBe('idle');
	ussd.stop();
});

test('an LTE-only carrier rejection is surfaced as its own typed refusal', async () => {
	const bus = fakeBus({
		reply: dbusError('org.freedesktop.ModemManager1.Error.Core.Unsupported'),
		registrationState: 1,
		accessTechnologies: LTE_BIT,
	});
	const ussd = build(bus);

	const result = await ussd.initiate(MODEM, '*123#');

	expect(result.ok).toBe(false);
	expect(result.refusal).toBe('lte-only-unsupported');
	expect(result.snapshot).toEqual({
		state: 'closed',
		outcome: 'failed',
		refusal: 'lte-only-unsupported',
	});
	ussd.stop();
});

test('the same rejection on a CS-capable registration reports a device limit', async () => {
	const bus = fakeBus({
		reply: dbusError('org.freedesktop.ModemManager1.Error.Core.Unsupported'),
		registrationState: 1,
		accessTechnologies: UMTS_BIT,
	});
	const ussd = build(bus);

	const result = await ussd.initiate(MODEM, '*123#');

	expect(result.refusal).toBe('unsupported');
	ussd.stop();
});

test('a second initiate is refused busy and dispatches ZERO calls', async () => {
	const bus = fakeBus({ reply: 'Menu', ussdState: USSD_STATE_USER_RESPONSE });
	const ussd = build(bus);
	await ussd.initiate(MODEM, '*123#');
	const before = bus.calls.length;

	const result = await ussd.initiate(MODEM, '*100#');

	expect(result.ok).toBe(false);
	expect(result.refusal).toBe('session-busy');
	expect(result.snapshot.state).toBe('awaiting-reply');
	expect(bus.calls.length).toBe(before);
	ussd.stop();
});

test('respond and cancel with no session are refused, and dispatch ZERO calls', async () => {
	const bus = fakeBus();
	const ussd = build(bus);

	const responded = await ussd.respond(MODEM, '1');
	const cancelled = await ussd.cancel(MODEM);

	expect(responded.refusal).toBe('invalid-state');
	expect(cancelled.refusal).toBe('no-session');
	expect(bus.calls).toHaveLength(0);
	ussd.stop();
});

test('a modem that never answered a session can start a new one', async () => {
	const bus = fakeBus({
		reply: dbusError('org.freedesktop.ModemManager1.Error.Core.Failed'),
	});
	const ussd = build(bus);
	await ussd.initiate(MODEM, '*123#');

	const second = await ussd.initiate(MODEM, '*123#');

	// Failed is terminal for the SESSION, never for the modem.
	expect(second.refusal).not.toBe('session-busy');
	ussd.stop();
});

test('the carrier reply is masked by the shared redactor wherever it is serialized', async () => {
	const bus = fakeBus({ reply: BALANCE_REPLY, ussdState: USSD_STATE_USER_RESPONSE });
	const ussd = build(bus);

	const result = await ussd.initiate(MODEM, '*123*9911#');
	const serialized = JSON.stringify(redact({ result, request: { ussdCommand: '*123*9911#' } }));

	expect(serialized).not.toContain(BALANCE_REPLY);
	expect(serialized).not.toContain('9911');
	expect(serialized).toContain(REDACTED);
	// The non-secret half of the same object survives, so this is redaction and
	// not a blanket drop.
	expect(serialized).toContain('awaiting-reply');
	ussd.stop();
});

test('stop() drops the pending bound without cancelling the modem session', async () => {
	const bus = fakeBus({ reply: 'Menu', ussdState: USSD_STATE_USER_RESPONSE });
	const timer = manualScheduler();
	const ussd = build(bus, { scheduler: timer.scheduler });
	await ussd.initiate(MODEM, '*123#');

	ussd.stop();
	await timer.fire();

	expect(bus.members()).not.toContain('Cancel');
});
