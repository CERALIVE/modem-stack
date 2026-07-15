#!/usr/bin/env python3
"""Independent D-Bus producer for transport conformance half (b).

A different implementation on the wire than the JavaScript library under test: this uses
the `dbus-python` bindings (`python3-dbus`) plus a GLib main loop. If our TypeScript codec
agrees with THIS producer as well as with the same-library fake, the codec is correct, not
merely self-consistent.

It exercises the shapes the plan calls out: the real ModemManager `GetManagedObjects`
shape `a{oa{sa{sv}}}`, 64-bit `x`/`t` values above 2**53, variants, and a
`PropertiesChanged` signal that carries an invalidated-properties array (not just changed
values).

Connects to the bus named by `DBUS_SESSION_BUS_ADDRESS` (set by `dbus-run-session`),
claims a well-known name, prints `READY` on stdout once serving, then runs the main loop.
"""

import sys

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BUS_NAME = "tv.ceralive.ModemStackPy"
OBJECT_PATH = "/tv/ceralive/pyfake"
IFACE = "tv.ceralive.ModemStackPy.Conformance"
PROPERTIES_IFACE = "org.freedesktop.DBus.Properties"

INT64_MAX = 2**63 - 1
UINT64_MAX = 2**64 - 1


class ConformanceProducer(dbus.service.Object):
    @dbus.service.method(IFACE, in_signature="", out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        return dbus.Dictionary(
            {
                dbus.ObjectPath("/org/freedesktop/ModemManager1/Modem/0"): dbus.Dictionary(
                    {
                        "org.freedesktop.ModemManager1.Modem": dbus.Dictionary(
                            {
                                "SupportedCapabilities": dbus.UInt64(UINT64_MAX, variant_level=1),
                                "MaxBearers": dbus.Int64(-INT64_MAX, variant_level=1),
                                "SignalQuality": dbus.UInt32(87, variant_level=1),
                                "DeviceIdentifier": dbus.String("py-device-0", variant_level=1),
                            },
                            signature="sv",
                        ),
                    },
                    signature="sa{sv}",
                ),
            },
            signature="oa{sa{sv}}",
        )

    @dbus.service.method(IFACE, in_signature="", out_signature="x")
    def GetInt64(self):
        return dbus.Int64(INT64_MAX)

    @dbus.service.method(IFACE, in_signature="", out_signature="t")
    def GetUint64(self):
        return dbus.UInt64(UINT64_MAX)

    @dbus.service.method(IFACE, in_signature="", out_signature="v")
    def GetVariant(self):
        return dbus.UInt64(UINT64_MAX, variant_level=1)

    @dbus.service.method(IFACE, in_signature="x", out_signature="x")
    def EchoInt64(self, value):
        return dbus.Int64(value)

    @dbus.service.method(IFACE, in_signature="t", out_signature="t")
    def EchoUint64(self, value):
        return dbus.UInt64(value)

    @dbus.service.method(IFACE, in_signature="t", out_signature="s")
    def DescribeUint64(self, value):
        return dbus.String(str(int(value)))

    @dbus.service.method(IFACE, in_signature="", out_signature="")
    def TriggerPropertiesChanged(self):
        changed = dbus.Dictionary(
            {
                "AccessTechnologies": dbus.UInt64(UINT64_MAX, variant_level=1),
                "SignalQuality": dbus.UInt32(42, variant_level=1),
            },
            signature="sv",
        )
        invalidated = dbus.Array(["OperatorName", "OperatorCode"], signature="s")
        self.PropertiesChanged(IFACE, changed, invalidated)

    @dbus.service.signal(PROPERTIES_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface_name, changed_properties, invalidated_properties):
        pass


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    name = dbus.service.BusName(BUS_NAME, bus)
    ConformanceProducer(bus, OBJECT_PATH)
    # Signal readiness only after the name is owned and the object is exported.
    sys.stdout.write("READY\n")
    sys.stdout.flush()
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
