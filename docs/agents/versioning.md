<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## VERSIONING

SemVer, **not** CalVer — this repo is the documented exception (alongside `srtla-send-rs`).
ONE unified tag `vX.Y.Z` releases **both** artifacts: `@ceralive/modem-control@X.Y.Z` on
npm and the `.deb` set. Non-tag CI builds use `~ceralive0.0.0~dev`. Full contract:
`docs/VERSIONING.md`.

**`.deb` versions no longer encode the tag.** Releases are DIFFERENTIAL, so each upstream
source carries its own rebuild counter: `<upstream>-<rev>~ceralive.N` (upstream-ordered,
apt-safe; injected with `dch --force-bad-version`). A REBUILT source takes its previous
counter + 1, derived from the previous release manifest's rows for that source; an
UNTOUCHED source is carried forward byte-identically and keeps the counter it already had,
never re-stamped with the new tag. Two sources at different counters in one release is the
normal shape, not drift — coherence is a PER-SOURCE property, and a source disagreeing with
ITSELF fails closed naming that source. Derivation reads every row of a source (both arches,
runtime and aux) and refuses on a counter disagreement, a counter/legacy mixture, or a
malformed suffix; entirely-legacy rows and an absent previous manifest bootstrap at `.1`.

The pre-`v1.0.0` releases WERE built with one uniform `~ceralive<X.Y.Z>` suffix shared by all
four sources; those published artifacts are unchanged. No release mixes the two schemes — the
first differential release force-rebuilds every source at `.1`, because this effort's own
`packaging/ci/**` changes are a shared build input and force-all on their own. The
migration-continuity chain `~ceralive0.2.0 < ~ceralive1.0.0 < ~ceralive1.1.0 < ~ceralive.1 <
~ceralive.2 < ~ceralive.10 < <upstream>-<rev>` is proven with real `dpkg --compare-versions`
by the ONE sourced library `packaging/ci/suffix-contract.sh`, from both
`test-suffix-coherence-manifest.sh` (host) and `test-package-contract.sh` CHECK 5/6
(container). The release manifest states `suffix_scheme: per-source-counter` and carries **no
`deb_version_suffix:`** — under per-source counters no single suffix value is truthful. The
companion `ceralive-modem-support` stays outside this entirely: bare SemVer tag version, no
`~ceralive` suffix, and always rebuilt.

