// The certified USB-mode catalog — schema, data, lookups, and the evidence-bundle
// ingestion seam.
//
// A6.1's bench CLI (`set-usb-mode`) and A6.2's `certify` tool both consume this: the
// CLI looks up the permitted transition for a target mode, `certify` validates a
// candidate entry against the schema before a human commits it.
//
// The ingestion seam (`./ingestion`, `./promotion-review`) is the documented path from a
// captured `certify` bundle to a reviewed catalog commit — see `docs/CATALOG-INGESTION.md`.
// It refuses a `synthetic: true` bundle for catalog promotion, by construction.

export {
	CERTIFIED_CATALOG,
	findCatalogEntry,
	findPermittedTransition,
	loadCertifiedCatalog,
} from './catalog';
export {
	CANONICAL_USB_MODES,
	type CanonicalUsbMode,
	type CatalogEntry,
	type CertifiedCatalog,
	catalogEntrySchema,
	certifiedCatalogSchema,
	type ExpectedDescriptors,
	expectedDescriptorsSchema,
	MM_USB_MODES,
	type MmUsbMode,
	type PermittedTransition,
	permittedTransitionSchema,
	type SkuDiscriminator,
} from './catalog-schema';
export {
	buildCatalogEntryCandidate,
	buildClassifierFixture,
	type CatalogClaim,
	CLAIMABLE_CANONICAL_MODES,
	type ClassifierFixture,
	type EvidenceBundleView,
	evidenceBundleViewSchema,
	type FixtureProvenance,
	type IngestionOutcome,
	type IngestionRefusal,
	type IngestionRefusalReason,
	type IngestionRequest,
	parseIngestionRequest,
} from './ingestion';
export {
	type PromotionContext,
	type PromotionRequest,
	renderPromotionReview,
} from './promotion-review';
export {
	buildRuntimeCompositionSetCommand,
	isRuntimeCompositionVendor,
	RUNTIME_COMPOSITION_QUERY_REGISTRY,
	RUNTIME_COMPOSITION_SET_REGISTRY,
	RUNTIME_COMPOSITION_VENDORS,
	type RuntimeCompositionCapability,
	type RuntimeCompositionMode,
	type RuntimeCompositionQuery,
	type RuntimeCompositionResponse,
	type RuntimeCompositionSetCommand,
	type RuntimeCompositionVendor,
	readRuntimeCompositionCurrent,
	resolveRuntimeCompositionCapability,
} from './runtime-capability';
export {
	type ParsedUsbDevice,
	type ParsedUsbInterface,
	parseUsbDevices,
	selectUniqueDevice,
} from './usb-devices-parse';
