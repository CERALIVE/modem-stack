// ModemManager feature detection — what a given MM daemon can actually do.
//
// A3.2 must run against MM 1.20 (the bookworm floor), 1.22, 1.24, and versions
// nobody has shipped yet. The plan is explicit that this is NOT a version-string
// whitelist: a version we have never seen must degrade gracefully by PROBING the
// observed property set, never throw. So detection combines two signals:
//
//   - the daemon `Version` string (a floor: e.g. eSIM read model is 1.20+), and
//   - the properties actually present on the observed modem (authoritative for
//     `physdev` — the plan requires `physdev` be true ONLY when the `Physdev`
//     property is really there, never merely inferred from a version number).
//
// Property facts pinned by the reviewed design (draft §Oracle round-2 #9 / round-4):
//   - `Modem.Device`  carries the udev slot UID on ALL versions.
//   - `Modem.Physdev` is the physical topology path, 1.22+ ONLY.
//   - there is NO `PhysdevUid` property anywhere — do not look for one.

import { MODEM_IFACE, MODEM3GPP_IFACE, SIM_IFACE } from './constants';
import { type DecodedManagedObjects, findInterface, followObjectPath } from './managed-objects';

/** The capabilities the D-Bus backend gates its behaviour on. */
export interface MmFeatures {
	/** `Modem.Physdev` present (physical topology path, 1.22+). Property-probed. */
	readonly physdev: boolean;
	/**
	 * Cell-info tier:
	 *   - `none`  — below 1.20, or the modem advertises no cell-info capability.
	 *   - `basic` — 1.20/1.21 `GetCellInfo`.
	 *   - `rich`  — 1.22+ (serving-type / bandwidth fields).
	 */
	readonly cellInfo: 'none' | 'basic' | 'rich';
	/** eSIM read model (`Sim.SimType` / `Sim.EsimStatus`), 1.20+. */
	readonly esimStatus: boolean;
	/** Per-modem operation serialization is available (the shared disruptive actor). */
	readonly opSerialization: boolean;
}

/**
 * What A3.2 observed about ONE modem's property surface.
 *
 * `properties` is the union of property NAMES seen across the modem's interfaces
 * (built by `probeModemProperties` from a decoded `GetManagedObjects` tree). The
 * two optional fields let a caller feed richer cell-info evidence than the static
 * object tree carries — MM does not advertise cell-info richness as a Modem
 * property (it comes back from the `GetCellInfo` method), so a backend that has
 * probed cell info can pass what it saw; absent that, detection falls back to the
 * version + `Physdev` co-introduction signal.
 */
export interface MmPropertyProbe {
	/** Property names present on the observed modem (Modem + Modem3gpp + active SIM). */
	readonly properties: ReadonlySet<string>;
	/** Explicit "modem advertises cell info": `false` forces `cellInfo: 'none'`. */
	readonly cellInfoAvailable?: boolean;
	/** Cell-info field names seen in a probe; `serving-type`/`bandwidth` ⇒ `rich`. */
	readonly cellInfoFields?: ReadonlySet<string>;
}

/** A parsed `major.minor` MM version. `null` when the string is not parseable. */
export interface MmVersion {
	readonly major: number;
	readonly minor: number;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.\d+)*/;

/**
 * Parse an MM `Version` string (`1.20.0`, `1.24`, `1.26.0-rc1`, …) to `major.minor`.
 * Returns `null` on anything unparseable — callers must degrade, never throw.
 */
export function parseMmVersion(version: string): MmVersion | null {
	const match = VERSION_PATTERN.exec(version.trim());
	if (match === null) {
		return null;
	}
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
		return null;
	}
	return { major, minor };
}

/** Whether `version` is at least `major.minor` (false when unparseable). */
function atLeast(version: MmVersion | null, major: number, minor: number): boolean {
	if (version === null) {
		return false;
	}
	return version.major > major || (version.major === major && version.minor >= minor);
}

/** MM baseline this stack supports — eSIM read model, `GetCellInfo`, Signal.Setup. */
const MM_MIN = { major: 1, minor: 20 } as const;
/** Physdev + rich cell-info were co-introduced at 1.22. */
const MM_RICH = { major: 1, minor: 22 } as const;

function detectCellInfo(
	probe: MmPropertyProbe,
	supported: boolean,
	modern: boolean,
	physdev: boolean,
): MmFeatures['cellInfo'] {
	// Version floor first: below 1.20 there is no GetCellInfo at all.
	if (!supported) {
		return 'none';
	}
	// A modem that explicitly advertises no cell-info capability degrades to none,
	// even on a version that would otherwise support it.
	if (probe.cellInfoAvailable === false) {
		return 'none';
	}
	const fields = probe.cellInfoFields;
	if (fields !== undefined && (fields.has('serving-type') || fields.has('bandwidth'))) {
		return 'rich';
	}
	// 1.22 co-introduced `Physdev` and the rich cell-info fields, so either signal
	// promotes the tier — this is what makes an unseen future version (e.g. 1.26)
	// resolve to `rich` by probing rather than by matching a whitelist.
	if (modern || physdev) {
		return 'rich';
	}
	return 'basic';
}

/**
 * Detect what an MM daemon can do from its version string AND the properties
 * observed on a modem. Pure — no I/O, never throws (an unparseable version yields
 * the safe floor: property-probed `physdev`, everything else off).
 */
export function detectMmFeatures(version: string, probe: MmPropertyProbe): MmFeatures {
	const parsed = parseMmVersion(version);
	const supported = atLeast(parsed, MM_MIN.major, MM_MIN.minor);
	const modern = atLeast(parsed, MM_RICH.major, MM_RICH.minor);

	// `physdev` is property-authoritative: present iff the `Physdev` property is
	// really in the observed set (never inferred from the version alone).
	const physdev = probe.properties.has('Physdev');

	const esimStatus =
		probe.properties.has('SimType') || probe.properties.has('EsimStatus') || supported;

	const cellInfo = detectCellInfo(probe, supported, modern, physdev);

	return { physdev, cellInfo, esimStatus, opSerialization: supported };
}

/**
 * Build an `MmPropertyProbe` for one modem from a decoded `GetManagedObjects` tree:
 * the union of property names on its `Modem`, `Modem.Modem3gpp`, and active `Sim`
 * interfaces. Cell-info fields are not carried by the static tree, so the returned
 * probe leaves them unset (detection falls back to version + `Physdev`).
 */
export function probeModemProperties(
	tree: DecodedManagedObjects,
	modemPath: string,
): MmPropertyProbe {
	const modem = findInterface(tree, modemPath, MODEM_IFACE);
	const modem3gpp = findInterface(tree, modemPath, MODEM3GPP_IFACE);
	const sim = followObjectPath(tree, modem, 'Sim', SIM_IFACE);

	const properties = new Set<string>();
	for (const source of [modem, modem3gpp, sim]) {
		if (source === undefined) {
			continue;
		}
		for (const [name] of source) {
			properties.add(name);
		}
	}
	return { properties };
}

/** Convenience: detect features straight off a decoded tree for one modem. */
export function detectModemFeatures(
	version: string,
	tree: DecodedManagedObjects,
	modemPath: string,
): MmFeatures {
	return detectMmFeatures(version, probeModemProperties(tree, modemPath));
}
