/** One USB interface's descriptor bytes plus its bound kernel driver, if any. */
export interface UsbInterface {
	readonly interfaceClass: number;
	readonly interfaceSubClass: number;
	readonly interfaceProtocol: number;
	/** The bound kernel driver (`qmi_wwan`, `cdc_mbim`, `option`, `cdc_ether`, …). */
	readonly driver?: string;
}

/** A single USB device as observed from udev/sysfs — the classifier's whole input. */
export interface UsbDeviceSnapshot {
	readonly vendorId: string;
	readonly productId: string;
	readonly model?: string;
	readonly firmwareRevision?: string;
	readonly manufacturer?: string;
	readonly product?: string;
	readonly databaseVendor?: string;
	readonly databaseModel?: string;
	readonly serialNumber?: string;
	/** The device-descriptor `bDeviceClass` byte (0 ⇒ class is per-interface). */
	readonly bDeviceClass: number;
	readonly interfaces: readonly UsbInterface[];
	/** Stable physical-topology UID (udev `ID_PATH` / physdev) — survives a mode change. */
	readonly physicalUid?: string;
	/** Absolute sysfs path for the USB device, derived from udev's `P:` record. */
	readonly sysfsPath?: string;
	/** The bound network interface name, if the device presents one (`wwan0`, `usb0`). */
	readonly ifname?: string;
	/** Raw udev properties (`ID_USB_MODESWITCH`, `ID_MM_CANDIDATE`, …). */
	readonly udevProperties?: Readonly<Record<string, string>>;
}
