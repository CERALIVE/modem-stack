// Walkers over a DECODED `GetManagedObjects` / `InterfacesAdded` tree.
//
// The transport decodes `a{oa{sa{sv}}}` into nested tuple arrays: a dict `a{sv}`
// becomes `[key, variant][]` and a variant becomes `{ signature, value }`. These
// accessors navigate that structure by object path and interface name. They live in
// `src` (not the A2.3 test fake's `tree.ts`) because the observer that ships must not
// import test-support — the published package would not contain it.

import type { DbusTransport, DbusValue, DbusVariant } from '../transport';
import { MM_ROOT_PATH, OBJECT_MANAGER_IFACE } from './constants';

/** One interface's property entries: `[propertyName, variant][]`. */
export type DecodedProps = ReadonlyArray<readonly [string, DbusVariant]>;
/** One object's interfaces: `[interfaceName, props][]`. */
export type DecodedInterfaces = ReadonlyArray<readonly [string, DecodedProps]>;
/** One managed object: `[objectPath, interfaces]`. */
export type DecodedObject = readonly [string, DecodedInterfaces];
/** The whole `a{oa{sa{sv}}}` payload. */
export type DecodedManagedObjects = readonly DecodedObject[];

/** Treat a `GetManagedObjects` reply body value as the decoded tree. */
export function asManagedObjects(value: DbusValue | undefined): DecodedManagedObjects {
	if (!Array.isArray(value)) {
		throw new TypeError('managed-objects payload is not an array');
	}
	return value as unknown as DecodedManagedObjects;
}

/** Call `ObjectManager.GetManagedObjects` on `destination` and decode the reply. */
export async function fetchManagedObjects(
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

/** Treat an `InterfacesAdded` body (`[path, interfaces]`) as one decoded object. */
export function asAddedObject(path: DbusValue, interfaces: DbusValue): DecodedObject {
	if (typeof path !== 'string' || !Array.isArray(interfaces)) {
		throw new TypeError('InterfacesAdded body is not [objectPath, interfaces]');
	}
	return [path, interfaces as unknown as DecodedInterfaces];
}

/** Every object path in the tree, in wire order. */
export function objectPaths(tree: DecodedManagedObjects): string[] {
	return tree.map(([path]) => path);
}

/** The object at `path`, or `undefined`. */
export function findObject(tree: DecodedManagedObjects, path: string): DecodedObject | undefined {
	return tree.find(([objectPath]) => objectPath === path);
}

/** The property entries of one interface on one object, or `undefined`. */
export function findInterface(
	tree: DecodedManagedObjects,
	path: string,
	iface: string,
): DecodedProps | undefined {
	return findObject(tree, path)?.[1].find(([name]) => name === iface)?.[1];
}

/** Object paths that carry a given interface. */
export function pathsWithInterface(tree: DecodedManagedObjects, iface: string): string[] {
	return tree
		.filter(([, interfaces]) => interfaces.some(([name]) => name === iface))
		.map(([path]) => path);
}

/** Whether an object exposes a given interface. */
export function hasInterface(tree: DecodedManagedObjects, path: string, iface: string): boolean {
	return findInterface(tree, path, iface) !== undefined;
}

/** The inner value of a property (a variant's `.value`), or `undefined`. */
export function propValue(props: DecodedProps | undefined, name: string): DbusValue | undefined {
	return props?.find(([key]) => key === name)?.[1]?.value;
}

/** A string-typed property, or `undefined` if absent / not a string. */
export function stringProp(props: DecodedProps | undefined, name: string): string | undefined {
	const value = propValue(props, name);
	return typeof value === 'string' ? value : undefined;
}

/** A number-typed property, or `undefined` if absent / not a number. */
export function numberProp(props: DecodedProps | undefined, name: string): number | undefined {
	const value = propValue(props, name);
	return typeof value === 'number' ? value : undefined;
}

/** Resolve an object-path property (e.g. a modem's `Sim`) to that object's props. */
export function followObjectPath(
	tree: DecodedManagedObjects,
	props: DecodedProps | undefined,
	propName: string,
	iface: string,
): DecodedProps | undefined {
	const target = propValue(props, propName);
	return typeof target === 'string' ? findInterface(tree, target, iface) : undefined;
}
