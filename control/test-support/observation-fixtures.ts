// Canonical per-source normalization fixtures.
//
// Each one is shaped like the payload its provider really returns — ModemManager's
// decoded property records, HiLink's XML bodies, a ZTE goform JSON blob, three UFI
// endpoint envelopes — and each deliberately carries at least one VENDOR-SPECIFIC
// field the normalized model has no slot for. Those extra fields are the point: they
// are what the round-trip assertions prove is retained rather than dropped.
//
// The providers that will eventually produce these payloads live in later changes.
// These fixtures are what the normalization layer is proven against in the meantime,
// and what those providers' contract tests should reuse rather than re-invent.

import {
	type DeviceGeneration,
	deviceGeneration,
	type EpochMillis,
	epochMillis,
	resolvePhysicalModemIdentity,
	type SourceEpoch,
	type StableKey,
	sourceEpoch,
} from '../src/domain';
import type {
	HilinkObservationInput,
	ModemManagerObservationInput,
	NormalizationContext,
	RawFieldValue,
	UfiObservationInput,
	ZteObservationInput,
} from '../src/observations';

export const FIXTURE_STABLE_KEY: StableKey = resolvePhysicalModemIdentity({
	serial: 'FIXTURE-MODEM-0001',
}).stableKey;

export const FIXTURE_GENERATION: DeviceGeneration = deviceGeneration(7);
export const FIXTURE_SOURCE_EPOCH: SourceEpoch = sourceEpoch(42);
export const FIXTURE_OBSERVED_AT: EpochMillis = epochMillis(1_700_000_000_000);

export function fixtureContext(
	overrides: Partial<NormalizationContext> = {},
): NormalizationContext {
	return {
		stableKey: FIXTURE_STABLE_KEY,
		generation: FIXTURE_GENERATION,
		sourceEpoch: FIXTURE_SOURCE_EPOCH,
		observedAt: FIXTURE_OBSERVED_AT,
		...overrides,
	};
}

/**
 * One `Modem.Signal` RAT dict in the shape the retention layer keeps it.
 *
 * A D-Bus `a{sv}` decodes to `[key, value][]`, never to a flat object, so a fixture that
 * spelled these as objects would be testing a payload ModemManager never sends.
 */
function signalDict(members: Readonly<Record<string, number>>): RawFieldValue {
	return Object.entries(members);
}

/**
 * A registered ModemManager modem, attached 5G NSA.
 *
 * `Modem.Ports`, `Modem3gpp.Pco` and `Signal.Rate` are the extras here: real MM
 * properties that this layer's normalized model has no slot for.
 *
 * `Signal` carries the REAL interface shape — one `a{sv}` per RAT. `Nr5g` and `Lte` are
 * both populated because an NSA attach populates both, which is exactly the case where
 * the RAT ladder has to choose and provenance has to say which it chose. Every remaining
 * dict is present-and-empty, as MM exports them for RATs the modem is not on.
 */
export const MM_FIXTURE: ModemManagerObservationInput = {
	modem: {
		Model: 'RM530N-GL',
		Manufacturer: 'Quectel',
		Revision: 'RM530NGLAAR11A02M4G  1  [Feb 13 2024 05:00:00]',
		State: 8,
		CurrentModes: (1 << 3) | (1 << 4),
		AccessTechnologies: 1 << 15,
		SignalQuality: 71,
		Sim: '/org/freedesktop/ModemManager1/SIM/0',
		SimSlots: ['/org/freedesktop/ModemManager1/SIM/0', '/'],
		UnlockRequired: 1,
		Ports: ['ttyUSB0', 'wwan0'],
	},
	modem3gpp: {
		RegistrationState: 1,
		// The REGISTERED operator. `sim.OperatorName` below is the SIM's HOME operator
		// and is deliberately a different string, so a normalizer that read the wrong
		// interface is visible rather than accidentally correct.
		OperatorName: 'Claro',
		OperatorCode: '732101',
		Pco: 'dns-primary=10.0.0.1',
	},
	// `Modem.Location`, keyed by DECODED SOURCE NAME. The value is MM's own five-token
	// `3gpp-lac-ci` string: MCC, MNC, then LAC / CI / TAC in uppercase hex.
	location: {
		'3gpp-lac-ci': '732,101,2B1C,0A1B2C3D,4E5F',
	},
	sim: {
		SimType: 1,
		EsimStatus: 0,
		OperatorName: 'CLARO COL',
	},
	signal: {
		Rate: 5,
		Nr5g: signalDict({ rsrp: -98.5, rsrq: -11, snr: 6.5, 'error-rate': 0 }),
		Lte: signalDict({ rssi: -71, rsrp: -104, rsrq: -13.5, snr: 4, 'error-rate': 0 }),
		Cdma: [],
		Evdo: [],
		Gsm: [],
		Umts: [],
	},
};

/**
 * A CDMA/EV-DO reading — `Evdo` is the ONE `Modem.Signal` dict MM defines `sinr` on.
 *
 * It exists so the SINR claim is proven against the dict that really carries it rather
 * than asserted against an LTE payload that never could.
 */
export const MM_EVDO_SIGNAL_FIXTURE: ModemManagerObservationInput = {
	modem: {
		Model: 'MC7354',
		Manufacturer: 'Sierra Wireless',
		State: 8,
		SignalQuality: [44, true],
	},
	signal: {
		Rate: 5,
		Evdo: signalDict({ rssi: -83, ecio: -2.5, sinr: 9.5, io: -95, 'error-rate': 0 }),
		Cdma: signalDict({ rssi: -83, ecio: -2.5, 'error-rate': 0 }),
		Gsm: [],
		Umts: [],
		Lte: [],
		Nr5g: [],
	},
};

/**
 * The `Modem.Signal` interface READ, with every RAT dict empty.
 *
 * This is the honest shape of a modem that has not reported extended signal yet — the
 * interface exists, the reading does not. It must never normalize to a zero.
 */
export const MM_SIGNAL_SILENT_FIXTURE: ModemManagerObservationInput = {
	modem: { Model: 'RM530N-GL', Manufacturer: 'Quectel', State: 8 },
	signal: { Rate: 5, Cdma: [], Evdo: [], Gsm: [], Umts: [], Lte: [], Nr5g: [] },
};

/**
 * A HiLink dongle answering both bodies.
 *
 * `<CurrentNetworkTypeEx>` and `<TotalDownload>` are the vendor-specific extras.
 */
export const HILINK_FIXTURE: HilinkObservationInput = {
	status: [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<response>',
		'<ConnectionStatus>901</ConnectionStatus>',
		'<SignalIcon>4</SignalIcon>',
		'<maxsignal>5</maxsignal>',
		'<SimStatus>1</SimStatus>',
		'<CurrentNetworkTypeEx>101</CurrentNetworkTypeEx>',
		'</response>',
	].join(''),
	signal: [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<response>',
		'<rssi>-65dBm</rssi>',
		'<rsrp>-101dBm</rsrp>',
		'<rsrq>-9dB</rsrq>',
		'<sinr>12dB</sinr>',
		'<cell_id>12345678</cell_id>',
		'<TotalDownload>987654321</TotalDownload>',
		'</response>',
	].join(''),
	netModeList: [
		'<response><NetworkModeList>',
		'<NetworkMode><Index>00</Index><Name>AUTO</Name></NetworkMode>',
		'<NetworkMode><Index>03</Index><Name>LTE</Name></NetworkMode>',
		'</NetworkModeList></response>',
	].join(''),
	netMode: '<response><NetworkMode>03</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand></response>',
};

/** A ZTE goform reading. `wan_lte_ca` and `lte_pci` are the vendor-specific extras. */
export const ZTE_FIXTURE: ZteObservationInput = {
	body: JSON.stringify({
		signalbar: '4',
		rssi: '-67',
		lte_rsrp: '-99',
		lte_rsrq: '-10',
		lte_snr: '7',
		network_type: 'LTE',
		network_provider_fullname: 'Movistar',
		cell_id: '0A1B2C',
		simcard_roam: 'Home',
		rmcc: '732',
		rmnc: '123',
		lte_pci: '188',
		wan_active_band: 'LTE BAND 4',
		wan_lte_ca: 'ca_deactivated',
	}),
};

/**
 * A UFI/HIMI reading across its three endpoints plus the product endpoint.
 *
 * `cputemp`, `wifinum` and `ethnum` are the vendor-specific extras; `IMSI` and
 * `ICCID` are present because the real overview endpoint returns them, and they are
 * what the redaction assertions exercise.
 */
export const UFI_FIXTURE: UfiObservationInput = {
	sysinfo: JSON.stringify({
		reply: 'ok',
		params: { SIGNAL: '3', cellid: '3344', bsid: '77', cputemp: '46', wifinum: '2', ethnum: '1' },
	}),
	overview: JSON.stringify({
		reply: 'ok',
		params: {
			SIGNAL: '3',
			SSID: 'CeraLive-UFI',
			WANIP: '10.64.12.9',
			IMSI: '732123456789012',
			ICCID: '8957010000000000001',
			WEBVER: 'V1.0.7',
		},
	}),
	status: JSON.stringify({ reply: 'ok', params: { signalStrength: '3', battery: '88' } }),
	produceInfo: JSON.stringify({ reply: 'ok', params: { productname: 'UFI-M600', hwver: 'A2' } }),
};

/** Every fixture's session refused — the auth-expired shape, per source. */
export const HILINK_AUTH_EXPIRED_FIXTURE: HilinkObservationInput = {
	status: '<response><code>125002</code><message>need login</message></response>',
	signal: '<response><code>125002</code><message>need login</message></response>',
	netModeList: '<response><code>125002</code></response>',
};

export const UFI_AUTH_EXPIRED_FIXTURE: UfiObservationInput = {
	sysinfo: JSON.stringify({ reply: 'SessionOut' }),
	overview: JSON.stringify({ reply: 'SessionOut' }),
	status: JSON.stringify({ reply: 'SessionOut' }),
};

export const ZTE_MALFORMED_FIXTURE: ZteObservationInput = { body: '<html>login</html>' };
