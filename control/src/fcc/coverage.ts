// The FCC-unlock COVERAGE CATALOG — which `<vid>:<pid>` ModemManager can unlock.
//
// This is the evidence source for the `fcc-auto-unlock` capability module.
// `capability/detect.ts` answers `unknown` for that module on purpose and says why:
// FCC unlock is carried out by a ModemManager DISPATCHER keyed on the device, and
// nothing on the modem's own D-Bus surface says whether a procedure applies. So the
// answer has to come from a catalog, and this is it.
//
// Pinned to ModemManager 1.24.2 (`packaging/upstream-pins.yaml`) — the exact release
// this repository rebuilds. Prose walkthrough, per-device fleet verdicts and the
// market table: `docs/FCC-UNLOCK-COVERAGE.md`.
//
// THE KEY IS `<vid>:<pid>` AND NOTHING ELSE. `mm-dispatcher-fcc-unlock.c` builds
// exactly one filename — `g_strdup_printf("%04x:%04x", vid, pid)` — and looks for it
// in the two enabled tiers. A vendor-only name is never opened by the dispatcher; it
// only ever exists as the TARGET of a `<vid>:<pid>` link in the available tier. And a
// vendor-keyed rule would be wrong twice over: Sierra silicon ships under three
// vendor ids (`1199` its own, `03f0` HP-branded, `413c` Dell-branded), so keying on
// the vendor misses two of the three, while keying on the model misses the rebrands.

/** The four vendor scripts ModemManager 1.24.2 ships, and what each one drives. */
export const MM_FCC_UNLOCK_VENDOR_SCRIPTS = {
	'105b': 'mbimcli',
	'1199': 'qmicli',
	'14c3': 'mbimcli',
	'2c7c': 'qmicli',
} as const;

export type MmFccUnlockVendorScript = keyof typeof MM_FCC_UNLOCK_VENDOR_SCRIPTS;

/** The interpreters those scripts invoke, and the packages that provide them. */
export const MM_FCC_UNLOCK_RUNTIME_PACKAGES = {
	qmicli: 'libqmi-utils',
	mbimcli: 'libmbim-utils',
} as const;

/**
 * ModemManager 1.24.2's COMPLETE shipped mapping — `data/dispatcher-fcc-unlock/
 * meson.build`'s `vidpids` dict, verbatim. Fourteen entries; there are no others.
 */
export const MM_FCC_UNLOCK_COVERAGE = {
	'03f0:4e1d': '1199',
	'105b:e0ab': '105b',
	'105b:e0c3': '105b',
	'1199:9079': '1199',
	'14c3:4d75': '14c3',
	'1eac:1001': '2c7c',
	'1eac:1004': '2c7c',
	'1eac:1007': '2c7c',
	'2c7c:030a': '2c7c',
	'2c7c:0313': '2c7c',
	'2c7c:0314': '2c7c',
	'2c7c:0801': '2c7c',
	'413c:81a3': '1199',
	'413c:81a8': '1199',
} as const satisfies Record<string, MmFccUnlockVendorScript>;

export type MmFccUnlockKey = keyof typeof MM_FCC_UNLOCK_COVERAGE;

/** `<4 lowercase hex>:<4 lowercase hex>` — the dispatcher's own filename shape. */
const VID_PID_RE = /^[0-9a-f]{4}:[0-9a-f]{4}$/;

/**
 * Fold a vid/pid pair into the dispatcher's key, or `undefined` when it is not a
 * pair of 4-hex ids. Case is folded because sysfs and udev disagree about it
 * (`ID_VENDOR_ID` is lowercase, some vendor strings are not) while the dispatcher's
 * `%04x` is unambiguously lowercase; a `0x` prefix is tolerated for the same reason.
 * NOTHING ELSE is normalized — a 3-digit or 5-digit id is a different device, not a
 * sloppy spelling of this one.
 */
export function normalizeVidPid(vid: string, pid: string): string | undefined {
	const fold = (raw: string): string => raw.trim().toLowerCase().replace(/^0x/, '');
	const key = `${fold(vid)}:${fold(pid)}`;
	return VID_PID_RE.test(key) ? key : undefined;
}

/** True for a string already in the dispatcher's `<vid>:<pid>` shape. */
export function isFccUnlockKey(value: string): boolean {
	return VID_PID_RE.test(value);
}

/**
 * Does ModemManager ship an unlock procedure for this device?
 *
 * The three answers are NOT interchangeable, and the third is why this returns a
 * tri-state rather than a boolean:
 *   present — a `<vid>:<pid>` entry exists; the toggle can do something.
 *   absent  — the ids are well-formed and are NOT in the mapping. A positive
 *             statement about the device, so the module reads `unavailable` and no
 *             control is offered.
 *   unknown — we could not read the ids at all. That is a statement about the READ,
 *             and reporting it as `absent` would hide the module on hardware that
 *             may well be covered.
 */
export function resolveFccUnlockCoverage(
	vid: string | undefined,
	pid: string | undefined,
): 'present' | 'absent' | 'unknown' {
	if (vid === undefined || pid === undefined) {
		return 'unknown';
	}
	const key = normalizeVidPid(vid, pid);
	if (key === undefined) {
		return 'unknown';
	}
	return key in MM_FCC_UNLOCK_COVERAGE ? 'present' : 'absent';
}

/** The vendor script a covered key resolves to, for diagnostics and docs. */
export function fccUnlockVendorScript(key: string): MmFccUnlockVendorScript | undefined {
	return (MM_FCC_UNLOCK_COVERAGE as Record<string, MmFccUnlockVendorScript>)[key];
}

/** The interpreter a covered key's script invokes (`qmicli` / `mbimcli`). */
export function fccUnlockRuntimeBinary(key: string): 'qmicli' | 'mbimcli' | undefined {
	const script = fccUnlockVendorScript(key);
	return script === undefined ? undefined : MM_FCC_UNLOCK_VENDOR_SCRIPTS[script];
}
