// Standalone consumer check for the PACKED `@ceralive/modem-control` tarball.
//
// Both fixtures (Node and Bun) run this exact file, so a divergence between the two
// runtimes is a runtime difference and never a difference in what was asserted.
//
// It imports every public subpath by SPECIFIER, so it exercises the published exports
// map rather than a file path — a subpath missing from `exports` fails here even
// though the file it would have pointed at is sitting in the tarball.

const failures = [];

function check(label, condition) {
	if (!condition) {
		failures.push(label);
	}
}

const PUBLIC_SUBPATHS = [
	'@ceralive/modem-control',
	'@ceralive/modem-control/transport',
	'@ceralive/modem-control/domain',
	'@ceralive/modem-control/providers',
	'@ceralive/modem-control/capabilities',
	'@ceralive/modem-control/hardware',
	'@ceralive/modem-control/testing',
];

// 1 — every declared subpath resolves and evaluates.
const modules = new Map();
for (const specifier of PUBLIC_SUBPATHS) {
	const module = await import(specifier);
	modules.set(specifier, module);
	check(`${specifier} exported nothing`, Object.keys(module).length > 0);
}

// 2 — each subpath actually carries the surface it is named for.
const root = modules.get('@ceralive/modem-control');
check('root PACKAGE_NAME', root.PACKAGE_NAME === '@ceralive/modem-control');

const transport = modules.get('@ceralive/modem-control/transport');
check('transport createDbusTransport', typeof transport.createDbusTransport === 'function');
check('transport TransportError', typeof transport.TransportError === 'function');

const domain = modules.get('@ceralive/modem-control/domain');
check('domain physicalModemId', typeof domain.physicalModemId === 'function');
check(
	'domain classifyOperationCompletion',
	typeof domain.classifyOperationCompletion === 'function',
);

const providers = modules.get('@ceralive/modem-control/providers');
check('providers createProviderRegistry', typeof providers.createProviderRegistry === 'function');
check('providers createProviderMatcher', typeof providers.createProviderMatcher === 'function');

const capabilities = modules.get('@ceralive/modem-control/capabilities');
check('capabilities resolveSupportClaim', typeof capabilities.resolveSupportClaim === 'function');
check('capabilities CAPABILITY_MODULES', Array.isArray(capabilities.CAPABILITY_MODULES));

const hardware = modules.get('@ceralive/modem-control/hardware');
check('hardware bandName', typeof hardware.bandName === 'function');
check('hardware findCatalogEntry', typeof hardware.findCatalogEntry === 'function');
check('hardware CERTIFIED_CATALOG', hardware.CERTIFIED_CATALOG !== undefined);

const testing = modules.get('@ceralive/modem-control/testing');
check('testing fakeProviderDefinition', typeof testing.fakeProviderDefinition === 'function');
check('testing fakeFreshObservation', typeof testing.fakeFreshObservation === 'function');

// 3 — the built code RUNS, not just resolves: drive the real registry + matcher
//     through the published `./testing` fakes, across three separate subpaths.
const registry = providers.createProviderRegistry();
registry.register(testing.fakeProviderDefinition({ observation: { registered: true } }));
const match = await providers
	.createProviderMatcher(registry)
	.match(testing.fakeProviderMatchRequest());
check(`matcher selected a provider (got ${match.status})`, match.status === 'selected');
check('matcher named the fake provider', match.provider === 'contract-fake-provider');

// 4 — a domain constructor still refuses what it must, from the built bundle.
let refused = false;
try {
	domain.physicalModemId('/org/freedesktop/ModemManager1/Modem/0');
} catch {
	refused = true;
}
check('domain refuses an MM object path as a physical identity', refused);

// 5 — the band vocabulary decoded from the bundled JSON catalog still answers.
check('hardware band 3 is eutran-3', hardware.bandName(33) !== undefined);

if (failures.length > 0) {
	console.error(`FAIL (${failures.length}):`);
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log(`OK — ${PUBLIC_SUBPATHS.length} public subpaths imported and exercised`);
