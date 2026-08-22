export const RUNTIME_COMPOSITION_VENDORS = ['fibocom', 'quectel', 'simcom', 'sierra'] as const;
export type RuntimeCompositionVendor = (typeof RUNTIME_COMPOSITION_VENDORS)[number];

export type RuntimeCompositionMode = number | string;

export type RuntimeCompositionQuery = {
	readonly current: string;
	readonly enumerate: string;
};

/** Commands only: selecting a port, sending, deadlines, and retries belong to the provider. */
export const RUNTIME_COMPOSITION_QUERY_REGISTRY = Object.freeze({
	fibocom: Object.freeze({ current: 'AT+GTUSBMODE?', enumerate: 'AT+GTUSBMODE=?' }),
	quectel: Object.freeze({ current: 'AT+QCFG="usbnet"', enumerate: 'AT+QCFG=?' }),
	simcom: Object.freeze({ current: 'AT+CUSBPIDSWITCH?', enumerate: 'AT+CUSBPIDSWITCH=?' }),
	sierra: Object.freeze({ current: 'AT!USBCOMP?', enumerate: 'AT!USBCOMP=?' }),
} satisfies Readonly<Record<RuntimeCompositionVendor, RuntimeCompositionQuery>>);

export type RuntimeCompositionCapability =
	| {
			readonly status: 'available';
			readonly current: RuntimeCompositionMode;
			readonly enumerated: readonly RuntimeCompositionMode[];
			readonly returnPathProven: boolean;
			readonly offerable: readonly RuntimeCompositionMode[];
	  }
	| {
			readonly status: 'unknown';
			readonly current: null;
			readonly enumerated: readonly [];
			readonly returnPathProven: false;
			readonly offerable: readonly [];
			readonly reason: 'vendor-unsupported' | 'malformed-response';
	  };

export type RuntimeCompositionResponse = {
	readonly vendor: string;
	readonly currentResponse: string;
	readonly enumerationResponse: string;
};

type ParsedCapability = {
	readonly current: RuntimeCompositionMode;
	readonly enumerated: readonly RuntimeCompositionMode[];
};

const UNKNOWN_VENDOR = Object.freeze({
	status: 'unknown',
	current: null,
	enumerated: [],
	returnPathProven: false,
	offerable: [],
	reason: 'vendor-unsupported',
} as const);

const MALFORMED_RESPONSE = Object.freeze({
	status: 'unknown',
	current: null,
	enumerated: [],
	returnPathProven: false,
	offerable: [],
	reason: 'malformed-response',
} as const);

function parseDecimalDomain(domain: string): readonly number[] | undefined {
	const values: number[] = [];
	for (const member of domain.split(',')) {
		const token = member.trim();
		const range = /^(\d+)-(\d+)$/.exec(token);
		if (range !== null) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start > end ||
				end - start > 255
			)
				return undefined;
			for (let value = start; value <= end; value += 1) values.push(value);
			continue;
		}
		if (!/^\d+$/.test(token)) return undefined;
		const value = Number(token);
		if (!Number.isSafeInteger(value)) return undefined;
		values.push(value);
	}
	return values.length > 0 && new Set(values).size === values.length ? values : undefined;
}

function parseFibocom(input: RuntimeCompositionResponse): ParsedCapability | undefined {
	const current = /^\s*\+GTUSBMODE:\s*(\d+)\s*$/m.exec(input.currentResponse);
	const enumeration = /^\s*\+GTUSBMODE:\s*\(([^)]+)\)\s*$/m.exec(input.enumerationResponse);
	if (current === null || enumeration === null) return undefined;
	const enumerated = parseDecimalDomain(enumeration[1] ?? '');
	return enumerated === undefined ? undefined : { current: Number(current[1]), enumerated };
}

function parseQuectel(input: RuntimeCompositionResponse): ParsedCapability | undefined {
	const current = /^\s*\+QCFG:\s*"usbnet"\s*,\s*(\d+)\s*$/m.exec(input.currentResponse);
	const enumeration = /^\s*\+QCFG:\s*"usbnet"\s*,\s*\(([^)]+)\)\s*$/m.exec(
		input.enumerationResponse,
	);
	if (current === null || enumeration === null) return undefined;
	const enumerated = parseDecimalDomain(enumeration[1] ?? '');
	return enumerated === undefined ? undefined : { current: Number(current[1]), enumerated };
}

function parseSimcom(input: RuntimeCompositionResponse): ParsedCapability | undefined {
	const current = /^\s*\+CUSBPIDSWITCH:\s*([0-9A-Fa-f]{4})\s*$/m.exec(input.currentResponse);
	const enumeration = /\+CUSBPIDSWITCH:\s*\(([^)]+)\)\s*,\s*\(0-1\)\s*,\s*\(0-1\)/m.exec(
		input.enumerationResponse,
	);
	if (current === null || enumeration === null) return undefined;
	const tokens = (enumeration[1] ?? '').split(',').map((token) => token.trim().toUpperCase());
	if (tokens.length === 0 || tokens.some((token) => !/^[0-9A-F]{4}$/.test(token))) return undefined;
	if (new Set(tokens).size !== tokens.length) return undefined;
	return { current: (current[1] ?? '').toUpperCase(), enumerated: tokens };
}

function parseSierra(input: RuntimeCompositionResponse): ParsedCapability | undefined {
	const current = /^\s*!USBCOMP:\s*(\d+)(?:\s*,.*)?$/m.exec(input.currentResponse);
	if (current === null) return undefined;
	const enumerated = Array.from(
		input.enumerationResponse.matchAll(/^\s*(\d+)\s*:\s*.+$/gm),
		(match) => Number(match[1]),
	);
	if (enumerated.length === 0 || new Set(enumerated).size !== enumerated.length) return undefined;
	return { current: Number(current[1]), enumerated };
}

const PARSERS: Readonly<
	Record<
		RuntimeCompositionVendor,
		(input: RuntimeCompositionResponse) => ParsedCapability | undefined
	>
> = {
	fibocom: parseFibocom,
	quectel: parseQuectel,
	simcom: parseSimcom,
	sierra: parseSierra,
};

function isRuntimeCompositionVendor(vendor: string): vendor is RuntimeCompositionVendor {
	return Object.hasOwn(RUNTIME_COMPOSITION_QUERY_REGISTRY, vendor);
}

/** Derive controls exclusively from the device's current and enumerated response text. */
export function resolveRuntimeCompositionCapability(
	input: RuntimeCompositionResponse,
): RuntimeCompositionCapability {
	const vendor = input.vendor.trim().toLowerCase();
	if (!isRuntimeCompositionVendor(vendor)) return UNKNOWN_VENDOR;
	const parsed = PARSERS[vendor](input);
	if (parsed === undefined) return MALFORMED_RESPONSE;
	const returnPathProven = parsed.enumerated.includes(parsed.current);
	return {
		status: 'available',
		current: parsed.current,
		enumerated: parsed.enumerated,
		returnPathProven,
		offerable: returnPathProven ? parsed.enumerated : [],
	};
}
