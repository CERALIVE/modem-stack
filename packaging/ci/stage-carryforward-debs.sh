#!/usr/bin/env bash
# stage-carryforward-debs.sh — stage every UNCHANGED source's .debs from the PREVIOUS release
# into packaging/build/<arch>/, byte-verified, so the differential build never rebuilds them.
#
# WHAT THIS IS
#   The SECOND script of the differential-release pipeline. `detect-changed-sources.sh` decides
#   WHICH sources moved; this one carries the bytes of the ones that did not. Builds are NOT
#   reproducible, so an unchanged source can never be rebuilt at its old version — the only
#   honest way to keep a release self-contained is to reuse the exact artifacts the release that
#   last built them recorded. Those bytes are a build INPUT too: `build-bookworm.sh` seeds its
#   temporary local apt repo from `build/<arch>/`, so a changed source resolves its build-deps
#   against the carried `-dev`/`gir1.2-*` packages rather than stock bookworm.
#
# INPUT — the verdict lines from detect-changed-sources.sh, on STDIN by default
#   The caller pipes that script's stdout straight in (or points `--verdicts <file>` at the file
#   it wrote with `--out`). Reading a stream rather than re-running the detector is deliberate:
#   detection resolves the previous release over the network and must happen exactly ONCE per
#   run, and release.yml already holds that result.
#
#     libqrtr-glib=unchanged
#     libmbim=unchanged
#     libqmi=changed
#     modemmanager=unchanged
#     mode=differential
#
#   Source names are upstream-pins.yaml PIN KEYS (`modemmanager`, not `ModemManager`). The
#   `mode=` line is REQUIRED — a verdict stream without it is malformed, not a default.
#
# WHAT IS CARRIED
#   EVERY row of an `unchanged` source — runtime AND aux (`-dbgsym`, `-dev`, `gir1.2-*`). The
#   `role` column is deliberately NOT filtered on: the release manifest is manifest-complete and
#   a release that re-attached only the 9-package runtime closure would silently drop ~36 debs.
#   Rows of a `changed` source are skipped (the build produces them fresh).
#
# THE COMPANION IS NEVER CARRIED
#   `ceralive-modem-support` ALWAYS rebuilds — apt-worker's health check greps `^Version: <pin>$`,
#   which only the companion's bare tag version can satisfy. Its row is skipped explicitly, and
#   that skip is checked BEFORE the unknown-source rule below, so a previous manifest carrying it
#   (every closure_version-2 manifest does) is normal input rather than an error.
#
# GITHUB ASSET-NAME RECONCILIATION (the inverse of reconcile-release-assets.sh)
#   The uploader stages every asset under a sanitized basename — `target="${src//\~/.}"` — so the
#   canonical `libqmi-glib5_1.38.0-1~ceralive1.1.0_amd64.deb` is STORED on the release as
#   `libqmi-glib5_1.38.0-1.ceralive1.1.0_amd64.deb`. Going back the other way cannot simply
#   substitute `.`→`~` (the name is full of legitimate dots), so each `~` becomes a single-char
#   glob wildcard `?` and every other character stays anchored — apt-worker's `modem_asset_glob`
#   discipline. EXACTLY ONE asset must match: zero means the release does not carry it, and two
#   (both the `~` and the `.` spelling present) means the name is ambiguous. Either is fail-closed.
#   The staged file always lands under the CANONICAL `~` name, which is what dpkg orders on and
#   what the next manifest must report.
#
# FAIL CLOSED, ALWAYS NAMING THE OFFENDING ROW/FILE
#   * a manifest row's asset is missing, or its name is ambiguous;
#   * a staged asset's sha256 differs from the manifest row;
#   * a row names a source that is neither the companion nor any verdicted source (defense in
#     depth: a source the caller never adjudicated must never be carried on this script's guess);
#   * an `unchanged` source has ZERO rows in the previous manifest (nothing would be carried and
#     nothing would be built, so the merged set would be quietly incomplete);
#   * the previous manifest is V1-SHAPED — no `closure_version:` header. An ABSENT header IS
#     closure version 1 (apt-worker's backward-compatibility default), which predates the
#     companion row this pipeline depends on. In practice detection force-alls on a v1 manifest,
#     so nothing is ever carried from one; if this script is nevertheless ASKED to, it refuses
#     rather than guessing which shape it is reading.
#   * a destination file already exists with DIFFERENT bytes (a carried deb never overwrites a
#     freshly built one — reconcile-release-assets.sh's integrity-compare stance).
#
# NOTHING TO CARRY IS A NORMAL OUTCOME
#   `mode=force-all` (or simply no `unchanged` source) stages nothing and exits 0 WITHOUT reading
#   a manifest at all — under force-all there is nothing to carry from by definition.
#
# STAGING LAYOUT
#   `<build-root>/<build_arch>/<canonical filename>` — the same gitignored tree
#   `build-bookworm.sh` writes freshly built debs into and `generate-release-manifest.sh` reads.
#   `build_arch` is taken verbatim from manifest column 1, so an `all` row would land in
#   `build/all/`. Only the companion is ever `Architecture: all`, and the companion is never
#   carried — an upstream source's rows are always arch-dependent — so `build/all/` should never
#   be created here. It is handled rather than assumed, and loudly logged if it ever happens.
#
# SEAMS (all optional; they exist so the contract test runs offline, with no gh and no network)
#   PREV_MANIFEST_FILE     Read the previous release manifest from this local path; skips
#                          `gh release download`. Set-but-unreadable is exit 2, not a silent skip.
#   CARRYFORWARD_ASSET_DIR Read the release assets from this local directory instead of
#                          downloading them. Names in it may be either the GitHub-mangled `.`
#                          form or the canonical `~` form — the glob resolves both.
#   PREV_TAG               The release to download the manifest/assets from (required when
#                          neither seam above is set).
#   GH_REPO                Passed to `gh --repo`.
#   BUILD_ROOT             Staging root (default: packaging/build). `--build-root` overrides it.
#
# OUTPUT (stdout — the machine contract)
#   One `<build_arch>/<filename>` line per staged deb, in manifest order. Every human-readable
#   line goes to stderr, so stdout stays parseable.
#
# USAGE
#   detect-changed-sources.sh | stage-carryforward-debs.sh
#   stage-carryforward-debs.sh --verdicts verdicts.txt --build-root packaging/build
#
# EXIT
#   0  staged (or nothing to carry).
#   2  usage / environment error: bad argument, malformed verdict stream, a set-but-unreadable
#      seam, or no way to reach the previous manifest.
#   3  fail closed: the carry cannot be performed honestly (see the list above). Every message
#      names the row, the file, or the source at fault.
set -euo pipefail

LOG_PREFIX="stage-carryforward-debs"
log() { printf '%s: %s\n' "$LOG_PREFIX" "$*" >&2; }
die() {
	printf '%s: %s\n' "$LOG_PREFIX" "$*" >&2
	exit 2
}
refuse() {
	printf '%s: FAIL CLOSED — %s\n' "$LOG_PREFIX" "$*" >&2
	exit 3
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"

# The one source that is never carried. It always rebuilds (apt-worker's health check greps
# `^Version: <pin>$`, which only its bare tag version satisfies).
COMPANION_SOURCE="ceralive-modem-support"

# ---- arguments -----------------------------------------------------------------------------
VERDICTS_FILE=""
BUILD_ROOT="${BUILD_ROOT:-$PKG_ROOT/build}"
while [ $# -gt 0 ]; do
	case "$1" in
	--verdicts)
		shift
		[ $# -gt 0 ] || die "--verdicts requires a file path"
		VERDICTS_FILE="$1"
		;;
	--verdicts=*) VERDICTS_FILE="${1#--verdicts=}" ;;
	--build-root)
		shift
		[ $# -gt 0 ] || die "--build-root requires a directory path"
		BUILD_ROOT="$1"
		;;
	--build-root=*) BUILD_ROOT="${1#--build-root=}" ;;
	-h | --help)
		echo "usage: stage-carryforward-debs.sh [--verdicts <file>] [--build-root <dir>]"
		echo "       (verdict lines are read from stdin when --verdicts is absent)"
		exit 0
		;;
	*) die "unknown argument '$1' (usage: stage-carryforward-debs.sh [--verdicts <file>] [--build-root <dir>])" ;;
	esac
	shift
done

if [ -n "$VERDICTS_FILE" ]; then
	[ -r "$VERDICTS_FILE" ] ||
		die "--verdicts '$VERDICTS_FILE' is not readable (a named input pointing at nothing is operator error, not an empty verdict set)"
	VERDICTS_SRC="$VERDICTS_FILE"
else
	VERDICTS_SRC="/dev/stdin"
fi

# ---- the verdict stream ---------------------------------------------------------------------
declare -A VERDICT=()
VERDICT_ORDER=()
MODE=""
while IFS= read -r line || [ -n "$line" ]; do
	[ -n "$line" ] || continue
	case "$line" in
	\#*) continue ;;
	mode=*) MODE="${line#mode=}" ;;
	*=changed | *=unchanged)
		key="${line%%=*}"
		val="${line#*=}"
		[ -n "$key" ] || die "verdict line '$line' has an empty source name"
		if [ -n "${VERDICT[$key]:-}" ] && [ "${VERDICT[$key]}" != "$val" ]; then
			die "source '$key' is verdicted twice and inconsistently ('${VERDICT[$key]}' then '$val')"
		fi
		if [ -z "${VERDICT[$key]:-}" ]; then VERDICT_ORDER+=("$key"); fi
		VERDICT["$key"]="$val"
		;;
	*) die "unparseable verdict line '$line' (expected '<source>=changed|unchanged' or 'mode=differential|force-all')" ;;
	esac
done <"$VERDICTS_SRC"

[ "${#VERDICT_ORDER[@]}" -gt 0 ] ||
	die "the verdict stream carried no '<source>=changed|unchanged' line (is detect-changed-sources.sh's stdout actually piped in?)"
case "$MODE" in
differential | force-all) ;;
"") die "the verdict stream carried no 'mode=' line — a stream without it is malformed, not a default" ;;
*) die "unrecognized mode '$MODE' (the only accepted values are 'differential' and 'force-all')" ;;
esac

UNCHANGED=()
for key in "${VERDICT_ORDER[@]}"; do
	if [ "${VERDICT[$key]}" = unchanged ]; then UNCHANGED+=("$key"); fi
done

# A force-all run rebuilds EVERYTHING by definition, so an `unchanged` verdict under it is a
# contract violation in the caller's wiring rather than an instruction to carry something.
if [ "$MODE" = force-all ] && [ "${#UNCHANGED[@]}" -gt 0 ]; then
	die "mode=force-all but source(s) [${UNCHANGED[*]}] are verdicted 'unchanged' — under force-all every source rebuilds; refusing to carry anything from a self-contradicting verdict stream"
fi

log "verdicts: mode=$MODE, ${#UNCHANGED[@]} of ${#VERDICT_ORDER[@]} source(s) unchanged"

if [ "${#UNCHANGED[@]}" -eq 0 ]; then
	log "nothing to carry — every source rebuilds; no previous manifest is read and no deb is staged"
	exit 0
fi
log "carrying: ${UNCHANGED[*]}"

is_unchanged() { # <source> -> 0 when the caller verdicted it `unchanged`
	local s
	for s in "${UNCHANGED[@]}"; do [ "$s" = "$1" ] && return 0; done
	return 1
}
is_verdicted() { [ -n "${VERDICT[$1]:-}" ]; }

# ---- the previous release manifest ------------------------------------------------------------
TMP_DIR=""
cleanup() {
	[ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"
	return 0
}
trap cleanup EXIT

gh_args() {
	if [ -n "${GH_REPO:-}" ]; then printf '%s\n%s\n' "--repo" "$GH_REPO"; fi
}
need_tmp() {
	if [ -z "$TMP_DIR" ]; then TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stage-carryforward.XXXXXX")"; fi
}

MANIFEST=""
if [ -n "${PREV_MANIFEST_FILE:-}" ]; then
	[ -r "$PREV_MANIFEST_FILE" ] ||
		die "PREV_MANIFEST_FILE='$PREV_MANIFEST_FILE' is set but not readable (a named seam pointing at nothing is operator error)"
	MANIFEST="$PREV_MANIFEST_FILE"
	log "previous release manifest: $MANIFEST (PREV_MANIFEST_FILE seam)"
else
	[ -n "${PREV_TAG:-}" ] ||
		die "no previous manifest: set PREV_MANIFEST_FILE, or PREV_TAG so the manifest can be downloaded from that release"
	command -v gh >/dev/null 2>&1 ||
		die "no previous manifest: 'gh' is not installed and PREV_MANIFEST_FILE is unset, so release '$PREV_TAG' cannot be read"
	need_tmp
	mkdir -p "$TMP_DIR/manifest"
	ghargs=()
	mapfile -t ghargs < <(gh_args)
	gh release download "$PREV_TAG" "${ghargs[@]}" --pattern 'release-manifest*.txt' --dir "$TMP_DIR/manifest" >/dev/null 2>&1 ||
		refuse "release '$PREV_TAG' has no downloadable release-manifest asset, so there is nothing to carry forward from"
	MANIFEST="$(find "$TMP_DIR/manifest" -maxdepth 1 -type f -name 'release-manifest*.txt' | LC_ALL=C sort | head -n1)"
	[ -n "$MANIFEST" ] ||
		refuse "'gh release download' produced no release-manifest*.txt for '$PREV_TAG'"
	log "previous release manifest: $MANIFEST (gh release download from $PREV_TAG)"
fi

# An ABSENT `closure_version:` header IS closure version 1 — apt-worker's
# `modem_manifest_closure_version` treats it exactly that way. A v1 manifest predates the
# companion row this pipeline depends on, so carrying from one would be a guess.
grep -q '^closure_version:' "$MANIFEST" ||
	refuse "previous manifest '$MANIFEST' carries no 'closure_version:' header (an absent header IS closure version 1); refusing to carry from a v1-shaped manifest rather than guessing its shape"

# Data rows are the 7-column `build_arch package source version role filename sha256` lines.
# Header lines are `key: value` and are excluded by the trailing-colon test on column 1, so a
# multi-token header (`sources: [...]`) can never be mistaken for a row.
ROWS="$(awk '$0 !~ /^#/ && NF==7 && $1 !~ /:$/ { print }' "$MANIFEST")"
[ -n "$ROWS" ] ||
	refuse "previous manifest '$MANIFEST' contains no deb rows"

# ---- release assets ---------------------------------------------------------------------------
ASSET_NAMES=()
ASSET_DIR=""
if [ -n "${CARRYFORWARD_ASSET_DIR:-}" ]; then
	[ -d "$CARRYFORWARD_ASSET_DIR" ] ||
		die "CARRYFORWARD_ASSET_DIR='$CARRYFORWARD_ASSET_DIR' is set but is not a directory"
	ASSET_DIR="$CARRYFORWARD_ASSET_DIR"
	mapfile -t ASSET_NAMES < <(find "$ASSET_DIR" -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)
	log "release assets: ${#ASSET_NAMES[@]} local file(s) in $ASSET_DIR (CARRYFORWARD_ASSET_DIR seam)"
else
	[ -n "${PREV_TAG:-}" ] ||
		die "no release assets: set CARRYFORWARD_ASSET_DIR, or PREV_TAG so the assets can be downloaded"
	command -v gh >/dev/null 2>&1 ||
		die "no release assets: 'gh' is not installed and CARRYFORWARD_ASSET_DIR is unset"
	log "release assets: downloaded per row from release '$PREV_TAG'"
fi

# Canonical `~ceralive…` filename -> the glob that matches whatever name the release stores it
# under. The uploader sanitizes `~`→`.`, so each `~` becomes a single-char wildcard while every
# other character stays anchored. INVERSE of reconcile-release-assets.sh's `${src//\~/.}`.
asset_glob() { printf '%s\n' "${1//\~/?}"; }

# Put the row's asset at <dest>, resolving the stored (possibly mangled) name into the global
# RESOLVED_ASSET so callers can report which asset a failure came from. Deliberately NOT a
# command-substitution helper: every failure here is a `refuse`, and an `exit 3` inside `$( )`
# would leave the main shell to infer the outcome from a status.
RESOLVED_ASSET=""
fetch_asset() { # <canonical> <dest>
	local canonical="$1" dest="$2" glob name matches=() dl ghargs=()
	glob="$(asset_glob "$canonical")"
	RESOLVED_ASSET=""

	if [ -n "$ASSET_DIR" ]; then
		for name in "${ASSET_NAMES[@]}"; do
			# shellcheck disable=SC2053  # $glob is a glob PATTERN here, quoting would break it
			if [[ "$name" == $glob ]]; then matches+=("$name"); fi
		done
		if [ "${#matches[@]}" -eq 0 ]; then
			refuse "asset for '$canonical' is missing — no file in '$ASSET_DIR' matches '$glob' (the previous release does not carry it, so it cannot be carried forward)"
		fi
		if [ "${#matches[@]}" -gt 1 ]; then
			refuse "asset for '$canonical' is ambiguous — ${#matches[@]} files match '$glob': ${matches[*]}"
		fi
		cp "$ASSET_DIR/${matches[0]}" "$dest"
		RESOLVED_ASSET="${matches[0]}"
		return 0
	fi

	need_tmp
	dl="$TMP_DIR/dl"
	rm -rf "$dl"
	mkdir -p "$dl"
	mapfile -t ghargs < <(gh_args)
	gh release download "$PREV_TAG" "${ghargs[@]}" --pattern "$glob" --dir "$dl" >/dev/null 2>&1 ||
		refuse "asset for '$canonical' could not be downloaded from release '$PREV_TAG' (pattern '$glob')"
	mapfile -t matches < <(find "$dl" -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)
	if [ "${#matches[@]}" -ne 1 ]; then
		refuse "asset for '$canonical' resolved to ${#matches[@]} release asset(s) via '$glob' (expected exactly 1): ${matches[*]:-none}"
	fi
	mv "$dl/${matches[0]}" "$dest"
	RESOLVED_ASSET="${matches[0]}"
}

sha_of() { sha256sum "$1" | awk '{print $1}'; }

# ---- the carry --------------------------------------------------------------------------------
declare -A STAGED_PER_SOURCE=()
for key in "${UNCHANGED[@]}"; do STAGED_PER_SOURCE["$key"]=0; done

need_tmp
STAGE_TMP="$TMP_DIR/stage"
mkdir -p "$STAGE_TMP"

staged_total=0
skipped_changed=0
skipped_companion=0
staged_lines=()

while IFS= read -r row; do
	[ -n "$row" ] || continue
	# shellcheck disable=SC2086  # deliberate word-splitting of a fixed 7-column row
	set -- $row
	build_arch="$1"
	package="$2"
	source_name="$3"
	version="$4"
	role="$5"
	filename="$6"
	want_sha="$7"

	# The companion is checked FIRST: it is never verdicted, so the unknown-source rule below
	# would otherwise reject a perfectly ordinary closure_version-2 manifest.
	if [ "$source_name" = "$COMPANION_SOURCE" ]; then
		skipped_companion=$((skipped_companion + 1))
		log "  skip  $filename — the companion '$COMPANION_SOURCE' always rebuilds and is never carried"
		continue
	fi

	if ! is_verdicted "$source_name"; then
		refuse "manifest row '$filename' names source '$source_name', which the caller never verdicted (verdicted: ${VERDICT_ORDER[*]}) — a source the caller did not adjudicate is never carried"
	fi

	if ! is_unchanged "$source_name"; then
		skipped_changed=$((skipped_changed + 1))
		continue
	fi

	case "$filename" in
	*/* | "") refuse "manifest row for package '$package' has an unusable filename '$filename'" ;;
	esac
	if [ "$build_arch" = all ]; then
		log "  NOTE: upstream source '$source_name' has a build_arch 'all' row ($filename) — only the companion is ever Architecture: all; staging it into '$BUILD_ROOT/all/' verbatim"
	fi

	tmp_asset="$STAGE_TMP/$filename"
	fetch_asset "$filename" "$tmp_asset"
	stored="$RESOLVED_ASSET"

	got_sha="$(sha_of "$tmp_asset")"
	if [ "$got_sha" != "$want_sha" ]; then
		refuse "carried deb '$filename' (release asset '$stored') sha256 $got_sha != previous manifest $want_sha — the recorded bytes are the only thing that may be carried"
	fi

	dest_dir="$BUILD_ROOT/$build_arch"
	mkdir -p "$dest_dir"
	dest="$dest_dir/$filename"
	if [ -e "$dest" ]; then
		dest_sha="$(sha_of "$dest")"
		if [ "$dest_sha" != "$want_sha" ]; then
			refuse "'$dest' already exists with different bytes (staged $dest_sha != manifest $want_sha); a carried deb never overwrites what is already in the build tree"
		fi
		log "  keep  $build_arch/$filename ($package $version, $role) — already staged, integrity matches"
	else
		cp "$tmp_asset" "$dest"
		# Re-hash the DESTINATION: a short write must never look like a successful carry.
		dest_sha="$(sha_of "$dest")"
		if [ "$dest_sha" != "$want_sha" ]; then
			refuse "staged copy '$dest' hashes $dest_sha, not the manifest's $want_sha"
		fi
		log "  stage $build_arch/$filename ($package $version, $role) <- release asset '$stored'"
	fi

	rm -f "$tmp_asset"
	per_source="${STAGED_PER_SOURCE[$source_name]}"
	STAGED_PER_SOURCE["$source_name"]=$((per_source + 1))
	staged_total=$((staged_total + 1))
	staged_lines+=("$build_arch/$filename")
done <<<"$ROWS"

# An unchanged source with no rows in the previous manifest would be neither carried nor built —
# a silently incomplete merged set, which is exactly what this pipeline exists to prevent.
for key in "${UNCHANGED[@]}"; do
	if [ "${STAGED_PER_SOURCE[$key]}" -eq 0 ]; then
		refuse "source '$key' is verdicted 'unchanged' but the previous manifest '$MANIFEST' carries ZERO rows for it — it would be neither carried nor rebuilt"
	fi
done

for key in "${UNCHANGED[@]}"; do
	log "  carried $key: ${STAGED_PER_SOURCE[$key]} deb(s)"
done
log "staged $staged_total deb(s) into '$BUILD_ROOT' (skipped $skipped_changed row(s) of changed sources, $skipped_companion companion row(s))"

if [ "${#staged_lines[@]}" -gt 0 ]; then printf '%s\n' "${staged_lines[@]}"; fi
