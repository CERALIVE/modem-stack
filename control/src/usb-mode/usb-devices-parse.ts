// Parsing `usb-devices` text — the ONLY per-interface descriptor source inside a
// certification bundle.
//
// A base certification bundle (`certify <slot>` with no `--transition`) carries no
// structured descriptors at all: it holds `lsusb -v` and `usb-devices` as raw text plus
// the slot's udev property map. Authoring a classifier fixture or a catalog entry from
// such a bundle therefore requires reading the descriptors back out of that text, and
// `usb-devices` is the right half to read — it is line-oriented, one fixed-width record
// per device, and it names each interface's BOUND KERNEL DRIVER, which `lsusb -v` does
// not. The driver is not optional detail here: `classifyDevice` decides `mm-managed` vs
// `router-mode` partly on `qmi_wwan` / `cdc_ether` / `option` bindings.
//
// The parser is pure and total: unparseable lines are SKIPPED, never guessed at, and a
// device that yields no interfaces still yields a record (callers decide whether an
// interface-less device is usable — this file never makes that judgement).
//
// Record shape (`usb-devices`, one blank-line-separated block per device):
//   T:  Bus=04 Lev=03 Prnt=03 Port=03 Cnt=01 Dev#=  7 Spd=480 MxCh= 0
//   D:  Ver= 2.00 Cls=00(>ifc ) Sub=00 Prot=00 MxPS=64 #Cfgs=  1
//   P:  Vendor=2c7c ProdID=0801 Rev=05.04
//   S:  Manufacturer=Quectel
//   S:  Product=RM530N-GL
//   I:  If#= 4 Alt= 0 #EPs= 3 Cls=ff(vend.) Sub=ff Prot=ff Driver=qmi_wwan

/** One interface line of a `usb-devices` record. */
export interface ParsedUsbInterface {
	readonly interfaceClass: number;
	readonly interfaceSubClass: number;
	readonly interfaceProtocol: number;
	/** The bound kernel driver, omitted when `usb-devices` reports `(none)`. */
	readonly driver?: string;
}

/** One device block of a `usb-devices` capture. */
export interface ParsedUsbDevice {
	/** Lowercase hex `xxxx:xxxx`, exactly the catalog's `vidPid` discriminator shape. */
	readonly vidPid: string;
	/** The `D:` line's `Cls=` byte — the device-descriptor `bDeviceClass`. */
	readonly bDeviceClass: number;
	readonly manufacturer?: string;
	readonly product?: string;
	readonly interfaces: readonly ParsedUsbInterface[];
}

/** Read `Key=value` from a `usb-devices` line; `undefined` when the key is absent. */
function field(line: string, key: string): string | undefined {
	// Values are whitespace-delimited and may be preceded by padding spaces (`Dev#=  7`).
	// `Cls=ff(vend.)` carries a trailing gloss, stripped by the hex/number parsers below.
	const match = new RegExp(`${key}=\\s*(\\S+)`).exec(line);
	return match?.[1];
}

/** Parse a hex byte field, tolerating `usb-devices`' `ff(vend.)` gloss suffix. */
function hexByte(line: string, key: string): number | undefined {
	const raw = field(line, key);
	if (raw === undefined) {
		return undefined;
	}
	const digits = /^[0-9a-fA-F]{1,2}/.exec(raw)?.[0];
	if (digits === undefined) {
		return undefined;
	}
	const value = Number.parseInt(digits, 16);
	return Number.isNaN(value) ? undefined : value;
}

/** Parse an `S:  Manufacturer=…` style line into its `[key, value]` pair. */
function stringField(line: string): readonly [string, string] | undefined {
	const eq = line.indexOf('=');
	if (eq < 0) {
		return undefined;
	}
	const key = line.slice(3, eq).trim();
	const value = line.slice(eq + 1).trim();
	return key === '' || value === '' ? undefined : [key, value];
}

interface DeviceAccumulator {
	vidPid?: string;
	bDeviceClass?: number;
	manufacturer?: string;
	product?: string;
	interfaces: ParsedUsbInterface[];
}

function emptyAccumulator(): DeviceAccumulator {
	return { interfaces: [] };
}

function finish(acc: DeviceAccumulator, out: ParsedUsbDevice[]): void {
	// A record with no `P:` line is not a device — never synthesise an identity for it.
	if (acc.vidPid === undefined) {
		return;
	}
	out.push({
		vidPid: acc.vidPid,
		bDeviceClass: acc.bDeviceClass ?? 0,
		interfaces: acc.interfaces,
		...(acc.manufacturer !== undefined ? { manufacturer: acc.manufacturer } : {}),
		...(acc.product !== undefined ? { product: acc.product } : {}),
	});
}

function applyProductLine(line: string, acc: DeviceAccumulator): void {
	const vendor = field(line, 'Vendor');
	const product = field(line, 'ProdID');
	if (vendor !== undefined && product !== undefined) {
		acc.vidPid = `${vendor.toLowerCase()}:${product.toLowerCase()}`;
	}
}

function applyStringLine(line: string, acc: DeviceAccumulator): void {
	const pair = stringField(line);
	if (pair === undefined) {
		return;
	}
	const [key, value] = pair;
	if (key === 'Manufacturer') {
		acc.manufacturer = value;
	} else if (key === 'Product') {
		acc.product = value;
	}
}

function applyInterfaceLine(line: string, acc: DeviceAccumulator): void {
	const interfaceClass = hexByte(line, 'Cls');
	const interfaceSubClass = hexByte(line, 'Sub');
	const interfaceProtocol = hexByte(line, 'Prot');
	if (
		interfaceClass === undefined ||
		interfaceSubClass === undefined ||
		interfaceProtocol === undefined
	) {
		return;
	}
	const driver = field(line, 'Driver');
	acc.interfaces.push({
		interfaceClass,
		interfaceSubClass,
		interfaceProtocol,
		...(driver !== undefined && driver !== '(none)' ? { driver } : {}),
	});
}

/**
 * Parse `usb-devices` output into one record per device. Pure and total: malformed
 * lines are skipped rather than guessed at, and a block with no `P:` line yields no
 * record (it has no identity, so inventing one would be a lie).
 */
export function parseUsbDevices(text: string): ParsedUsbDevice[] {
	const out: ParsedUsbDevice[] = [];
	let acc = emptyAccumulator();
	for (const line of text.split('\n')) {
		// A `T:` line opens a new device record; `usb-devices` also blank-line-separates
		// them, but the topology line is the reliable delimiter (blank lines are optional
		// in some kernels' output).
		if (line.startsWith('T:')) {
			finish(acc, out);
			acc = emptyAccumulator();
			continue;
		}
		if (line.startsWith('D:')) {
			const deviceClass = hexByte(line, 'Cls');
			if (deviceClass !== undefined) {
				acc.bDeviceClass = deviceClass;
			}
		} else if (line.startsWith('P:')) {
			applyProductLine(line, acc);
		} else if (line.startsWith('S:')) {
			applyStringLine(line, acc);
		} else if (line.startsWith('I:')) {
			applyInterfaceLine(line, acc);
		}
	}
	finish(acc, out);
	return out;
}

/**
 * Find the single device matching `vidPid` in a parsed capture. Returns `undefined`
 * when there is NO match, and — deliberately — also when there is more than one: a
 * duplicate VID:PID (this bench has two identical Huawei HiLink units) makes the
 * selection ambiguous, and an ambiguous selection must refuse rather than pick the
 * first. The caller turns that into a typed refusal.
 */
export function selectUniqueDevice(
	devices: readonly ParsedUsbDevice[],
	vidPid: string,
): { readonly device: ParsedUsbDevice } | { readonly ambiguousMatches: number } {
	const matches = devices.filter((d) => d.vidPid === vidPid);
	const only = matches[0];
	if (matches.length === 1 && only !== undefined) {
		return { device: only };
	}
	return { ambiguousMatches: matches.length };
}
