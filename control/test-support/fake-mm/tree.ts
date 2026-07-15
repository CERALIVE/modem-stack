// Helpers for walking a DECODED managed-objects tree — the shape the transport hands
// back from `ObjectManager.GetManagedObjects` (and, per-entry, from `InterfacesAdded`).
//
// A dict `a{sv}` decodes to an array of `[key, variant]` entries and a variant to
// `{ signature, value }`, so the whole `a{oa{sa{sv}}}` payload is nested tuple arrays.
// These accessors let a test (and, later, the A3.x observer) navigate that structure
// by object path and interface name without re-implementing the same lookups.

import type { DbusTransport, DbusValue, DbusVariant } from '../../src/transport';
import { OBJECT_MANAGER_IFACE, ROOT_PATH } from './object-model';

export type DecodedProps = ReadonlyArray<readonly [string, DbusVariant]>;
export type DecodedInterfaces = ReadonlyArray<readonly [string, DecodedProps]>;
export type DecodedObject = readonly [string, DecodedInterfaces];
export type DecodedManagedObjects = readonly DecodedObject[];

/** Treat a `GetManagedObjects` reply body value as the decoded tree. */
export function asManagedObjects(value: DbusValue | undefined): DecodedManagedObjects {
	if (!Array.isArray(value)) {
		throw new TypeError('managed-objects payload is not an array');
	}
	return value as unknown as DecodedManagedObjects;
}

/** Call `ObjectManager.GetManagedObjects` on `destination` and return the decoded tree. */
export async function fetchManagedObjects(
	transport: DbusTransport,
	destination: string,
): Promise<DecodedManagedObjects> {
	const reply = await transport.callMethod({
		destination,
		path: ROOT_PATH,
		interface: OBJECT_MANAGER_IFACE,
		member: 'GetManagedObjects',
	});
	return asManagedObjects(reply.body[0]);
}

/** Every object path in the tree, in wire order. */
export function objectPaths(tree: DecodedManagedObjects): string[] {
	return tree.map(([path]) => path);
}

/** The object at `path`, or `undefined` if absent. */
export function findObject(tree: DecodedManagedObjects, path: string): DecodedObject | undefined {
	return tree.find(([objectPath]) => objectPath === path);
}

/** The interface names an object exposes — the proof that `Modem` and `Modem3gpp`
 *  are SEPARATE keys, never merged. */
export function interfaceNames(tree: DecodedManagedObjects, path: string): string[] {
	const object = findObject(tree, path);
	return object ? object[1].map(([name]) => name) : [];
}

/** The property entries of one interface on one object, or `undefined`. */
export function findInterface(
	tree: DecodedManagedObjects,
	path: string,
	iface: string,
): DecodedProps | undefined {
	const object = findObject(tree, path);
	return object?.[1].find(([name]) => name === iface)?.[1];
}

/** Whether an object exposes an interface. */
export function hasInterface(tree: DecodedManagedObjects, path: string, iface: string): boolean {
	return findInterface(tree, path, iface) !== undefined;
}

/** The inner value of a property (a variant's `.value`), or `undefined`. */
export function propValue(props: DecodedProps | undefined, name: string): DbusValue | undefined {
	return props?.find(([key]) => key === name)?.[1]?.value;
}

/** Object paths that carry a given interface. */
export function pathsWithInterface(tree: DecodedManagedObjects, iface: string): string[] {
	return tree
		.filter(([, interfaces]) => interfaces.some(([name]) => name === iface))
		.map(([path]) => path);
}

/** Read an object-path property (e.g. a modem's `Sim`) and resolve that object. */
export function followObjectPath(
	tree: DecodedManagedObjects,
	props: DecodedProps | undefined,
	propName: string,
): DecodedObject | undefined {
	const target = propValue(props, propName);
	return typeof target === 'string' ? findObject(tree, target) : undefined;
}
