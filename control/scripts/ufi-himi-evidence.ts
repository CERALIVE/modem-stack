/**
 * The schema and the analysis vocabulary for a UFI/HIMI descriptor evidence bundle.
 *
 * `ufi-himi-capture.sh` WRITES a bundle; this module says what a bundle IS, classifies
 * the interfaces inside one, and sweeps it for a subscriber identifier the capture-time
 * redaction should already have masked. It is pure — no transport, no subprocess, no
 * device contact — and it lives beside the capture script rather than inside
 * `control/src/providers/ufi-himi/`, because bench capture tooling is not part of the
 * published package (`files: ["dist"]`) and the provider's own no-write-path gate is a
 * closed enumeration of that directory.
 *
 * WHAT A BUNDLE MAY CONCLUDE, AND WHAT IT MAY NOT. A product id concludes nothing:
 * `05c6` is Qualcomm's generic vendor id, `9091` is chosen by whoever built the firmware
 * image, upstream Linux matches it in one driver table under an unrelated annotation,
 * and third-party tooling documents the same id on a different device. Only THIS unit's
 * interface descriptors say what THIS unit exposes, and only the captured driver binding
 * says who claimed each one. Those two facts are recorded separately and never merged:
 * a descriptor triple is what an interface IS, a binding is a fact about one kernel on
 * one board, and inferring either from the other is the mistake the whole bundle exists
 * to make impossible.
 */

import type { UfiUsbInterfaceDescriptor } from '../src/providers/ufi-himi/qualcomm-evidence';
import { classifyUfiDiagEvidence } from '../src/providers/ufi-himi/qualcomm-evidence';

/** Bumped only when a bundle's shape changes; a reader refuses an unknown version. */
export const UFI_EVIDENCE_SCHEMA_VERSION = 1;
export const UFI_EVIDENCE_KIND = 'ufi-himi-descriptor-evidence';

/** Mirrors `control/src/redact.ts`'s marker, so one shape means "masked" everywhere. */
export const UFI_EVIDENCE_REDACTION_MARKER = '[redacted]';

/** Every file a complete bundle carries. `himi-identity.json` is credential-gated. */
export const UFI_EVIDENCE_FILES = [
	'manifest.json',
	'lsusb-verbose.txt',
	'usb-devices.txt',
	'udev-properties.txt',
	'driver-bindings.txt',
	'sys-composition.txt',
] as const;
export const UFI_EVIDENCE_OPTIONAL_FILES = ['himi-identity.json'] as const;

/**
 * A step status is HONEST about why a step produced nothing. `tool-unavailable` is a
 * statement about the host, `unreachable` about the device's HTTP API, and
 * `skipped-no-credential` about the operator's choice — folding the three into a bare
 * absent field would leave the next reader unable to tell a gap from a finding.
 */
export const UFI_EVIDENCE_STEP_STATUSES = [
	'captured',
	'empty',
	'tool-unavailable',
	'unreachable',
	'skipped-no-credential',
] as const;
export type UfiEvidenceStepStatus = (typeof UFI_EVIDENCE_STEP_STATUSES)[number];

export const UFI_EVIDENCE_STEPS = [
	'lsusbVerbose',
	'usbDevices',
	'udevProperties',
	'driverBindings',
	'sysComposition',
	'himiIdentity',
] as const;
export type UfiEvidenceStep = (typeof UFI_EVIDENCE_STEPS)[number];

export type UfiEvidenceManifest = {
	readonly schemaVersion: number;
	readonly kind: typeof UFI_EVIDENCE_KIND;
	readonly usbId: string;
	readonly capturedAt: string;
	readonly host: string;
	readonly kernel: string;
	readonly matchedSysfsDevices: readonly string[];
	readonly steps: Readonly<Record<UfiEvidenceStep, UfiEvidenceStepStatus>>;
	readonly redaction: 'capture-time';
	readonly mutations: 'none';
};

export type UfiManifestProblem =
	| { readonly kind: 'not-an-object' }
	| { readonly kind: 'wrong-kind' }
	| { readonly kind: 'unsupported-schema-version'; readonly found: unknown }
	| { readonly kind: 'missing-field'; readonly field: string }
	| { readonly kind: 'unknown-step-status'; readonly step: string }
	| { readonly kind: 'mutations-claimed' };

export type UfiManifestReading =
	| { readonly state: 'valid'; readonly manifest: UfiEvidenceManifest }
	| { readonly state: 'invalid'; readonly problems: readonly UfiManifestProblem[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validated by hand rather than with a schema library: this module is bench tooling and
 * takes no dependency the published package does not already carry for a real reason.
 * Problems are ACCUMULATED — a reader fixing a bundle wants every complaint at once.
 */
export function readUfiEvidenceManifest(value: unknown): UfiManifestReading {
	if (!isRecord(value)) return { state: 'invalid', problems: [{ kind: 'not-an-object' }] };
	const problems: UfiManifestProblem[] = [];
	if (value.kind !== UFI_EVIDENCE_KIND) problems.push({ kind: 'wrong-kind' });
	if (value.schemaVersion !== UFI_EVIDENCE_SCHEMA_VERSION) {
		problems.push({ kind: 'unsupported-schema-version', found: value.schemaVersion });
	}
	for (const field of ['usbId', 'capturedAt', 'host', 'kernel'] as const) {
		if (typeof value[field] !== 'string') problems.push({ kind: 'missing-field', field });
	}
	if (!Array.isArray(value.matchedSysfsDevices)) {
		problems.push({ kind: 'missing-field', field: 'matchedSysfsDevices' });
	}
	const steps = value.steps;
	if (!isRecord(steps)) {
		problems.push({ kind: 'missing-field', field: 'steps' });
	} else {
		const known = new Set<string>(UFI_EVIDENCE_STEP_STATUSES);
		for (const step of UFI_EVIDENCE_STEPS) {
			const status = steps[step];
			if (typeof status !== 'string' || !known.has(status)) {
				problems.push({ kind: 'unknown-step-status', step });
			}
		}
	}
	if (value.redaction !== 'capture-time') {
		problems.push({ kind: 'missing-field', field: 'redaction' });
	}
	// A bundle that does not state `mutations: "none"` is not a read-only capture, and
	// nothing downstream may treat it as one.
	if (value.mutations !== 'none') problems.push({ kind: 'mutations-claimed' });
	return problems.length > 0
		? { state: 'invalid', problems }
		: { state: 'valid', manifest: value as unknown as UfiEvidenceManifest };
}

// ── Interface classification ─────────────────────────────────────────────────────────

/**
 * A role is the descriptor triple's own meaning, never a guess about function. `diag` is
 * decided by `classifyUfiDiagEvidence` itself rather than by a second copy of its
 * constants, so the bench analysis and the shipped provider can never disagree about
 * what a DIAG interface looks like.
 *
 * `vendor-specific` is a real answer, not a failure: Qualcomm's `ff/ff/*` space carries
 * the QMI, NMEA and modem functions and the numbers are conventions, not a registry. The
 * captured driver binding is what says which one this unit's kernel took — and a
 * `vendor-specific` interface with an `unbound` binding is exactly the finding worth
 * having, because it is a function nothing on the board is currently claiming.
 */
export const UFI_INTERFACE_ROLES = [
	'diag',
	'adb-class',
	'rndis-control',
	'rndis-data',
	'cdc-acm-control',
	'mass-storage',
	'vendor-specific',
	'unclassified',
] as const;
export type UfiInterfaceRole = (typeof UFI_INTERFACE_ROLES)[number];

const VENDOR_SPECIFIC_CLASS = 0xff;

export function classifyUfiInterfaceRole(descriptor: UfiUsbInterfaceDescriptor): UfiInterfaceRole {
	const evidence = classifyUfiDiagEvidence({ usbId: '', interfaces: [descriptor] });
	if (evidence.state === 'descriptor-confirmed') return 'diag';
	const { interfaceClass, interfaceSubClass, interfaceProtocol } = descriptor;
	// Google's ADB function: vendor class, subclass 0x42, protocol 0x01. Present on the
	// bench `05c6:9024` composition, and a permission for nothing (prohibitions.ts
	// `shell.transport-fallback`) — recording it is how production stays explicit that
	// it never reaches this device that way.
	if (interfaceClass === VENDOR_SPECIFIC_CLASS && interfaceSubClass === 0x42) {
		return interfaceProtocol === 0x01 ? 'adb-class' : 'vendor-specific';
	}
	// RNDIS: wireless-controller class carrying the control channel, CDC-data carrying
	// the payload. The pair is what `rndis_host` binds.
	if (interfaceClass === 0xe0 && interfaceSubClass === 0x01 && interfaceProtocol === 0x03) {
		return 'rndis-control';
	}
	if (interfaceClass === 0x0a) return 'rndis-data';
	if (interfaceClass === 0x02 && interfaceSubClass === 0x02) return 'cdc-acm-control';
	if (interfaceClass === 0x08) return 'mass-storage';
	if (interfaceClass === VENDOR_SPECIFIC_CLASS) return 'vendor-specific';
	return 'unclassified';
}

/** One analysis row: what the descriptor says, and — separately — who claimed it. */
export type UfiInterfaceFinding = {
	readonly descriptor: UfiUsbInterfaceDescriptor;
	readonly role: UfiInterfaceRole;
	/** Verbatim from `driver-bindings.txt`; `unbound` is a value, not a missing one. */
	readonly driver: string;
};

const BINDING_LINE =
	/^(?<address>\S+)\s+class=(?<class>[0-9a-fA-F]+)\s+subclass=(?<subclass>[0-9a-fA-F]+)\s+protocol=(?<protocol>[0-9a-fA-F]+)\s+driver=(?<driver>\S+)/;

/**
 * Parses `driver-bindings.txt`. The interface NUMBER is taken from the sysfs address's
 * `…:c.i` tail, which is the kernel's own numbering — not from the line's position, so a
 * bundle whose interfaces enumerate out of order still classifies correctly.
 */
export function readUfiDriverBindings(text: string): readonly UfiInterfaceFinding[] {
	const findings: UfiInterfaceFinding[] = [];
	for (const line of text.split('\n')) {
		const match = BINDING_LINE.exec(line.trim());
		const groups = match?.groups;
		if (groups === undefined) continue;
		const tail = groups.address?.split('.').at(-1) ?? '';
		const descriptor: UfiUsbInterfaceDescriptor = {
			number: Number.parseInt(tail, 10),
			interfaceClass: Number.parseInt(groups.class ?? '', 16),
			interfaceSubClass: Number.parseInt(groups.subclass ?? '', 16),
			interfaceProtocol: Number.parseInt(groups.protocol ?? '', 16),
		};
		if (Number.isNaN(descriptor.number) || Number.isNaN(descriptor.interfaceClass)) continue;
		findings.push({
			descriptor,
			role: classifyUfiInterfaceRole(descriptor),
			driver: groups.driver ?? 'unbound',
		});
	}
	return findings;
}

// ── Redaction sweep ──────────────────────────────────────────────────────────────────

/**
 * The tested twin of `ufi-himi-capture.sh`'s `sweep_file`. Two independent checkers over
 * one bundle is deliberate: they fail the capture when they disagree, which is the safe
 * direction, and this one is the half a test can drive over a synthetic leak.
 *
 * A FINDING NEVER CARRIES THE VALUE IT FOUND — only the rule, the file and the line. A
 * leak report that quotes the leak is the leak, and these reports land in CI logs.
 */
export const UFI_SWEEP_RULES = [
	{
		// 15 digits is an IMEI or an IMSI, 19-20 an ICCID. Nothing in a USB descriptor is
		// 14 digits long, so this backstop costs no descriptor fidelity.
		id: 'long-digit-run',
		re: /[0-9]{14,}/,
	},
	{ id: 'lsusb-iserial', re: /iSerial\s+[0-9]+\s+[^\s[]/ },
	{ id: 'usb-devices-serial', re: /SerialNumber=[^\s[]/ },
	{
		id: 'udev-serial-property',
		re: /(?:ID_SERIAL|ID_SERIAL_SHORT|ID_USB_SERIAL|ID_USB_SERIAL_SHORT|ID_SERIAL_ID|ID_NET_NAME_MAC)=[^\s[]/,
	},
	{ id: 'mac-address', re: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/ },
	{
		id: 'sysfs-serial-attribute',
		re: /^\s*serial\s*[:=]\s*[^\s[]/i,
	},
	{
		id: 'subscriber-json-key',
		re: /"[A-Za-z0-9_]*(?:serial|imei|imsi|iccid|msisdn)[A-Za-z0-9_]*"\s*:\s*"?[^"\s[]/i,
	},
] as const;
export type UfiSweepRuleId = (typeof UFI_SWEEP_RULES)[number]['id'];

export type UfiRedactionFinding = {
	readonly file: string;
	readonly line: number;
	readonly rule: UfiSweepRuleId;
};

export function sweepUfiEvidenceText(
	text: string,
	file = '<stdin>',
): readonly UfiRedactionFinding[] {
	const findings: UfiRedactionFinding[] = [];
	const lines = text.split('\n');
	for (const [index, line] of lines.entries()) {
		for (const rule of UFI_SWEEP_RULES) {
			if (rule.re.test(line)) findings.push({ file, line: index + 1, rule: rule.id });
		}
	}
	return findings;
}

export async function sweepUfiEvidenceBundle(dir: string): Promise<readonly UfiRedactionFinding[]> {
	const { readdir } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const findings: UfiRedactionFinding[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		findings.push(...sweepUfiEvidenceText(await Bun.file(path).text(), entry.name));
	}
	return findings;
}

if (import.meta.main) {
	const target = Bun.argv[2];
	if (target === undefined) {
		console.error('usage: bun run control/scripts/ufi-himi-evidence.ts <bundle-dir>');
		process.exit(2);
	}
	const findings = await sweepUfiEvidenceBundle(target);
	for (const finding of findings) {
		console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
	}
	console.log(findings.length === 0 ? 'sweep-clean' : `sweep-findings ${findings.length}`);
	process.exit(findings.length === 0 ? 0 : 1);
}
