// Public surface of the repo-local conformance harness.
//
// Unpublished, like the rest of `test-support/`: it lives outside `control/src`, so
// `files: ["dist"]` cannot carry it to npm, and it is NOT the package's public
// `./testing` contract-fakes surface. Do not promote it to a package subpath.

export type {
	ConformanceCase,
	ConformanceExpectation,
	ConformanceKind,
	ConformanceRun,
	ScenarioOptions,
	ScenarioTranscripts,
} from './cases';
export {
	CONFORMANCE_CASES,
	FM350_USB_SPEC,
	observedExpectation,
	QUECTEL_SPEC,
	SIMCOM_SPEC,
} from './cases';
export {
	CONFORMANCE_CREDENTIALS,
	CORPUS_BODIES,
	HILINK_ADMIN_URL,
	HILINK_FIRMWARE,
	HILINK_PRIMARY_INTERFACE,
	HILINK_TOKENS,
	HILINK_TWIN_INTERFACE,
	type HilinkProfileId,
	type HilinkScript,
	hilinkDevice,
	hilinkLoginDocument,
	hilinkWirePassword,
	interfaceRoutedDevice,
	SANITIZED_SUBSCRIBER_IDENTIFIERS,
	UFI_ADMIN_URL,
	UFI_INTERFACE,
	UFI_SESSION,
	type UfiScript,
	USB_IDS,
	ufiDevice,
	ZTE_ADMIN_URL,
	ZTE_EVIDENCE_CMD,
	ZTE_INTERFACE,
	ZTE_LD,
	ZTE_LEGACY_PASSWORD,
	ZTE_MF79U_WA_VERSION,
	ZTE_SALTED_PASSWORD,
	ZTE_STOK,
	ZTE_TELEMETRY_CMD,
	type ZteScript,
	zteDevice,
} from './corpus';
export {
	absentDevice,
	type ExchangeBody,
	goformId,
	himiCommand,
	NOT_THIS_VENDOR,
	type RecordedExchange,
	type Recorder,
	recordHilink,
	recordUfi,
	recordZte,
	type ScriptedDevice,
	type ScriptedResponse,
} from './exchange';
export {
	MATRIX_JSON_PATH,
	MATRIX_MARKDOWN_PATH,
	type MatrixRow,
	writeMatrixArtifact,
} from './matrix-report';
export {
	decodeTree,
	FakeMmTransport,
	type FakeMmTransportOptions,
	type RecordedCall,
} from './mm-transport';
export {
	hilinkCookieFor,
	hilinkGet,
	hilinkLoginPost,
	hilinkOpenGet,
	ufiLoginPost,
	ufiReadPost,
	zteGet,
	ztePost,
} from './transcripts';
