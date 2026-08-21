# Versioning — modem-stack

This repository is the documented **exception** to the CeraLive CalVer canon
(`YYYY.MINOR.PATCH`). It uses **Semantic Versioning** instead, because it ships an npm
package (`@ceralive/modem-control`) that is consumed as a normal registry dependency and
because it repackages upstream projects that carry their own upstream version lines.

## One tag, both artifacts

There is **ONE unified release tag** per release:

```
vX.Y.Z
```

Pushing/dispatching `vX.Y.Z` releases **both** artifacts together:

- `@ceralive/modem-control@X.Y.Z` → the public npm registry.
- the ModemManager-stack `.deb` artifact set → CI artifacts (+ a release manifest).

There is **no** separate packaging tag and **no** separate release-packaging workflow.
A single release workflow (`.github/workflows/release.yml`) owns both.

`0.x` is the iteration line (breaking changes allowed between minors while the API
settles). `1.0.0` is reserved for Phase-B adoption.

## SemVer, not CalVer

Do **not** apply the CalVer scheme here. The rationale, and the parallel exception for
`srtla-send-rs`, are the two recorded departures from the workspace-wide CalVer
convention. Everything in this repo — the git tag, the npm version, and the `~ceralive`
suffix below — is SemVer.

## `.deb` version encoding — per-source rebuild counters

The `.deb` internal `Version:` field must stay **upstream-ordered** so `apt` compares
releases correctly, while still recording that this is a CeraLive rebuild and how many
times that particular source has been rebuilt. The encoding is:

```
<upstream>-<rev>~ceralive.N
```

`N` is that **source's own rebuild counter**, not the release tag. Releases are
differential: only the sources whose inputs actually moved are rebuilt, and only a rebuilt
source's counter advances. Release provenance lives in the release manifest; the package
version records the rebuild count.

- A **rebuilt** source takes its previous counter **+ 1**. The previous counter is derived
  from the previous release manifest's rows for that source, by
  `packaging/ci/inject-deb-version.sh`.
- An **untouched (carried-forward)** source keeps whatever counter it already had. Its
  `.deb`s are the byte-identical artifacts from the release that last built them; they are
  **not** re-stamped with the new release's tag. Builds are not reproducible, so reusing
  recorded bytes is the only honest way to keep a release self-contained.
- Different sources therefore legitimately carry **different** counters within one release.
  That is the normal shape of a differential release, not drift.

Counter derivation is **coherence-checked and fail-closed**. Every previous-manifest row
for the source is read — both arches, `role=runtime` and `role=aux` alike — and the counter
is accepted only if all of them agree. Three conditions refuse the release outright, each
naming the offending source:

| Condition | Why it refuses |
|-----------|----------------|
| rows disagree on the counter (`.2` vs `.3`) | picking either risks publishing a downgrade |
| rows mix counter and legacy `~ceraliveX.Y.Z` suffixes | the source's history is ambiguous |
| a row's suffix is neither `~ceralive.[1-9][0-9]*` nor `~ceraliveX.Y.Z` | malformed input |

Two cases **bootstrap at `.1`** instead: a source whose previous-manifest rows are entirely
legacy, and a rebuild with no previous manifest at all (the force-all bootstrap).

The current pins are ModemManager 1.24.2 (revision `-2`), libmbim 1.34.0, libqmi 1.38.0 and
libqrtr-glib 1.4.0 (all `-1`), so a release that rebuilt only libqmi while the other three
carried forward from `.1` would produce:

| Source | Rebuilt? | Encoded `.deb` version |
|--------|----------|------------------------|
| ModemManager  | carried  | `1.24.2-2~ceralive.1` |
| libmbim       | carried  | `1.34.0-1~ceralive.1` |
| libqmi        | rebuilt  | `1.38.0-1~ceralive.2` |
| libqrtr-glib  | carried  | `1.4.0-1~ceralive.1`  |

> The authoritative pin manifest is `packaging/upstream-pins.yaml`; the release workflow
> derives `<upstream>-<rev>` from each source's `debian/changelog`, never from a value
> hardcoded in the version script.

### The legacy suffix, and the migration into counters

Every release through `v0.2.0` used a different scheme: one `~ceralive<X.Y.Z>` suffix,
identical across all four sources, taken from the release tag. Those artifacts are
published and unchanged — `1.24.2-2~ceralive0.2.0` is still exactly what a fleet device has
installed. What changed is what the pipeline produces from here on.

There is no release that mixes the two schemes. The first release built from the
differential pipeline **force-rebuilds every source at `.1`**, because this effort's own
changes under `packaging/ci/**` are a shared build input, and a shared-input change in the
diff against the last published release force-alls on its own. So the transition happens in
one release, for all four sources at once, and no manifest ever carries a legacy suffix
beside a counter suffix.

### Why the tilde (`~`), and why the chain still orders

`dpkg` orders a `~` suffix **lower** than the un-suffixed version, and orders the counter
suffix above every legacy one. The full **migration-continuity chain**, exactly as
`packaging/ci/suffix-contract.sh` proves it:

```
<base>~ceralive0.2.0 < <base>~ceralive1.0.0 < <base>~ceralive1.1.0
  < <base>~ceralive.1 < <base>~ceralive.2 < <base>~ceralive.10 < <base>
```

(`<base>` is the source's `<upstream>-<rev>`, e.g. `1.24.2-2`.) Its legacy members are every
version that exists as a published artifact today, so the chain is the proof that a fleet
device upgrades cleanly from any shipped release into the counter scheme, and that every
CeraLive rebuild still sorts **below** a hypothetical stock Debian `1.24.2-2`.

Nothing here is asserted on paper. `prove_chain_ordered` runs the whole chain through real
`dpkg --compare-versions`, and it is exercised from both lanes: the host-runnable
`packaging/ci/test-suffix-coherence-manifest.sh` (which also carries a non-vacuity control
showing a lexical compare inverts `.2` against `.10`) and the container suite
`packaging/ci/test-package-contract.sh` CHECK 6. CHECK 5 is the coherence half — sources at
differing counters pass, a source disagreeing with **itself** fails closed naming that
source.

Tilde ordering is also why the workflow injects with `dch --force-bad-version`: the
tilde-encoded version is numerically **lower** than the pinned `<upstream>-<rev>` changelog
top, and plain `dch --newversion` refuses a lower-than-current version (per `dch(1)`).
`--force-bad-version` is **required**, not optional.

The exact injection command, run once per **rebuilt** source, is:

```sh
dch --force-bad-version --newversion "<upstream>-<rev>~ceralive.N" "CeraLive rebuild"
```

### The manifest header states the scheme, not a value

Under per-source counters no single suffix value is truthful for a release, so the release
manifest carries:

```
suffix_scheme: per-source-counter
```

and **no `deb_version_suffix:` header** — that field no longer exists in any manifest this
repo produces. Every row keeps carrying its own version, which it always did (rows are
parsed from real filenames), so a carried-forward deb at an old counter and a freshly built
one at a new counter both emit correctly. `version:` is unrelated and stays: it is the
release's own SemVer, not a per-deb suffix.

### The companion is outside this scheme entirely

`ceralive-modem-support` is a first-party native package with no upstream version to order
against. It takes the repo's SemVer tag **verbatim** (`v1.1.0` → `1.1.0`) with no
`~ceralive` suffix at all, and it is **always rebuilt** — it is never detected, never
verdicted, and never carried forward. That is unrelated to the counter scheme, and neither
rule affects the other.

## Tag guard (fail-closed)

The release workflow's **first** job validates the input tag against:

```
^v\d+\.\d+\.\d+$
```

Anything that does not match **fails closed before any other job runs**. In particular:

| Input | Result | Why |
|-------|--------|-----|
| `v1.0.0` | ✅ accepted | canonical `vX.Y.Z` |
| `v1.0.0-rc.1` | ❌ rejected | a pre-release tag inverts dpkg ordering — the companion takes the tag verbatim, and `dpkg` reads the `-rc.1` as a Debian revision, so the rc would sort **above** the final `1.0.0`, which is wrong |
| `v1.0.0+build5` | ❌ rejected | build metadata has no meaning in a `.deb` version and is not part of the contract |
| `1.0.0` | ❌ rejected | missing the `v` prefix |

The negative cases are locked by an executable test, `packaging/ci/test-tag-guard.sh`,
which asserts the regex in `packaging/ci/tag-guard.sh` accepts only the `vX.Y.Z` shape.

## Non-tag (dev) builds

CI builds that are **not** a release tag (ordinary PR/branch packaging runs) use a fixed
dev version:

```
~ceralive0.0.0~dev
```

i.e. `<upstream>-<rev>~ceralive0.0.0~dev`, which sorts below every real release
(`0.0.0~dev < 0.1.0`) and is never published.

## npm version provenance

Following the house OIDC pattern, the npm publish job is **not** version-injected: it
verifies that `control/package.json` `version` **equals** the tag's `X.Y.Z` and fails
closed on any mismatch before publishing. To cut a release, bump `control/package.json`
`version`, commit, then create the matching `vX.Y.Z` tag. The `.deb` side is injected
(above); the npm side is verified — both are driven by the same tag.
