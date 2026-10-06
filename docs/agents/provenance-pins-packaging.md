<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## PROVENANCE PINS (packaging)

The four rebuilt sources are pinned in `packaging/upstream-pins.yaml`, re-verified end-to-end
by `packaging/ci/verify-upstream-pins.sh` in an isolated `GNUPGHOME`. Current pins:

| Source | Upstream | Salsa packaging tag |
|--------|----------|---------------------|
| ModemManager | 1.24.2 | `debian/1.24.2-2` |
| libmbim | 1.34.0 | `debian/1.34.0-1` |
| libqmi | 1.38.0 | `debian/1.38.0-1` |
| libqrtr-glib | 1.4.0 | `debian/1.4.0-1` |

Each pin carries a **four-link provenance chain**, all re-checked and failing closed with a
named field on any drift:

1. **Lineage** — the upstream git tag object + peeled commit SHA (`git ls-remote`; the tag is
   never byte-compared to a git archive).
2. **Authority** — the signed Debian `.dsc`, GPG-verified against a pinned signer fingerprint
   whose armored key lives in `packaging/keys/` (mapping in `packaging/keys/README.md`).
3. **Artifact** — the `.orig.tar`, whose sha256 equals the verified `.dsc`'s
   `Checksums-Sha256` entry.
4. **Packaging** — the `.debian.tar.xz`, whose sha256 equals the `.dsc`, and whose extracted
   `debian/` tree is proven byte-identical to the pinned salsa tag via a canonical metadata
   manifest (path, file type, exec-bit, symlink target, content sha256 per entry).

The container build additionally enforces the finalized **two-set package model** (declared
arch-dependent stanzas + enumerated `-dbgsym`) for exact per-source set **equality** via
`packaging/ci/check-package-sets.sh` (add/remove/rename fails closed). Full detail:
`packaging/README.md`.

**The pins are watched, never auto-bumped.** `.github/workflows/upstream-watch.yml` runs
weekly (plus `workflow_dispatch`) and calls `packaging/ci/check-upstream-freshness.sh`, which
enumerates each source's upstream release tags and salsa `debian/*` packaging tags via
`git ls-remote --tags`, filters the development series out, and compares the survivors to the
four pins above. On `behind` it opens **or updates** ONE issue labelled `upstream-freshness`,
and closes it when everything is current again. It is **issue-only**: it never edits
`upstream-pins.yaml` and never dispatches a build, which is why it is the only workflow here
holding `issues: write` and no dispatch token. A newer upstream release with no matching
Debian packaging tag reports the distinct `upstream-ahead-no-packaging` — there is no
`<upstream>-<rev>` pair to pin, so there is no bump to recommend.

