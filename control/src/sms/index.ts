// The read-only SMS surface: normalization, the `mmcli -K` grammar, the
// Added/Deleted fold, and the ModemManager Messaging adapter.
//
// LIST / READ and observation ONLY. Nothing exported here composes, stores,
// sends, or deletes a message; `readonly-gate.test.ts` fails the build if that
// ever stops being true.

export * from './dbus-messaging';
export * from './inbox-store';
export * from './mmcli-parse';
export * from './normalize';
