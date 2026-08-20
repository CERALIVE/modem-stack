// Well-known D-Bus names the ModemManager observer talks to.
//
// These mirror the real ModemManager bus topology. They are duplicated here (rather
// than imported from the A2.3 test fake) on purpose: `control/test-support/` is not
// published in the npm package, so `src` must never depend on it — the observer that
// SHIPS owns its own copy of the constants it needs.

/** The well-known bus name ModemManager owns. */
export const MM_BUS_NAME = 'org.freedesktop.ModemManager1';

/** The root ObjectManager object path. */
export const MM_ROOT_PATH = '/org/freedesktop/ModemManager1';

/** `org.freedesktop.DBus.ObjectManager` — `GetManagedObjects`, `InterfacesAdded/Removed`. */
export const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';

/** `org.freedesktop.DBus.Properties` — `PropertiesChanged`. */
export const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

/** The root manager interface — `InhibitDevice`, `ScanDevices`, `Version`. */
export const MM_MANAGER_IFACE = 'org.freedesktop.ModemManager1';

/** The core `Modem` interface. */
export const MODEM_IFACE = 'org.freedesktop.ModemManager1.Modem';

/** The separate `Modem.Modem3gpp` interface (never merged into `Modem`). */
export const MODEM3GPP_IFACE = 'org.freedesktop.ModemManager1.Modem.Modem3gpp';

/** `Modem.Modem3gpp.Ussd` — a SEPARATE interface a modem may omit entirely. */
export const MODEM3GPP_USSD_IFACE = `${MODEM3GPP_IFACE}.Ussd`;

/** The `Modem.Location` interface — GNSS capabilities, `Setup`, `GetLocation`. */
export const MODEM_LOCATION_IFACE = 'org.freedesktop.ModemManager1.Modem.Location';

/** A SIM object's `Sim` interface (SIMs are separate `/SIM/<n>` objects). */
export const SIM_IFACE = 'org.freedesktop.ModemManager1.Sim';

/** The bus daemon itself — `NameOwnerChanged`, `GetNameOwner`. */
export const DBUS_IFACE = 'org.freedesktop.DBus';
export const DBUS_PATH = '/org/freedesktop/DBus';
export const DBUS_DESTINATION = 'org.freedesktop.DBus';
