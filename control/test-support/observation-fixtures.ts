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
 * A registered ModemManager modem.
 *
 * `Modem.Ports` and `Modem3gpp.Pco` are the vendor-specific extras here: real MM
 * properties that this layer's normalized model has no slot for.
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
		Pco: 'dns-primary=10.0.0.1',
	},
	sim: {
		SimType: 1,
		EsimStatus: 0,
		OperatorName: 'CLARO COL',
	},
	signal: {
		rssi: -71,
		rsrp: -98.5,
		rsrq: -11,
		snr: 6.5,
		refresh_rate: 5,
	},
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
