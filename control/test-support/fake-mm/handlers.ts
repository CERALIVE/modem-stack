// Method-call handler registration for the fake MM service.
//
// Registers the root `ObjectManager.GetManagedObjects` + `InhibitDevice` and every
// modem's methods on a `BusSession`. The bearer-creating methods (`Bearer.Connect`/
// `Disconnect`, `Modem.Simple.Connect`/`Disconnect`, `Modem.CreateBearer`) are
// TRIPWIRES: they call `ctx.tripwire`, which throws — proving the controller never
// activates a bearer through MM. The disruptive + SIM ops (`SetCurrentModes`,
// `SetPrimarySimSlot`, `Scan`, `SendPin`, `SendPuk`) are TRACED: they record a
// `member:start:<idx>` on entry and a `member:end:<idx>` after the reply delay, so a
// test can prove per-modem serialization (no interleave) from the call log. State the
// handlers need at call time is supplied by the service through `ctx`, so
// re-registering after a restart just points the same wiring at the new connection.

import type { BusSession } from './bus-session';
import {
	BEARER_IFACE,
	bearerPath,
	LOCATION_IFACE,
	type ManagedObjects,
	MESSAGING_IFACE,
	MM_MANAGER_IFACE,
	MODEM_IFACE,
	MODEM3GPP_IFACE,
	type ModemSpec,
	modemPath,
	OBJECT_MANAGER_IFACE,
	ROOT_PATH,
	SIGNAL_IFACE,
	SIM_IFACE,
	SIMPLE_IFACE,
	simPath,
	USSD_IFACE,
} from './object-model';

const MANAGED_OBJECTS_SIG = 'a{oa{sa{sv}}}';
const CELL_INFO_SIG = 'aa{sv}';

/** Live instance state a handler consults to answer a call. */
export interface HandlerContext {
	tree(): ManagedObjects;
	scanReply(modemIndex: number): unknown;
	cellInfo(modemIndex: number): unknown;
	submitPin(modemIndex: number, simObjectPath: string, pin: unknown): null;
	submitPuk(modemIndex: number, simObjectPath: string, puk: unknown, newPin: unknown): null;
	recordSignalSetup(modemIndex: number, rate: unknown): void;
	setupLocation(modemIndex: number, sources: unknown, signalLocation: unknown): null;
	locationReply(modemIndex: number): unknown;
	ussdReply(modemIndex: number, member: 'Initiate' | 'Respond'): string;
	ussdState(modemIndex: number): number;
	maybeFail(member: string, modemIndex: number): void;
	tripwire(iface: string, member: string): never;
	delay<T>(value: T): T | Promise<T>;
	/** Record a call-log event, then run `produce` after the reply delay. */
	traced<T>(member: string, modemIndex: number, produce: () => T): T | Promise<T>;
}

export function registerRoot(session: BusSession, ctx: HandlerContext): void {
	session.handle(
		ROOT_PATH,
		OBJECT_MANAGER_IFACE,
		'GetManagedObjects',
		() => ctx.delay(ctx.tree()),
		MANAGED_OBJECTS_SIG,
	);
	session.handle(ROOT_PATH, MM_MANAGER_IFACE, 'InhibitDevice', () => ctx.delay(null), '');
}

export function registerModemHandlers(
	session: BusSession,
	spec: ModemSpec,
	ctx: HandlerContext,
): void {
	const path = modemPath(spec.index);
	const i = spec.index;
	session.handle(
		path,
		MODEM_IFACE,
		'SetCurrentModes',
		() =>
			ctx.traced('SetCurrentModes', i, () => {
				ctx.maybeFail('SetCurrentModes', i);
				return null;
			}),
		'',
	);
	session.handle(
		path,
		MODEM_IFACE,
		'SetPrimarySimSlot',
		() => ctx.traced('SetPrimarySimSlot', i, () => null),
		'',
	);
	session.handle(path, MODEM_IFACE, 'GetCellInfo', () => ctx.delay(ctx.cellInfo(i)), CELL_INFO_SIG);
	session.handle(path, MODEM_IFACE, 'Command', () => ctx.delay('OK'), 's');
	session.handle(
		path,
		MODEM_IFACE,
		'CreateBearer',
		() => ctx.tripwire(MODEM_IFACE, 'CreateBearer'),
		'',
	);
	if (spec.hasSignal !== false) {
		session.handle(
			path,
			SIGNAL_IFACE,
			'Setup',
			(rate) => {
				ctx.recordSignalSetup(i, rate);
				return ctx.delay(null);
			},
			'',
		);
	}
	if (spec.location !== undefined) {
		session.handle(
			path,
			LOCATION_IFACE,
			'Setup',
			(sources, signalLocation) => ctx.setupLocation(i, sources, signalLocation),
			'',
		);
		session.handle(path, LOCATION_IFACE, 'GetLocation', () => ctx.locationReply(i), 'a{uv}');
	}
	if (spec.messaging === true) {
		session.handle(path, MESSAGING_IFACE, 'List', () => [], 'ao');
	}
	if (spec.ussd !== undefined) {
		session.handle(path, USSD_IFACE, 'Initiate', () => ctx.ussdReply(i, 'Initiate'), 's');
		session.handle(path, USSD_IFACE, 'Respond', () => ctx.ussdReply(i, 'Respond'), 's');
		session.handle(path, USSD_IFACE, 'Cancel', () => null, '');
		session.handle(
			path,
			'org.freedesktop.DBus.Properties',
			'Get',
			(iface, property) => {
				if (iface === USSD_IFACE && property === 'State') return ['u', ctx.ussdState(i)];
				return ['u', 0];
			},
			'v',
		);
	}
	session.handle(path, SIMPLE_IFACE, 'Connect', () => ctx.tripwire(SIMPLE_IFACE, 'Connect'), '');
	session.handle(
		path,
		SIMPLE_IFACE,
		'Disconnect',
		() => ctx.tripwire(SIMPLE_IFACE, 'Disconnect'),
		'',
	);
	session.handle(
		path,
		MODEM3GPP_IFACE,
		'Scan',
		() => ctx.traced('Scan', i, () => ctx.scanReply(i)),
		'aa{sv}',
	);
	session.handle(path, MODEM3GPP_IFACE, 'Register', () => ctx.delay(null), '');
	for (const sim of spec.sims) {
		const sp = simPath(sim.index);
		session.handle(
			sp,
			SIM_IFACE,
			'SendPin',
			(pin) => ctx.traced('SendPin', i, () => ctx.submitPin(i, sp, pin)),
			'',
		);
		session.handle(
			sp,
			SIM_IFACE,
			'SendPuk',
			(puk, newPin) => ctx.traced('SendPuk', i, () => ctx.submitPuk(i, sp, puk, newPin)),
			'',
		);
	}
	const bp = bearerPath(spec.bearerIndex ?? spec.index);
	session.handle(bp, BEARER_IFACE, 'Connect', () => ctx.tripwire(BEARER_IFACE, 'Connect'), '');
	session.handle(
		bp,
		BEARER_IFACE,
		'Disconnect',
		() => ctx.tripwire(BEARER_IFACE, 'Disconnect'),
		'',
	);
}
