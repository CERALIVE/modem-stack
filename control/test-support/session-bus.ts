// Graceful skip for the D-Bus harness when there is no session bus.
//
// Every test that spins the fake service needs a real session bus, which the suite
// gets from `dbus-run-session -- bun test control/test-support`. Without it there is
// nothing to talk to, so those tests SKIP rather than fail — but LOUDLY: a single
// `console.warn` names exactly what is missing and how to run them, so a skip is never
// mistaken for a pass. `describe.skipIf(!hasSessionBus())` gates each suite.

/** True when a D-Bus session bus is reachable (set by `dbus-run-session`). */
export function hasSessionBus(): boolean {
	return Boolean(process.env.DBUS_SESSION_BUS_ADDRESS);
}

/** The encoded session-bus address, asserted present — call only inside a gated suite. */
export function sessionBusAddress(): string {
	const address = process.env.DBUS_SESSION_BUS_ADDRESS;
	if (!address) {
		throw new Error('DBUS_SESSION_BUS_ADDRESS is not set — run under dbus-run-session');
	}
	return address;
}

let warned = false;

/** Emit a one-time, loud annotation explaining why bus-dependent suites are skipped. */
export function warnSkippedWithoutBus(context: string): void {
	if (hasSessionBus() || warned) {
		return;
	}
	warned = true;
	console.warn(
		`[test-support] SKIPPING ${context}: no DBUS_SESSION_BUS_ADDRESS. ` +
			'Run `dbus-run-session -- bun test control/test-support` to exercise the fake D-Bus service.',
	);
}
