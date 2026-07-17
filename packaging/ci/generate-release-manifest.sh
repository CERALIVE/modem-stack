#!/usr/bin/env bash
# generate-release-manifest.sh <tag> [build-root] [out-file] — emit the per-release manifest
# that maps ONE release tag to the exact .deb versions it produced, per arch.
#
# Phase-B apt publication AND the create-release asset reconciler both consume this file as the
# single source of truth for "which debs are release <tag>", so it is MANIFEST-COMPLETE: it
# lists a checksum row for EVERY built deb (both arches) — the 9-package runtime closure is a
# MARKED subset (role=runtime) and the -dev/gir/-dbgsym debs are role=aux. It is deliberately
# dpkg-free: it parses each `<package>_<version>_<arch>.deb` filename and sha256sums the file,
# so it runs identically on a CI runner, a bench box, or this dev host.
#
# It also FAILS CLOSED if the produced set is not exactly the frozen all-artifact set: per arch,
# per source, the enumerated packages must EQUAL `[<source> all-artifact]` in expected-packages.txt
# (the two-set model finalized in todo 1.4). An added, dropped, renamed, or unmapped deb is a
# hard error — the manifest can never silently under- or over-report the release contents.
#
# INPUT   build-root (default: packaging/build) holding <arch>/*.deb from build-bookworm.sh.
#         EXPECTED_PACKAGES (env, default: alongside this script) — the frozen package sets.
# OUTPUT  a manifest at out-file (default: dist/release-manifest.txt), also echoed to stdout.
#
# USAGE   generate-release-manifest.sh v0.1.0
#         generate-release-manifest.sh v0.1.0 packaging/build dist/release-manifest.txt
# EXIT    0 ok. 2 usage / no debs / unreadable expected-packages. 3 package-set inequality.
set -euo pipefail

TAG="${1:-}"
[ -n "$TAG" ] || { echo "usage: generate-release-manifest.sh <tag> [build-root] [out-file]" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"
BUILD_ROOT="${2:-$PKG_ROOT/build}"
OUT="${3:-$PKG_ROOT/../dist/release-manifest.txt}"
EXPECTED="${EXPECTED_PACKAGES:-$HERE/expected-packages.txt}"
[ -r "$EXPECTED" ] || { echo "generate-release-manifest: cannot read expected-packages '$EXPECTED'" >&2; exit 2; }

# Strip a leading v for the encoded suffix (tag guard already vetted the shape upstream).
VERSION="${TAG#v}"
SUFFIX="~ceralive${VERSION}"

# The 9-package runtime closure — used to mark rows (role) and to assert none is missing.
RUNTIME_PKGS=(modemmanager libmm-glib0 libmbim-glib4 libmbim-proxy libmbim-utils \
	libqmi-glib5 libqmi-proxy libqmi-utils libqrtr-glib0)
is_runtime() { local p="$1" r; for r in "${RUNTIME_PKGS[@]}"; do [ "$r" = "$p" ] && return 0; done; return 1; }

# Parse "<pkg>_<version>_<arch>.deb" -> pkg / version / arch (version never contains '_').
deb_field() { # <basename> <pkg|version|arch>
	local b="${1%.deb}" pkg ver arch
	arch="${b##*_}"; b="${b%_*}"
	ver="${b##*_}";  pkg="${b%_*}"
	case "$2" in pkg) echo "$pkg" ;; version) echo "$ver" ;; arch) echo "$arch" ;; esac
}

# ---- expected-packages.txt readers (the [<source> all-artifact] blocks) --------------------
expected_sources() {
	awk -F'[][]' '/^\[[^]]+ all-artifact\]/ { split($2, a, " "); print a[1] }' "$EXPECTED" | LC_ALL=C sort -u
}
expected_set() { # <source> -> its all-artifact package list, sorted-unique
	awk -v want="[$1 all-artifact]" '
		/^\[/ { h=$0; sub(/[ \t]*#.*$/, "", h); insec=(h==want)?1:0; next }
		insec { l=$0; sub(/#.*$/, "", l); gsub(/[ \t]+/, "", l); if (l!="") print l }
	' "$EXPECTED" | LC_ALL=C sort -u
}

# Reverse map: package -> owning source (across every all-artifact block).
declare -A SOURCE_OF=()
mapfile -t SOURCES < <(expected_sources)
for src in "${SOURCES[@]}"; do
	while IFS= read -r pkg; do
		[ -n "$pkg" ] && SOURCE_OF["$pkg"]="$src"
	done < <(expected_set "$src")
done

mkdir -p "$(dirname "$OUT")"
{
	echo "# CeraLive modem-stack release manifest"
	echo "# Maps release tag -> exact .deb versions (Phase-B apt + create-release consume this)."
	echo "# MANIFEST-COMPLETE: one row per built deb, both arches; runtime closure marked."
	echo "tag: ${TAG}"
	echo "version: ${VERSION}"
	echo "deb_version_suffix: ${SUFFIX}"
	echo "sources: [${SOURCES[*]}]"
	echo "runtime_closure_size: ${#RUNTIME_PKGS[@]}"
	echo "# columns: arch  package  source  version  role  filename  sha256"
} > "$OUT"

total_all=0
total_runtime=0
arches_seen=()
rc=0
for archdir in "$BUILD_ROOT"/*/; do
	[ -d "$archdir" ] || continue
	arch="$(basename "$archdir")"
	ls "$archdir"/*.deb >/dev/null 2>&1 || continue
	arches_seen+=("$arch")

	# Index this arch's debs by package name, and collect the produced package set.
	declare -A FILE_OF=()
	for deb in "$archdir"/*.deb; do
		FILE_OF["$(deb_field "$(basename "$deb")" pkg)"]="$deb"
	done
	produced_sorted="$(printf '%s\n' "${!FILE_OF[@]}" | LC_ALL=C sort -u)"

	# (a) No runtime package may be absent (kept from the original closure check).
	for pkg in "${RUNTIME_PKGS[@]}"; do
		[ -n "${FILE_OF[$pkg]:-}" ] || { echo "generate-release-manifest: MISSING runtime deb '$pkg' for $arch" >&2; exit 2; }
	done

	# (b) Every produced package must map to a known source (else it is unexpected).
	while IFS= read -r p; do
		[ -n "$p" ] || continue
		[ -n "${SOURCE_OF[$p]:-}" ] || { echo "generate-release-manifest: FAIL CLOSED — [$arch] produced package '$p' is in no expected all-artifact set" >&2; rc=3; }
	done <<< "$produced_sorted"

	# (c) Per-source EQUALITY: produced set for this source == its all-artifact set.
	for src in "${SOURCES[@]}"; do
		want="$(expected_set "$src")"
		# `|| true`: the filter's last test can be a non-match (exit 1); pipefail would else
		# abort. An empty `got` simply fails the equality below, closed.
		got="$(printf '%s\n' "$produced_sorted" | while IFS= read -r p; do [ "${SOURCE_OF[$p]:-}" = "$src" ] && printf '%s\n' "$p"; done | LC_ALL=C sort -u)" || true
		if [ "$want" != "$got" ]; then
			echo "generate-release-manifest: FAIL CLOSED — [$src/$arch] set != expected all-artifact:" >&2
			comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$got") | sed 's/^/  MISSING: /' >&2 || true
			comm -13 <(printf '%s\n' "$want") <(printf '%s\n' "$got") | sed 's/^/  UNEXPECTED: /' >&2 || true
			rc=3
		fi
	done

	# (d) Emit a row for EVERY deb (sorted by package for a deterministic manifest).
	while IFS= read -r pkg; do
		[ -n "$pkg" ] || continue
		deb="${FILE_OF[$pkg]}"
		fn="$(basename "$deb")"
		ver="$(deb_field "$fn" version)"
		sha="$(sha256sum "$deb" | awk '{print $1}')"
		if is_runtime "$pkg"; then role=runtime; total_runtime=$((total_runtime + 1)); else role=aux; fi
		printf '%s  %s  %s  %s  %s  %s  %s\n' "$arch" "$pkg" "${SOURCE_OF[$pkg]:-UNKNOWN}" "$ver" "$role" "$fn" "$sha" >> "$OUT"
		total_all=$((total_all + 1))
	done <<< "$produced_sorted"

	unset FILE_OF
done

{
	echo "# arches: ${arches_seen[*]:-none}"
	echo "# all_debs_total: ${total_all}  runtime_debs_total: ${total_runtime}  (across ${#arches_seen[@]} arch)"
} >> "$OUT"

[ "$total_all" -gt 0 ] || { echo "generate-release-manifest: no debs found under $BUILD_ROOT" >&2; exit 2; }
if [ "$rc" -ne 0 ]; then
	echo "generate-release-manifest: STOP — produced package set != frozen all-artifact sets." >&2
	exit "$rc"
fi

cat "$OUT"
echo "generate-release-manifest: wrote $OUT (${total_all} deb rows, ${total_runtime} runtime, across ${#arches_seen[@]} arch)" >&2
