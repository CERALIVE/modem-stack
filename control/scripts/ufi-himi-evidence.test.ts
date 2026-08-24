/**
 * The gate on the bench capture tooling.
 *
 * Three separate things are proven here, and they fail for different reasons:
 *
 *   1. STATIC — neither the capture script nor this schema module contains a construct
 *      that could change the device's state. Every detector has a non-vacuity control,
 *      so a broken regex fails the suite instead of passing it silently.
 *   2. BEHAVIOURAL — the capture script is EXECUTED. On a host with no UFI attached it
 *      answers `device-not-present` and writes nothing; its redaction rules are run over
 *      a synthetic capture carrying every identifier class; and its own leak sweep is
 *      shown to fire on the unredacted input, so a green sweep is not a vacuous one.
 *   3. ANALYTICAL — the interface classifier answers each descriptor triple, and refuses
 *      to answer `diag` for anything but the triple `qualcomm-evidence.ts` defines.
 *
 * The redaction rules live in the script and ONLY in the script. This file executes them
 * rather than re-expressing them, because a second copy is a second thing to drift.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UFI_COMMANDS } from '../src/providers/ufi-himi/transport';
import {
	classifyUfiInterfaceRole,
	readUfiDriverBindings,
	readUfiEvidenceManifest,
	sweepUfiEvidenceText,
	UFI_EVIDENCE_KIND,
	UFI_EVIDENCE_REDACTION_MARKER,
	UFI_EVIDENCE_SCHEMA_VERSION,
	UFI_EVIDENCE_STEPS,
	type UfiEvidenceStep,
	type UfiEvidenceStepStatus,
} from './ufi-himi-evidence';

const SCRIPT = join(import.meta.dir, 'ufi-himi-capture.sh');
const MODULE = join(import.meta.dir, 'ufi-himi-evidence.ts');

async function runScript(
	args: readonly string[],
	options: { readonly stdin?: string; readonly env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([SCRIPT, ...args], {
		stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, ...(options.env ?? {}) },
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

// ── 1. Static fence ──────────────────────────────────────────────────────────────────

/**
 * The exact alternation the plan fixes for this tooling. Case-SENSITIVE on purpose:
 * `setprop` is lowercase because that is how the Android property setter is spelled, and
 * the uppercase form is the AT write shape (`AT+X=<value>`), which the read-only TEST
 * form `AT+X=?` deliberately does not match.
 */
const FORBIDDEN = /usb_modeswitch|setprop|adb |edl|AT!|=?[^)]*SET|qmicli -w/;

const FORBIDDEN_SAMPLES = [
	['modeswitch', 'usb_modeswitch -v 05c6 -p 9091'],
	['android-property-write', 'adb shell setprop sys.usb.config rndis'],
	['shell-transport', 'adb push payload /tmp'],
	['emergency-download', 'edl printgpt'],
	['sierra-vendor-command', 'AT!UDPID=9091'],
	['at-composition-write', 'AT^SETPORT="A1,A2;10,12"'],
	['qmi-write', 'qmicli -w -d /dev/cdc-wdm0'],
] as const;

const SOURCES = new Map<string, string>([
	['ufi-himi-capture.sh', await Bun.file(SCRIPT).text()],
	['ufi-himi-evidence.ts', await Bun.file(MODULE).text()],
]);

describe('the UFI capture tooling cannot change the device', () => {
	test('scans both shipped files, so the gate cannot pass vacuously', () => {
		// Given / When / Then
		expect([...SOURCES.keys()].sort()).toEqual(['ufi-himi-capture.sh', 'ufi-himi-evidence.ts']);
		for (const source of SOURCES.values()) expect(source.length).toBeGreaterThan(500);
	});

	test.each(FORBIDDEN_SAMPLES)('the fence fires on a synthetic %s', (_label, sample) => {
		// Given / When / Then
		expect(FORBIDDEN.test(sample)).toBe(true);
	});

	test.each([...SOURCES.keys()])('%s contains no state-changing construct', (name) => {
		// Given
		const source = SOURCES.get(name) ?? '';

		// When
		const offending = source
			.split('\n')
			.map((line, index) => [index + 1, line] as const)
			.filter(([, line]) => FORBIDDEN.test(line))
			.map(([number]) => number);

		// Then
		expect(offending).toEqual([]);
	});

	test('every HIMI command literal names a member of the frozen vocabulary', () => {
		// Given
		const allowed = new Set<string>(UFI_COMMANDS);

		// When
		const literals = [...SOURCES.values()].flatMap((source) =>
			[...source.matchAll(/cmdid\\?"\s*:\s*\\?"([a-zA-Z_]+)/g)].map((match) => match[1] ?? ''),
		);

		// Then
		expect(literals.length).toBeGreaterThan(0);
		expect(literals.filter((literal) => !allowed.has(literal))).toEqual([]);
	});
});

// ── 2. Behaviour, executed ───────────────────────────────────────────────────────────

/** Every identifier class a real capture can carry, in the shape it really appears in. */
const SYNTHETIC_CAPTURE = [
	'Bus 001 Device 007: ID 05c6:9091 Qualcomm, Inc. UFI',
	'  bcdDevice            2.32',
	'  iSerial                 3 0123456789abcdef',
	'S:  SerialNumber=0123456789abcdef',
	'ID_SERIAL=Qualcomm_UFI_0123456789abcdef',
	'ID_SERIAL_SHORT=0123456789abcdef',
	'ID_NET_NAME_MAC=enx0c5b8f279a64',
	'serial=0123456789abcdef',
	'  bInterfaceClass       255 Vendor Specific Class',
	'{"imei":"356938035643809","imsi":"310150123456789"}',
	'{"iccid":"8991101200003204514","msisdn":"+573115422359"}',
	'{"sn":"UFI2026081900123","token":"c0ffee00c0ffee00"}',
	'link/ether 0c:5b:8f:27:9a:64 brd ff:ff:ff:ff:ff:ff',
	'IMEI: 356938035643809',
	'2-1:1.2 class=ff subclass=ff protocol=30 driver=unbound',
].join('\n');

describe('the capture script redacts at capture time', () => {
	test('the sweep fires on the UNREDACTED synthetic capture (non-vacuity)', () => {
		// Given / When
		const findings = sweepUfiEvidenceText(SYNTHETIC_CAPTURE, 'synthetic');

		// Then — every rule class is reachable from this one fixture
		expect(new Set(findings.map((finding) => finding.rule))).toEqual(
			new Set([
				'long-digit-run',
				'lsusb-iserial',
				'usb-devices-serial',
				'udev-serial-property',
				'mac-address',
				'sysfs-serial-attribute',
				'subscriber-json-key',
			]),
		);
	});

	test('the redaction filter leaves no IMSI, ICCID, IMEI or serial behind', async () => {
		// Given / When
		const filtered = await runScript(['--redact-filter'], { stdin: SYNTHETIC_CAPTURE });

		// Then
		expect(filtered.code).toBe(0);
		expect(sweepUfiEvidenceText(filtered.stdout, 'filtered')).toEqual([]);
		for (const secret of [
			'0123456789abcdef',
			'356938035643809',
			'310150123456789',
			'8991101200003204514',
			'0c:5b:8f:27:9a:64',
			'c0ffee00c0ffee00',
		]) {
			expect(filtered.stdout).not.toContain(secret);
		}
	});

	test('it keeps the descriptor evidence the analysis needs', async () => {
		// Given / When
		const filtered = await runScript(['--redact-filter'], { stdin: SYNTHETIC_CAPTURE });

		// Then
		expect(filtered.stdout).toContain('ID 05c6:9091');
		expect(filtered.stdout).toContain('bcdDevice            2.32');
		expect(filtered.stdout).toContain('bInterfaceClass       255');
		expect(filtered.stdout).toContain('class=ff subclass=ff protocol=30 driver=unbound');
		expect(filtered.stdout).toContain(UFI_EVIDENCE_REDACTION_MARKER);
	});

	test("the script's own sweep agrees with this module's, in both directions", async () => {
		// Given
		const dir = await mkdtemp(join(tmpdir(), 'ufi-sweep-'));
		try {
			const filtered = await runScript(['--redact-filter'], { stdin: SYNTHETIC_CAPTURE });
			await writeFile(join(dir, 'raw.txt'), SYNTHETIC_CAPTURE);

			// When — the raw capture must be REFUSED by the script's own sweep
			const dirty = await runScript(['--sweep', join(dir, 'raw.txt')]);
			await rm(join(dir, 'raw.txt'));
			await writeFile(join(dir, 'clean.txt'), filtered.stdout);
			const clean = await runScript(['--sweep', join(dir, 'clean.txt')]);

			// Then
			expect(dirty.code).toBe(4);
			expect(dirty.stderr).toContain('sweep-findings');
			expect(clean.code).toBe(0);
			expect(clean.stdout.trim()).toBe('sweep-clean');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('a capture with no device attached is honest about it', () => {
	test('answers device-not-present and writes no partial bundle', async () => {
		// Given — a product id no device on any host will carry
		const dir = await mkdtemp(join(tmpdir(), 'ufi-capture-'));
		const target = join(dir, 'bundle');
		try {
			// When
			const run = await runScript([], {
				env: { UFI_USB_ID: 'ffff:fffe', UFI_CAPTURE_DIR: target },
			});

			// Then
			expect(run.code).toBe(3);
			expect(run.stdout.trim()).toBe('device-not-present');
			expect(run.stderr).toContain('no bundle was written');
			expect(await readdir(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ── 3. Analysis ──────────────────────────────────────────────────────────────────────

describe('interface classification answers the descriptor, never the product id', () => {
	test.each([
		['diag', 0xff, 0xff, 0x30],
		['adb-class', 0xff, 0x42, 0x01],
		['rndis-control', 0xe0, 0x01, 0x03],
		['rndis-data', 0x0a, 0x00, 0x00],
		['cdc-acm-control', 0x02, 0x02, 0x01],
		['mass-storage', 0x08, 0x06, 0x50],
		['vendor-specific', 0xff, 0xff, 0xff],
		['vendor-specific', 0xff, 0x42, 0x03],
		['unclassified', 0x03, 0x00, 0x00],
	] as const)('%s', (role, interfaceClass, interfaceSubClass, interfaceProtocol) => {
		// Given / When / Then
		expect(
			classifyUfiInterfaceRole({
				number: 0,
				interfaceClass,
				interfaceSubClass,
				interfaceProtocol,
			}),
		).toBe(role);
	});

	test('only the exact Qualcomm triple classifies as diag', () => {
		// Given
		const nearMisses = [
			{ number: 0, interfaceClass: 0xff, interfaceSubClass: 0xff, interfaceProtocol: 0x40 },
			{ number: 1, interfaceClass: 0xff, interfaceSubClass: 0xfe, interfaceProtocol: 0x30 },
			{ number: 2, interfaceClass: 0xfe, interfaceSubClass: 0xff, interfaceProtocol: 0x30 },
		];

		// When / Then
		for (const descriptor of nearMisses) {
			expect(classifyUfiInterfaceRole(descriptor)).not.toBe('diag');
		}
	});

	test('a binding file classifies each interface and keeps its driver verbatim', () => {
		// Given — the shape ufi-himi-capture.sh writes
		const bindings = [
			'2-1:1.0 class=e0 subclass=01 protocol=03 driver=rndis_host',
			'2-1:1.1 class=0a subclass=00 protocol=00 driver=rndis_host',
			'2-1:1.2 class=ff subclass=ff protocol=ff driver=qmi_wwan',
			'2-1:1.3 class=ff subclass=42 protocol=01 driver=unbound',
			'2-1:1.4 class=ff subclass=ff protocol=30 driver=unbound',
		].join('\n');

		// When
		const findings = readUfiDriverBindings(bindings);

		// Then
		expect(findings.map((finding) => finding.role)).toEqual([
			'rndis-control',
			'rndis-data',
			'vendor-specific',
			'adb-class',
			'diag',
		]);
		expect(findings.map((finding) => finding.descriptor.number)).toEqual([0, 1, 2, 3, 4]);
		expect(findings.map((finding) => finding.driver)).toEqual([
			'rndis_host',
			'rndis_host',
			'qmi_wwan',
			'unbound',
			'unbound',
		]);
	});

	test('an unreadable line is skipped rather than guessed at', () => {
		// Given / When
		const findings = readUfiDriverBindings('=== device 2-1 ===\nnot a binding line\n');

		// Then
		expect(findings).toEqual([]);
	});
});

// ── Manifest ─────────────────────────────────────────────────────────────────────────

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const steps: Record<UfiEvidenceStep, UfiEvidenceStepStatus> = {
		lsusbVerbose: 'captured',
		usbDevices: 'captured',
		udevProperties: 'captured',
		driverBindings: 'captured',
		sysComposition: 'captured',
		himiIdentity: 'skipped-no-credential',
	};
	return {
		schemaVersion: UFI_EVIDENCE_SCHEMA_VERSION,
		kind: UFI_EVIDENCE_KIND,
		usbId: '05c6:9091',
		capturedAt: '2026-08-22T10:00:00Z',
		host: 'ceralive2',
		kernel: '7.1.7-ceralive-rk3588',
		matchedSysfsDevices: ['2-1'],
		steps,
		redaction: 'capture-time',
		mutations: 'none',
		...overrides,
	};
}

describe('the bundle manifest', () => {
	test('accepts a complete capture and names every step', () => {
		// Given / When
		const reading = readUfiEvidenceManifest(manifest());

		// Then
		expect(reading.state).toBe('valid');
		if (reading.state !== 'valid') return;
		expect(Object.keys(reading.manifest.steps).sort()).toEqual([...UFI_EVIDENCE_STEPS].sort());
	});

	test('refuses a manifest that does not state it changed nothing', () => {
		// Given / When
		const reading = readUfiEvidenceManifest(manifest({ mutations: 'composition-switch' }));

		// Then
		expect(reading.state).toBe('invalid');
		if (reading.state !== 'invalid') return;
		expect(reading.problems).toContainEqual({ kind: 'mutations-claimed' });
	});

	test('refuses an unknown schema version and an unknown step status', () => {
		// Given / When
		const version = readUfiEvidenceManifest(manifest({ schemaVersion: 99 }));
		const status = readUfiEvidenceManifest(
			manifest({ steps: { ...(manifest().steps as object), himiIdentity: 'probably-fine' } }),
		);

		// Then
		expect(version.state).toBe('invalid');
		expect(status.state).toBe('invalid');
		if (status.state !== 'invalid') return;
		expect(status.problems).toContainEqual({ kind: 'unknown-step-status', step: 'himiIdentity' });
	});

	test('accumulates problems rather than stopping at the first', () => {
		// Given / When
		const reading = readUfiEvidenceManifest({ kind: 'something-else' });

		// Then
		expect(reading.state).toBe('invalid');
		if (reading.state !== 'invalid') return;
		expect(reading.problems.length).toBeGreaterThan(3);
	});
});
