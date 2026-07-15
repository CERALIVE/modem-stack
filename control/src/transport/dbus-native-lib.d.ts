// Ambient declarations for the deep library entry points the transport tests use to run
// an in-process, bus-free marshal/unmarshal round-trip. These are test-only reaches into
// `@httptoolkit/dbus-native` internals; the production transport never imports them.

declare module '@httptoolkit/dbus-native/lib/marshall' {
	const marshall: (signature: string, data: unknown[], offset?: number) => Buffer;
	export default marshall;
}

declare module '@httptoolkit/dbus-native/lib/dbus-buffer' {
	export default class DBusBuffer {
		constructor(
			buffer: Buffer,
			startPos?: number,
			options?: { ayBuffer?: boolean; ReturnLongjs?: boolean },
		);
		read(signature: string): unknown;
	}
}
