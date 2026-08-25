import type { DbusTransport, SignalEvent, Subscription } from '../../transport';
import { DBUS_IFACE, MM_ROOT_PATH, OBJECT_MANAGER_IFACE, PROPERTIES_IFACE } from '../constants';

export interface ObserverSignalHandlers {
	readonly onObjectSignal: (event: SignalEvent) => void;
	readonly onNameOwnerChanged: (event: SignalEvent) => void;
}

export async function subscribeObserverSignals(
	transport: DbusTransport,
	handlers: ObserverSignalHandlers,
): Promise<readonly Subscription[]> {
	const objectManager = { interface: OBJECT_MANAGER_IFACE, path: MM_ROOT_PATH } as const;
	const interfacesAdded = await transport.subscribeSignal(
		{ ...objectManager, member: 'InterfacesAdded' },
		handlers.onObjectSignal,
	);
	const interfacesRemoved = await transport.subscribeSignal(
		{ ...objectManager, member: 'InterfacesRemoved' },
		handlers.onObjectSignal,
	);
	const propertiesChanged = await transport.subscribeSignal(
		{ interface: PROPERTIES_IFACE, member: 'PropertiesChanged' },
		handlers.onObjectSignal,
	);
	const nameOwnerChanged = await transport.subscribeSignal(
		{ interface: DBUS_IFACE, member: 'NameOwnerChanged' },
		handlers.onNameOwnerChanged,
	);
	return [interfacesAdded, interfacesRemoved, propertiesChanged, nameOwnerChanged];
}

export async function unsubscribeObserverSignals(
	subscriptions: readonly Subscription[],
): Promise<void> {
	await Promise.all(
		subscriptions.map((subscription) => subscription.unsubscribe().catch(() => undefined)),
	);
}
