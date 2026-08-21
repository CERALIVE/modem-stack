#!/usr/bin/env bash
# detect-changed-sources.sh — which upstream packaging sources actually changed since the
# previous release, and therefore need rebuilding.
#
# WHAT THIS IS
#   The FIRST script of the differential-release pipeline. A `vX.Y.Z` release should rebuild
#   only the sources whose inputs moved; every other source's .debs are carried forward
#   byte-identically from the release that last built them (builds are NOT reproducible, so an
#   unchanged source must reuse recorded bytes and can never be rebuilt at its old version).
#   This script makes ONLY the verdict; staging, building and manifest generation are elsewhere.
#
# OUTPUT (stdout — the machine contract; consumers grep these exact lines)
#   libqrtr-glib=changed|unchanged
#   libmbim=changed|unchanged
#   libqmi=changed|unchanged
#   modemmanager=changed|unchanged
#   mode=differential|force-all
#
#   Source names are the upstream-pins.yaml PIN KEYS (lowercase `modemmanager`), not the
#   packaging directory names (`ModemManager`) — the mapping is NON-IDENTITY and is the same
#   one build-bookworm.sh's `pin_key()` and read-pin.sh's `recipe_dir()` carry. Lines are
#   emitted in BOOTSTRAP ORDER, so a consumer can build the selected set by reading top to
#   bottom. Every human-readable reason goes to STDERR, so stdout stays parseable.
#
# THE VERDICT
#   A source is `changed` when the diff `<prev>..HEAD` touched either
#     * `packaging/<Source>/**`                    — its checked-in debian/ recipe, or
#     * that source's own block in `packaging/upstream-pins.yaml` — compared BLOCK-SCOPED, so a
#       comment edit or a neighbouring source's pin bump does not implicate it.
#
# FORCE-ALL (every source `changed`, `mode=force-all`, reason logged)
#   1. A SHARED INPUT changed — `packaging/ci/**` (which subsumes `ci/expected-packages.txt`)
#      or `packaging/BOOKWORM-ADAPTATIONS.md`. These feed every source's build, so a change to
#      one of them invalidates every carried artifact.
#   2. The previous release is ABSENT, or carries no manifest asset. With no manifest there is
#      nothing to carry forward from, so rebuilding everything is the only honest answer.
#   3. The previous manifest is V1-SHAPED — it carries no `closure_version:` header. An ABSENT
#      header IS closure version 1 (that default is apt-worker's backward-compatibility
#      mechanism, `modem_manifest_closure_version`), and a v1 manifest predates the companion
#      row this pipeline depends on.
#   4. `FORCE_REBUILD=all` — the operator's escape hatch.
#   Fail-SAFE here means REBUILD EVERYTHING, never "assume unchanged": a wrong `unchanged`
#   ships stale bytes, a wrong `changed` only costs build time.
#
# THE COMPANION IS NOT PART OF DETECTION
#   `ceralive-modem-support` is never enumerated and never verdicted — it ALWAYS rebuilds
#   (apt-worker's health check greps `^Version: <pin>$`, which only the companion's bare
#   version can satisfy). A companion-only change therefore leaves all four sources
#   `unchanged`; that is correct, not a miss.
#
# PREVIOUS-RELEASE RESOLUTION — `gh release list`, NEVER `git describe`
#   `git describe` answers "nearest tag in this history", which is not the same question: a tag
#   can exist with no release, a release can be a draft or a pre-release, and a release can
#   carry no manifest asset. The previous release is the latest PUBLISHED release, so it is
#   resolved through `gh`. `PREV_TAG` overrides the resolution outright.
#
# SEAMS (all optional; they exist so the contract test runs offline, with no gh and no network)
#   PREV_TAG            Use this tag as the previous release; skips `gh release list`.
#   PREV_MANIFEST_FILE  Read the previous release manifest from this local path; skips
#                       `gh release download`. Set-but-unreadable is a hard error (exit 2), not
#                       a force-all — a named seam pointing at nothing is operator error, and
#                       silently force-alling would hide it.
#   FORCE_REBUILD=all   Force-all (rule 4).
#   HEAD_REF            The current side of the diff (default `HEAD`).
#   GH_REPO             Passed to `gh --repo` when resolving/downloading (default: gh's own
#                       repo inference from the checkout).
#
# USAGE
#   detect-changed-sources.sh [--out <file>]
#     --out <file>  additionally write the stdout contract lines to <file> (for a later job
#                   step to source); the file is written atomically-enough for CI (truncate+write).
#
# EXIT
#   0  verdicts printed (differential OR force-all — force-all is a normal outcome, not an error).
#   2  usage / environment error: not a git repo, unreadable pin manifest, unresolvable HEAD ref,
#      a set-but-unreadable PREV_MANIFEST_FILE, or a pinned-source set that no longer matches the
#      declared bootstrap order. Every one names the offending field.
set -euo pipefail

LOG_PREFIX="detect-changed-sources"
log() { printf '%s: %s\n' "$LOG_PREFIX" "$*" >&2; }
die() {
	printf '%s: %s\n' "$LOG_PREFIX" "$*" >&2
	exit 2
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"

# ---- arguments -----------------------------------------------------------------------------
OUT_FILE=""
while [ $# -gt 0 ]; do
	case "$1" in
	--out)
		shift
		[ $# -gt 0 ] || die "--out requires a file path"
		OUT_FILE="$1"
		;;
	--out=*) OUT_FILE="${1#--out=}" ;;
	-h | --help)
		echo "usage: detect-changed-sources.sh [--out <file>]"
		exit 0
		;;
	*) die "unknown argument '$1' (usage: detect-changed-sources.sh [--out <file>])" ;;
	esac
	shift
done

# ---- repository + packaging paths ----------------------------------------------------------
PINS="$PKG_ROOT/upstream-pins.yaml"
[ -r "$PINS" ] || die "cannot read pin manifest '$PINS'"

repo_top="$(git -C "$PKG_ROOT" rev-parse --show-toplevel 2>/dev/null)" ||
	die "packaging root '$PKG_ROOT' is not inside a git repository (a diff needs one)"
REPO_ROOT="$(cd "$repo_top" && pwd)"
cd "$REPO_ROOT"

# Repo-RELATIVE packaging prefix, derived rather than hardcoded, so the same script works from
# any checkout layout (and from the contract test's throwaway fixture repo).
PKG_REL="${PKG_ROOT#"$REPO_ROOT"/}"
[ "$PKG_REL" != "$PKG_ROOT" ] || die "packaging root '$PKG_ROOT' is not under repository root '$REPO_ROOT'"
PINS_REL="$PKG_REL/upstream-pins.yaml"

# ---- contract constants (mirrored from build-bookworm.sh:41,46) -----------------------------
# Bootstrap order — the order a differential build must walk the selected set in.
BUILD_ORDER=(libqrtr-glib libmbim libqmi ModemManager)
# packaging dir -> upstream-pins.yaml source key. NON-IDENTITY: only ModemManager differs.
pin_key() { case "$1" in ModemManager) echo modemmanager ;; *) echo "$1" ;; esac; }

# The list of source names under `sources:` — byte-identical to read-pin.sh's /
# verify-upstream-pins.sh's reader, deliberately the SAME parser rather than a second one.
yaml_sources() {
	awk '
		/^sources:[ \t]*$/ { ins=1; next }
		ins && /^[^ ]/ { ins=0 }
		ins && /^  [^ ]+:[ \t]*$/ { s=$0; sub(/^  /, "", s); sub(/:[ \t]*$/, "", s); print s }
	' "$PINS"
}

# One source's block of the pin manifest, read from stdin. Block-scoped so a comment edit or a
# neighbouring source's bump cannot implicate this source.
pins_block() { # <source-key>  (manifest text on stdin)
	awk -v src="$1" '
		$0 ~ "^  " src ":[ \t]*$" { inblk=1; print; next }
		inblk && /^  [^ ]/ { inblk=0 }
		inblk && /^[^ ]/   { inblk=0 }
		inblk { print }
	'
}

# The pinned set and the declared bootstrap set must agree. A fifth pinned source added without
# updating this detector would otherwise be silently un-detected — i.e. carried forward forever.
pinned_sorted="$(yaml_sources | LC_ALL=C sort)"
declared_sorted="$(for d in "${BUILD_ORDER[@]}"; do pin_key "$d"; done | LC_ALL=C sort)"
if [ "$pinned_sorted" != "$declared_sorted" ]; then
	die "pinned source set in '$PINS_REL' != declared BUILD_ORDER set — pinned: [$(echo "$pinned_sorted" | tr '\n' ' ')] declared: [$(echo "$declared_sorted" | tr '\n' ' ')]"
fi

# ---- shared-input classifier ---------------------------------------------------------------
# `packaging/ci/**` subsumes ci/expected-packages.txt; both are named in the header on purpose.
is_shared_input() {
	case "$1" in
	"$PKG_REL"/ci/*) return 0 ;;
	"$PKG_REL"/BOOKWORM-ADAPTATIONS.md) return 0 ;;
	esac
	return 1
}

# ---- resolution ----------------------------------------------------------------------------
FORCED=0
FORCE_REASON=""
PREV_TAG_RESOLVED=""
HEAD_REF_RESOLVED="${HEAD_REF:-HEAD}"
CHANGED_FILES=""
MANIFEST_TMP=""

cleanup() { [ -n "$MANIFEST_TMP" ] && rm -rf "$MANIFEST_TMP"; return 0; }
trap cleanup EXIT

force() {
	FORCED=1
	FORCE_REASON="$*"
}

gh_args() {
	if [ -n "${GH_REPO:-}" ]; then printf '%s\n%s\n' "--repo" "$GH_REPO"; fi
}

resolve() {
	# (4) Operator override, checked first so it needs no network and no previous release.
	if [ "${FORCE_REBUILD:-}" = "all" ]; then
		force "FORCE_REBUILD=all — operator override"
		return
	fi
	if [ -n "${FORCE_REBUILD:-}" ]; then
		die "FORCE_REBUILD='$FORCE_REBUILD' is not a recognized value (the only accepted value is 'all')"
	fi

	# --- previous release tag ---------------------------------------------------------------
	if [ -n "${PREV_TAG:-}" ]; then
		PREV_TAG_RESOLVED="$PREV_TAG"
		log "previous release tag: $PREV_TAG_RESOLVED (PREV_TAG seam)"
	else
		if ! command -v gh >/dev/null 2>&1; then
			force "previous-release-unresolved — PREV_TAG is unset and 'gh' is not installed (the previous release is the latest PUBLISHED release, resolved via 'gh release list'; 'git describe' is never used)"
			return
		fi
		local ghargs=() tag=""
		mapfile -t ghargs < <(gh_args)
		if ! tag="$(gh release list "${ghargs[@]}" --limit 1 --exclude-drafts --exclude-pre-releases --json tagName --jq '.[0].tagName' 2>/dev/null)"; then
			force "previous-release-unresolved — 'gh release list' failed"
			return
		fi
		tag="$(printf '%s' "$tag" | tr -d '[:space:]')"
		if [ -z "$tag" ] || [ "$tag" = "null" ]; then
			force "previous-release-absent — 'gh release list' reports no published release to diff against"
			return
		fi
		PREV_TAG_RESOLVED="$tag"
		log "previous release tag: $PREV_TAG_RESOLVED (gh release list)"
	fi

	# --- previous release manifest ------------------------------------------------------------
	local manifest=""
	if [ -n "${PREV_MANIFEST_FILE:-}" ]; then
		[ -r "$PREV_MANIFEST_FILE" ] ||
			die "PREV_MANIFEST_FILE='$PREV_MANIFEST_FILE' is set but not readable (a named seam pointing at nothing is operator error, not a force-all)"
		manifest="$PREV_MANIFEST_FILE"
		log "previous release manifest: $manifest (PREV_MANIFEST_FILE seam)"
	else
		if ! command -v gh >/dev/null 2>&1; then
			force "previous-manifest-absent — 'gh' is not installed, so release '$PREV_TAG_RESOLVED' manifest cannot be fetched"
			return
		fi
		local ghargs=()
		mapfile -t ghargs < <(gh_args)
		MANIFEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/detect-changed-sources.XXXXXX")"
		if ! gh release download "$PREV_TAG_RESOLVED" "${ghargs[@]}" --pattern 'release-manifest*.txt' --dir "$MANIFEST_TMP" >/dev/null 2>&1; then
			force "previous-manifest-absent — release '$PREV_TAG_RESOLVED' has no downloadable release-manifest asset"
			return
		fi
		manifest="$(find "$MANIFEST_TMP" -maxdepth 1 -type f -name 'release-manifest*.txt' | LC_ALL=C sort | head -n1)"
		if [ -z "$manifest" ]; then
			force "previous-manifest-absent — 'gh release download' produced no release-manifest*.txt for '$PREV_TAG_RESOLVED'"
			return
		fi
		log "previous release manifest: $manifest (gh release download from $PREV_TAG_RESOLVED)"
	fi

	# (3) An ABSENT `closure_version:` header IS closure version 1 — apt-worker's
	# `modem_manifest_closure_version` treats it exactly that way, and that default is the
	# backward-compatibility mechanism for every pre-header release.
	if ! grep -q '^closure_version:' "$manifest"; then
		force "previous-manifest-v1-shaped — '$manifest' carries no 'closure_version:' header (an absent header IS closure version 1), so nothing may be carried forward from it"
		return
	fi

	# --- the diff -----------------------------------------------------------------------------
	git rev-parse --verify --quiet "$HEAD_REF_RESOLVED^{commit}" >/dev/null ||
		die "HEAD ref '$HEAD_REF_RESOLVED' does not resolve to a commit in '$REPO_ROOT'"
	if ! git rev-parse --verify --quiet "$PREV_TAG_RESOLVED^{commit}" >/dev/null; then
		force "previous-ref-unresolvable — '$PREV_TAG_RESOLVED' does not resolve to a commit in this checkout (fetch the tag, or the diff cannot be taken)"
		return
	fi
	if ! CHANGED_FILES="$(git diff --name-only "$PREV_TAG_RESOLVED..$HEAD_REF_RESOLVED")"; then
		force "diff-unavailable — 'git diff --name-only $PREV_TAG_RESOLVED..$HEAD_REF_RESOLVED' failed"
		return
	fi
	log "diff $PREV_TAG_RESOLVED..$HEAD_REF_RESOLVED touched $(printf '%s' "$CHANGED_FILES" | grep -c . || true) file(s)"

	# (1) Shared inputs feed every source's build; one of them moving invalidates every
	# carried artifact, so it is a force-all rather than a per-source verdict.
	local f
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		if is_shared_input "$f"; then
			force "shared-input-changed — '$f' is a SHARED build input (packaging/ci/** or packaging/BOOKWORM-ADAPTATIONS.md); it feeds every source, so no source may be carried forward"
			return
		fi
	done <<<"$CHANGED_FILES"
}

resolve

# ---- per-source verdicts --------------------------------------------------------------------
declare -A VERDICT=()

pins_block_changed() { # <source-key> -> 0 when this source's pin block differs prev..HEAD
	local key="$1" prev="" cur=""
	prev="$(git show "$PREV_TAG_RESOLVED:$PINS_REL" 2>/dev/null | pins_block "$key")" || prev=""
	cur="$(git show "$HEAD_REF_RESOLVED:$PINS_REL" 2>/dev/null | pins_block "$key")" || cur=""
	[ "$prev" != "$cur" ]
}

if [ "$FORCED" -eq 1 ]; then
	for dir in "${BUILD_ORDER[@]}"; do VERDICT["$(pin_key "$dir")"]=changed; done
	log "mode=force-all — $FORCE_REASON"
	log "every source rebuilds; nothing is carried forward"
else
	pins_touched=0
	while IFS= read -r f; do
		if [ "$f" = "$PINS_REL" ]; then pins_touched=1; fi
	done <<<"$CHANGED_FILES"

	for dir in "${BUILD_ORDER[@]}"; do
		key="$(pin_key "$dir")"
		verdict=unchanged
		why=""
		while IFS= read -r f; do
			[ -n "$f" ] || continue
			case "$f" in
			"$PKG_REL/$dir"/*)
				verdict=changed
				why="recipe '$f'"
				break
				;;
			esac
		done <<<"$CHANGED_FILES"

		if [ "$verdict" = unchanged ] && [ "$pins_touched" -eq 1 ] && pins_block_changed "$key"; then
			verdict=changed
			why="pin block [$key] in '$PINS_REL'"
		fi

		VERDICT["$key"]="$verdict"
		if [ "$verdict" = changed ]; then
			log "  $key=changed    ($why)"
		else
			log "  $key=unchanged  (no recipe change under $PKG_REL/$dir/, no [$key] pin-block change)"
		fi
	done

	changed_n=0
	for dir in "${BUILD_ORDER[@]}"; do
		if [ "${VERDICT["$(pin_key "$dir")"]}" = changed ]; then changed_n=$((changed_n + 1)); fi
	done
	log "mode=differential — $changed_n of ${#BUILD_ORDER[@]} source(s) changed since $PREV_TAG_RESOLVED; the rest carry forward"
	log "the companion ceralive-modem-support is outside detection and always rebuilds"
fi

MODE=differential
if [ "$FORCED" -eq 1 ]; then MODE=force-all; fi

emit() {
	local dir
	for dir in "${BUILD_ORDER[@]}"; do
		printf '%s=%s\n' "$(pin_key "$dir")" "${VERDICT["$(pin_key "$dir")"]}"
	done
	printf 'mode=%s\n' "$MODE"
}

if [ -n "$OUT_FILE" ]; then
	mkdir -p "$(dirname "$OUT_FILE")"
	emit | tee "$OUT_FILE"
	log "wrote verdicts to '$OUT_FILE'"
else
	emit
fi
