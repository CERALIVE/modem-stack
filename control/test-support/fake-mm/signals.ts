// The ObjectManager / Properties signal emitters, in `@httptoolkit/dbus-native` encode
// form. `InterfacesAdded` (`oa{sa{sv}}`) and `InterfacesRemoved` (`oas`) come from the
// root ObjectManager path; `PropertiesChanged` (`sa{sv}as`) comes from the object whose
// properties changed. An invalidated-only change is an empty `changed` dict with the
// names in `invalidated` — the real MM semantics the observer must handle.

import type { BusSession } from './bus-session';
import {
	type ManagedObject,
	OBJECT_MANAGER_IFACE,
	type PropEntry,
	ROOT_PATH,
} from './object-model';

const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

export function emitInterfacesAdded(session: BusSession, object: ManagedObject): void {
	session.emit(ROOT_PATH, OBJECT_MANAGER_IFACE, 'InterfacesAdded', 'oa{sa{sv}}', [
		object[0],
		object[1],
	]);
}

export function emitInterfacesRemoved(
	session: BusSession,
	path: string,
	interfaces: readonly string[],
): void {
	session.emit(ROOT_PATH, OBJECT_MANAGER_IFACE, 'InterfacesRemoved', 'oas', [path, interfaces]);
}

export function emitPropertiesChanged(
	session: BusSession,
	path: string,
	iface: string,
	changed: readonly PropEntry[],
	invalidated: readonly string[],
): void {
	session.emit(path, PROPERTIES_IFACE, 'PropertiesChanged', 'sa{sv}as', [
		iface,
		changed,
		invalidated,
	]);
}
