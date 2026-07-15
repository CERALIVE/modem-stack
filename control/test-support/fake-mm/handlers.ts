// Method-call handler registration for the fake MM service.
//
// Registers the root `ObjectManager.GetManagedObjects` and every modem's methods on a
// `BusSession`. The bearer-creating methods (`Bearer.Connect`/`Disconnect`,
// `Modem.Simple.Connect`/`Disconnect`, `Modem.CreateBearer`) are TRIPWIRES: they call
// `ctx.tripwire`, which throws — proving the controller never activates a bearer through
// MM. State the handlers need at call time is supplied by the service through `ctx`, so
// re-registering after a restart just points the same wiring at the new connection.

import type { BusSession } from './bus-session';
import {
	BEARER_IFACE,
	bearerPath,
	type ManagedObjects,
	MODEM_IFACE,
	MODEM3GPP_IFACE,
	type ModemSpec,
	modemPath,
	OBJECT_MANAGER_IFACE,
	ROOT_PATH,
	SIM_IFACE,
	SIMPLE_IFACE,
	simPath,
} from './object-model';

const MANAGED_OBJECTS_SIG = 'a{oa{sa{sv}}}';

/** Live instance state a handler consults to answer a call. */
export interface HandlerContext {
	tree(): ManagedObjects;
	scanReply(modemIndex: number): unknown;
	checkPin(simObjectPath: string, pin: unknown): null;
	tripwire(iface: string, member: string): never;
	delay<T>(value: T): T | Promise<T>;
}

export function registerRoot(session: BusSession, ctx: HandlerContext): void {
	session.handle(
		ROOT_PATH,
		OBJECT_MANAGER_IFACE,
		'GetManagedObjects',
		() => ctx.delay(ctx.tree()),
		MANAGED_OBJECTS_SIG,
	);
}

export function registerModemHandlers(
	session: BusSession,
	spec: ModemSpec,
	ctx: HandlerContext,
): void {
	const path = modemPath(spec.index);
	session.handle(path, MODEM_IFACE, 'SetCurrentModes', () => ctx.delay(null), '');
	session.handle(path, MODEM_IFACE, 'SetPrimarySimSlot', () => ctx.delay(null), '');
	session.handle(path, MODEM_IFACE, 'Command', () => ctx.delay('OK'), 's');
	session.handle(
		path,
		MODEM_IFACE,
		'CreateBearer',
		() => ctx.tripwire(MODEM_IFACE, 'CreateBearer'),
		'',
	);
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
		() => ctx.delay(ctx.scanReply(spec.index)),
		'aa{sv}',
	);
	session.handle(path, MODEM3GPP_IFACE, 'Register', () => ctx.delay(null), '');
	for (const sim of spec.sims) {
		const sp = simPath(sim.index);
		session.handle(sp, SIM_IFACE, 'SendPin', (pin) => ctx.delay(ctx.checkPin(sp, pin)), '');
		session.handle(sp, SIM_IFACE, 'SendPuk', () => ctx.delay(null), '');
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
