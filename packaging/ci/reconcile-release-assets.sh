#!/usr/bin/env bash
# reconcile-release-assets.sh <tag> <assets-dir> — IMMUTABLE, manifest-complete release-asset
# reconciliation for the ModemManager stack release.
#
# WHAT IT DOES (one shared helper — the release.yml create-release job AND the QA drills both
# call THIS script; there is deliberately NO inline copy of this logic in the workflow YAML):
#
#   1. MANIFEST-COMPLETENESS. <assets-dir> is a FLAT directory holding the release's raw
#      artifacts: every built `.deb` (both arches, with their `~ceralive` build names) plus the
#      `release-manifest.txt`. The manifest is the completeness oracle: the set of `.deb` files
#      present MUST equal, byte-for-byte by sha256, the set the manifest enumerates — no more,
#      no less. A missing, extra, or corrupted deb FAILS CLOSED naming it.
#
#   2. SANITIZED STAGING. GitHub Release asset upload historically rewrites `~` -> `.` in an
#      asset name. We NEVER rely on that mapping: every asset is staged as a FLAT copy under its
#      OWN sanitized basename (`~` -> `.`), computed here. Two distinct sources that sanitize to
#      the SAME name are a hard COLLISION -> FAIL CLOSED (they would otherwise silently overwrite).
#
#   3. IMMUTABLE RECONCILE. The release is created if absent. Then, for each staged asset:
#        * MISSING on the release   -> upload it (plain `gh release upload`, never overwriting).
#        * EXISTS on the release     -> download the live copy into a fresh dir and sha256-compare
#                                       it to the staged file. EQUAL -> skip (idempotent re-run).
#                                       DIFFERENT -> FAIL CLOSED (published assets are immutable;
#                                       we NEVER overwrite one).
#      Overwriting a published asset is structurally impossible here — there is no overwrite flag
#      used anywhere in this script, by design.
#
#   4. FINAL VERIFY. The live asset set (names + count) must EQUAL the staged set. Anything else
#      FAILS CLOSED.
#
# BACKEND (testable without a live GitHub release):
#   Default            — talks to GitHub via `gh` (release view/create/upload/download).
#   RECONCILE_RELEASE_DIR=<dir> — LOCAL MOCK: that directory stands in for the release's asset
#                        store (its files are the "existing" assets). This is how the QA drills
#                        exercise the missing / integrity-match / integrity-mismatch / collision
#                        paths against scratch files. The directory not existing == release absent.
#
# Usage: reconcile-release-assets.sh <tag> <assets-dir>
# Exit:
#   0  reconciled; live asset set == staged set (manifest-complete).
#   2  usage / unreadable input / manifest missing.
#   3  FAIL CLOSED: completeness gap, name collision, integrity mismatch, or verify mismatch.
set -euo pipefail

TAG="${1:-}"
ASSETS_DIR="${2:-}"
MANIFEST_NAME="${RECONCILE_MANIFEST_NAME:-release-manifest.txt}"

[ -n "$TAG" ] && [ -n "$ASSETS_DIR" ] || {
	echo "usage: reconcile-release-assets.sh <tag> <assets-dir>" >&2
	exit 2
}
[ -d "$ASSETS_DIR" ] || { echo "reconcile: assets dir '$ASSETS_DIR' does not exist" >&2; exit 2; }

MANIFEST="$ASSETS_DIR/$MANIFEST_NAME"
[ -r "$MANIFEST" ] || { echo "reconcile: manifest '$MANIFEST' not found in assets dir" >&2; exit 2; }

VERSION="${TAG#v}"
sha_of() { sha256sum "$1" | awk '{print $1}'; }

# ---- backend selection --------------------------------------------------------------------
gh_mode() { [ -z "${RECONCILE_RELEASE_DIR:-}" ]; }

release_exists() {
	if gh_mode; then gh release view "$TAG" >/dev/null 2>&1
	else [ -d "$RECONCILE_RELEASE_DIR" ]; fi
}
create_release() { # <notes-file>
	if gh_mode; then
		gh release create "$TAG" --title "$TAG" --notes-file "$1"
	else
		mkdir -p "$RECONCILE_RELEASE_DIR"
	fi
}
list_live_assets() { # -> asset basenames, one per line, sorted
	if gh_mode; then
		gh release view "$TAG" --json assets --jq '.assets[].name' | LC_ALL=C sort
	else
		find "$RECONCILE_RELEASE_DIR" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | LC_ALL=C sort
	fi
}
fetch_existing_asset() { # <name> <fresh-destdir>
	if gh_mode; then
		gh release download "$TAG" --pattern "$1" --dir "$2" >/dev/null
	else
		cp "$RECONCILE_RELEASE_DIR/$1" "$2/$1"
	fi
}
upload_asset() { # <staged-file>   (plain upload; overwriting is never requested)
	if gh_mode; then
		gh release upload "$TAG" "$1"
	else
		cp "$1" "$RECONCILE_RELEASE_DIR/"
	fi
}

# ---- 0. enumerate the assets dir; enforce it holds ONLY debs + the manifest ----------------
mapfile -t ALL_FILES < <(find "$ASSETS_DIR" -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)
deb_files=()
for f in "${ALL_FILES[@]}"; do
	case "$f" in
	"$MANIFEST_NAME") ;;
	*.deb) deb_files+=("$f") ;;
	*)
		echo "reconcile: FAIL CLOSED — unexpected asset '$f' (only *.deb + $MANIFEST_NAME allowed)" >&2
		exit 3
		;;
	esac
done
[ "${#deb_files[@]}" -gt 0 ] || { echo "reconcile: no *.deb files in $ASSETS_DIR" >&2; exit 2; }

# ---- 1. manifest-completeness: assets-dir debs == manifest debs, sha256-exact --------------
# Each manifest deb row carries a `<name>.deb` token and a 64-hex sha256 token (column order is
# not assumed). Emit "<filename>\t<sha256>" per deb row.
manifest_debs() {
	awk '
		/^[[:space:]]*#/ { next }
		{
			fn=""; sh=""
			for (i=1; i<=NF; i++) {
				if ($i ~ /\.deb$/)            fn=$i
				else if ($i ~ /^[0-9a-f]{64}$/) sh=$i
			}
			if (fn != "" && sh != "") print fn "\t" sh
		}
	' "$MANIFEST" | LC_ALL=C sort
}

fail=0
declare -A MANIFEST_SHA=()
manifest_names_tmp="$(mktemp)"
while IFS=$'\t' read -r fn sh; do
	[ -n "$fn" ] || continue
	MANIFEST_SHA["$fn"]="$sh"
	printf '%s\n' "$fn" >>"$manifest_names_tmp"
done < <(manifest_debs)
manifest_names="$(LC_ALL=C sort "$manifest_names_tmp")"; rm -f "$manifest_names_tmp"
[ -n "$manifest_names" ] || { echo "reconcile: manifest lists no deb rows — cannot verify completeness" >&2; exit 2; }

present_names="$(printf '%s\n' "${deb_files[@]}" | LC_ALL=C sort)"

# Debs the manifest expects but the assets dir does not have (the drill-(i) case).
missing="$(comm -23 <(printf '%s\n' "$manifest_names") <(printf '%s\n' "$present_names") || true)"
# Debs present in the assets dir that the manifest does not list.
extra="$(comm -13 <(printf '%s\n' "$manifest_names") <(printf '%s\n' "$present_names") || true)"

if [ -n "$missing" ]; then
	while IFS= read -r m; do [ -n "$m" ] && echo "reconcile: FAIL CLOSED — manifest deb missing from assets: $m" >&2; done <<<"$missing"
	fail=1
fi
if [ -n "$extra" ]; then
	while IFS= read -r e; do [ -n "$e" ] && echo "reconcile: FAIL CLOSED — asset deb not in manifest: $e" >&2; done <<<"$extra"
	fail=1
fi
[ "$fail" -eq 0 ] || exit 3

# sha256 of every deb must match the manifest (a corrupt/rebuilt deb is caught here).
for fn in "${deb_files[@]}"; do
	want="${MANIFEST_SHA[$fn]}"
	got="$(sha_of "$ASSETS_DIR/$fn")"
	if [ "$want" != "$got" ]; then
		echo "reconcile: FAIL CLOSED — deb '$fn' sha256 $got != manifest $want" >&2
		fail=1
	fi
done
[ "$fail" -eq 0 ] || exit 3
echo "reconcile: manifest-complete — ${#deb_files[@]} deb(s) present, sha256-exact vs $MANIFEST_NAME"

# ---- 2. sanitized staging (~ -> .) + collision detection -----------------------------------
STAGE_DIR="$(mktemp -d)"
DL_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR" "$DL_DIR"' EXIT

declare -A STAGED_FROM=()
staged_names=()
for src in "${ALL_FILES[@]}"; do
	target="${src//\~/.}"
	if [ -n "${STAGED_FROM[$target]:-}" ]; then
		echo "reconcile: FAIL CLOSED — sanitized-name collision '$target' from both '${STAGED_FROM[$target]}' and '$src'" >&2
		exit 3
	fi
	STAGED_FROM["$target"]="$src"
	cp "$ASSETS_DIR/$src" "$STAGE_DIR/$target"
	staged_names+=("$target")
done
staged_sorted="$(printf '%s\n' "${staged_names[@]}" | LC_ALL=C sort)"
echo "reconcile: staged ${#staged_names[@]} asset(s) under sanitized names"

# ---- 3. ensure the release exists, then reconcile immutably --------------------------------
if release_exists; then
	echo "reconcile: release $TAG exists — reconciling against its current assets"
else
	notes="$(mktemp)"
	{
		echo "CeraLive modem-stack $TAG"
		echo
		echo "- npm: https://www.npmjs.com/package/@ceralive/modem-control/v/${VERSION}"
		echo "- debs: ${#deb_files[@]} package(s), both arches (see ${MANIFEST_NAME})"
		echo "- manifest: ${MANIFEST_NAME} (tag -> per-arch .deb versions + sha256)"
		echo "- asset names are sanitized (\`~\` -> \`.\`) from their build filenames."
	} >"$notes"
	echo "reconcile: release $TAG absent — creating it"
	create_release "$notes"
	rm -f "$notes"
fi

live_before="$(list_live_assets || true)"
for name in "${staged_names[@]}"; do
	if printf '%s\n' "$live_before" | grep -qxF "$name"; then
		# EXISTING asset — integrity-compare, never overwrite.
		rm -rf "${DL_DIR:?}"/*
		if ! fetch_existing_asset "$name" "$DL_DIR"; then
			echo "reconcile: FAIL CLOSED — could not fetch existing asset '$name' for integrity compare" >&2
			exit 3
		fi
		live_sha="$(sha_of "$DL_DIR/$name")"
		staged_sha="$(sha_of "$STAGE_DIR/$name")"
		if [ "$live_sha" = "$staged_sha" ]; then
			echo "reconcile:   SKIP  $name (already published, integrity matches: $staged_sha)"
		else
			echo "reconcile: FAIL CLOSED — published asset '$name' differs (live $live_sha != staged $staged_sha); refusing to overwrite" >&2
			exit 3
		fi
	else
		echo "reconcile:   UPLOAD $name (missing from release)"
		upload_asset "$STAGE_DIR/$name"
	fi
done

# ---- 4. final verify: live asset set == staged set -----------------------------------------
live_after="$(list_live_assets || true)"
if [ "$live_after" != "$staged_sorted" ]; then
	echo "reconcile: FAIL CLOSED — final asset set != staged set:" >&2
	comm -23 <(printf '%s\n' "$staged_sorted") <(printf '%s\n' "$live_after") \
		| sed 's/^/  MISSING from release: /' >&2 || true
	comm -13 <(printf '%s\n' "$staged_sorted") <(printf '%s\n' "$live_after") \
		| sed 's/^/  UNEXPECTED on release: /' >&2 || true
	exit 3
fi

echo "reconcile: OK — release $TAG carries exactly ${#staged_names[@]} asset(s), manifest-complete."
