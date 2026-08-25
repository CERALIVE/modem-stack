import type { DbusTransport } from '../../transport';
import {
	DBUS_DESTINATION,
	DBUS_IFACE,
	DBUS_PATH,
	MM_BUS_NAME,
	MM_ROOT_PATH,
	OBJECT_MANAGER_IFACE,
} from '../constants';
import { asManagedObjects, type DecodedManagedObjects } from '../managed-objects';

export async function queryModemManagerOwner(
	transport: DbusTransport,
): Promise<string | undefined> {
	try {
		const reply = await transport.callMethod({
			destination: DBUS_DESTINATION,
			path: DBUS_PATH,
			interface: DBUS_IFACE,
			member: 'GetNameOwner',
			signature: 's',
			args: [MM_BUS_NAME],
		});
		const owner = reply.body[0];
		return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
	} catch {
		return undefined;
	}
}

export async function readAuthoritativeTree(
	transport: DbusTransport,
	destination: string,
): Promise<DecodedManagedObjects> {
	const reply = await transport.callMethod({
		destination,
		path: MM_ROOT_PATH,
		interface: OBJECT_MANAGER_IFACE,
		member: 'GetManagedObjects',
	});
	return asManagedObjects(reply.body[0]);
}
