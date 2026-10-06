# modem-stack

Parent: [CeraLive workspace rules](https://github.com/CERALIVE/ceralive/blob/master/AGENTS.md).

<!-- workspace-hard-rules:begin -->
## Workspace hard rules (identical in every CeraLive AGENTS.md)
- Commits and PRs carry the human author only: no Co-authored-by, no AI attribution.
- Start from the updated canonical branch; rebase to update; never `reset --hard` or discard others' work.
- One focused PR per repo, opened against CERALIVE/<repo>; the root policy PR merges first.
- A repo is self-contained: no path above its root; consume @ceralive packages from the registry, never link:/file:.
- Never delete, skip or weaken a test; every behavior change ships with a test.
- A user-visible change updates docs.ceralive.tv in English and Spanish (es-419), and any ceralive.tv claim it touches, in the same release.
- AGENTS.md holds rules and routing only, within budget; contracts and history live in docs/agents/.
- Full canon: https://github.com/CERALIVE/ceralive/blob/master/AGENTS.md
<!-- workspace-hard-rules:end -->

## ROLE

Standalone cellular-control library, bench CLI, ModemManager stack packaging and first-party modem-support companion.
TypeScript on Bun is the owner-decided implementation; no service is shipped by the npm library.

## STRUCTURE

- `control/` — published library, providers, schemas and tests
- `cli/` — bench CLI
- `packaging/` — pinned sources, Debian recipes and contract scripts
- `docs/` — engineering contracts and bench records
- `.github/` — CI and release workflows

## COMMANDS

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run --cwd control verify:tarball
bun run --cwd control verify:consumers
bash packaging/ci/contract.sh
```

Consumer fixtures require Node 26 (`CERALIVE_NODE_BIN` selects it). Run packaging contracts in Debian trixie, as CI does.
Release/build commands and suite-parity requirements: [toolchain contract](docs/agents/workspace-toolchain.md).
Do not run release or package-build commands for a documentation-only change.

## WHERE TO LOOK

| Code path or task | Contract |
|---|---|
| Before changing anything else here, open docs/agents/README.md and read the contract for the subsystem you touch | [All preserved subsystem contracts](docs/agents/README.md) |
| Artifacts and integration boundaries | [Artifact map](docs/agents/three-artifact-map.md) |
| `packaging/ceralive-modem-support/` | [Companion](docs/agents/first-party-companion-ceralive-modem-support.md) |
| Standalone paths and test artifacts | [Rule D](docs/agents/rule-d-self-contained-load-bearing.md) |
| Versions and release closure | [Versioning](docs/agents/versioning.md) |
| Wire schemas | [Domain contracts](docs/agents/frozen-v1-1-domain-contracts.md) |
| Provider identity and registry | [Evidence matcher](docs/agents/provider-registry-evidence-matcher.md) |
| Published npm exports | [Package surface](docs/agents/published-package-surface-built-esm-seven-subpaths-no-ser.md) |
| `packaging/upstream-pins.yaml` | [Provenance](docs/agents/provenance-pins-packaging.md) |
| Mutation locks and admission | [Ownership](docs/agents/mutation-admission-exclusive-ownership.md) |
| Operation descriptors | [Operation engine](docs/agents/descriptor-gated-operation-engine.md) |
| Transaction journal | [Journal](docs/agents/transaction-journal-path-parameterized-append-only-never.md) |
| Certification catalog | [Catalog](docs/agents/certification-evidence-catalog-evidence-gated-human-revie.md) |
| USB composition switches | [Composition](docs/agents/usb-composition-switch-runtime-offer-tiered-proof.md) |
| ModemManager controls | [D-Bus provider](docs/agents/modemmanager-provider-typed-d-bus-runtime-discovered-gene.md) |
| NetworkManager saved/applied state | [Network adapter](docs/agents/networkmanager-adapter-saved-vs-applied-and-nothing-else.md) |
| Huawei router | [HiLink](docs/agents/huawei-hilink-provider-todo-24.md) |
| ZTE router | [GOFORM](docs/agents/zte-goform-provider-todo-25.md) |
| Qualcomm router and QMI fences | [UFI/HIMI](docs/agents/ufi-himi-provider-todo-26-read-only-plus-the-qualcomm-pro.md) |
| Build toolchain | [Toolchain](docs/agents/workspace-toolchain.md) |
| `.github/workflows/` and upstream watch | [CI/CD](docs/agents/ci-cd.md) |
| Documentation changes | [Docs discipline](docs/agents/docs-discipline-rule-a.md) |

## HARD RULES

- Use SemVer, not CalVer; published versions and assets are immutable.
- Absent `closure_version:` IS version 1; the v0.2.0 fixture must never gain a header. Version-1 artifacts stay unchanged.
- Differential releases keep `closure_version: 2`; untouched upstream sources carry forward byte-identically with their existing counter.
- Rebuilt upstream sources increment their own `~ceralive.N` counter, not a release-wide counter.
- Never hardcode closure counts 9/18/19/20; derive counts from the frozen closure matrix.
- `ceralive-modem-support` is ONE immutable `Architecture: all` asset with TWO index memberships; never build it per-arch.
- The companion always rebuilds at the tag's bare SemVer, with no `~ceralive` suffix or counter.
- Never reuse image-owned `/etc/udev/rules.d/` basenames for companion rules; `/etc` would silently shadow packaged rules.
- Upstream pins are watched, never auto-bumped; the watcher opens issues only and never dispatches builds.
- No paths above the checkout root; published dependencies resolve from registries, never sibling links.
- Import producer-owned wire types from published packages; publish schema changes before a consumer merges.
- Mutation requires descriptor admission, exclusive ownership and bounded verified rollback; discovery is not capability proof.
- Band locks require the modem's own radio catalog; never infer supported bands from model names.
- SMS stays list/read only; GPS stores no history; UFI/HIMI stays read-only with the Qualcomm prohibition fences.
- Build and target suites must match; native amd64 or full-system-QEMU arm64 only, never cross-build release packages.
- Release inputs resolve to an immutable peeled tag SHA; never overwrite published assets or bypass test-before-publish.
