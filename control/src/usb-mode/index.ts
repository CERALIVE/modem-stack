// The certified USB-mode catalog — schema, data, and lookups.
//
// A6.1's bench CLI (`set-usb-mode`) and A6.2's `certify` tool both consume this: the
// CLI looks up the permitted transition for a target mode, `certify` validates a
// candidate entry against the schema before a human commits it.

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
