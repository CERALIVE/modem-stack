// `@ceralive/modem-control/testing` — the PUBLIC contract-fakes surface.
//
// A consumer testing against this package needs valid instances of the frozen v1.1
// domain and provider contracts (`../domain`, `../providers`). Hand-rolling them is
// how a consumer's fixtures come to disagree with the package: a hand-written
// `OperationResult` literal quietly stops matching what `classifyOperationCompletion`
// actually returns, and a hand-written envelope invents a value for an unavailable
// read. Every fake here is built through the package's own constructors and
// classifiers, so it cannot express a shape the domain refuses.
//
// This is NOT `control/test-support/`. That directory holds this repo's own heavy
// internals — an MM-faithful fake D-Bus service on a private session bus and a
// stateful `nmcli` harness. It lives outside `src`, is not published, and is not a
// reusable public surface. This entry is pure data and functions: no bus, no daemon,
// no process, no filesystem.

export * from './domain-fakes';
export * from './provider-fakes';
