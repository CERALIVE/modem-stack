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

## `.deb` version encoding

The `.deb` internal `Version:` field must stay **upstream-ordered** so `apt` compares
releases correctly, while still encoding which repo tag produced the rebuild. The
encoding is:

```
<upstream>-<rev>~ceralive<X.Y.Z>
```

For the current pins at repo tag `v0.2.0` (the latest release — the ModemManager revision
is `-2`, the other three `-1`):

| Source | Upstream | Encoded `.deb` version |
|--------|----------|------------------------|
| ModemManager  | 1.24.2 | `1.24.2-2~ceralive0.2.0` |
| libmbim       | 1.34.0 | `1.34.0-1~ceralive0.2.0` |
| libqmi        | 1.38.0 | `1.38.0-1~ceralive0.2.0` |
| libqrtr-glib  | 1.4.0  | `1.4.0-1~ceralive0.2.0`  |

> The upstream versions above are the current provenance-verified pins. The authoritative
> manifest is `packaging/upstream-pins.yaml`; the release workflow derives `<upstream>-<rev>`
> from each source's `debian/changelog`, never from a value hardcoded in the version script.

### Why the tilde (`~`)

`dpkg` orders a `~` suffix **lower** than the un-suffixed version:

```
1.24.2-2~ceralive0.1.0  <  1.24.2-2~ceralive0.2.0  <  1.24.2-2
```

So every CeraLive rebuild sorts **below** a hypothetical stock Debian `1.24.2-2`, and a
newer repo tag (`0.2.0`) sorts **above** an older one (`0.1.0`) — exactly the ordering
`apt` needs. This is why the release workflow injects the version with
`dch --force-bad-version`: the tilde-encoded version is numerically **lower** than the
pinned `<upstream>-<rev>` changelog top, and plain `dch --newversion` refuses a
lower-than-current version (per `dch(1)`). `--force-bad-version` is **required**, not
optional.

The exact injection command, run once per source, is:

```sh
dch --force-bad-version --newversion "<upstream>-<rev>~ceralive<X.Y.Z>" "CeraLive rebuild"
```

All four sources take the **same** `~ceralive<X.Y.Z>` suffix for a given release.

## Tag guard (fail-closed)

The release workflow's **first** job validates the input tag against:

```
^v\d+\.\d+\.\d+$
```

Anything that does not match **fails closed before any other job runs**. In particular:

| Input | Result | Why |
|-------|--------|-----|
| `v1.0.0` | ✅ accepted | canonical `vX.Y.Z` |
| `v1.0.0-rc.1` | ❌ rejected | a pre-release tag inverts dpkg ordering — the rc's tilde-encoded version would outrank the final release (`~ceralive1.0.0-rc.1` vs `~ceralive1.0.0`), which is wrong |
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
