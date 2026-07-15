#!/usr/bin/env bash
# generate-release-manifest.sh <tag> [build-root] [out-file] — emit the per-release manifest
# that maps ONE release tag to the exact .deb versions it produced, per arch.
#
# Phase-B apt publication consumes this file as the package -> source -> version matrix, so
# it is the single source of truth for "which debs are release <tag>". It is deliberately
# dpkg-free: it parses each `<package>_<version>_<arch>.deb` filename and sha256sums the
# file, so it runs identically on a CI runner, a bench box, or this dev host.
#
# INPUT   build-root (default: packaging/build) holding <arch>/*.deb from build-bookworm.sh.
# OUTPUT  a manifest at out-file (default: dist/release-manifest.txt), also echoed to stdout.
#
# The manifest lists the 9-package RUNTIME closure per arch (the "9 exact deb versions" the
# plan speaks of). Non-runtime debs (-dev / -dbgsym / gir1.2-*) are recorded in a trailing
# comment count but are not part of the runtime version matrix.
#
# USAGE   generate-release-manifest.sh v0.1.0
#         generate-release-manifest.sh v0.1.0 packaging/build dist/release-manifest.txt
# EXIT    0 ok. 2 usage / no debs.
set -euo pipefail

TAG="${1:-}"
[ -n "$TAG" ] || { echo "usage: generate-release-manifest.sh <tag> [build-root] [out-file]" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"
BUILD_ROOT="${2:-$PKG_ROOT/build}"
OUT="${3:-$PKG_ROOT/../dist/release-manifest.txt}"

# Strip a leading v for the encoded suffix (tag guard already vetted the shape upstream).
VERSION="${TAG#v}"
SUFFIX="~ceralive${VERSION}"

# The 9-package runtime closure and each package's source (for the Phase-B matrix).
declare -A SOURCE_OF=(
	[modemmanager]=ModemManager   [libmm-glib0]=ModemManager
	[libmbim-glib4]=libmbim       [libmbim-proxy]=libmbim      [libmbim-utils]=libmbim
	[libqmi-glib5]=libqmi         [libqmi-proxy]=libqmi        [libqmi-utils]=libqmi
	[libqrtr-glib0]=libqrtr-glib
)
RUNTIME_PKGS=(modemmanager libmm-glib0 libmbim-glib4 libmbim-proxy libmbim-utils \
	libqmi-glib5 libqmi-proxy libqmi-utils libqrtr-glib0)

# Parse "<pkg>_<version>_<arch>.deb" -> pkg / version / arch (version never contains '_').
deb_field() { # <basename> <pkg|version|arch>
	local b="${1%.deb}" pkg ver arch
	arch="${b##*_}"; b="${b%_*}"
	ver="${b##*_}";  pkg="${b%_*}"
	case "$2" in pkg) echo "$pkg" ;; version) echo "$ver" ;; arch) echo "$arch" ;; esac
}

mkdir -p "$(dirname "$OUT")"
{
	echo "# CeraLive modem-stack release manifest"
	echo "# Maps release tag -> exact .deb versions (Phase-B apt publication consumes this)."
	echo "tag: ${TAG}"
	echo "version: ${VERSION}"
	echo "deb_version_suffix: ${SUFFIX}"
	echo "sources: [ModemManager, libmbim, libqmi, libqrtr-glib]"
	echo "runtime_closure_size: ${#RUNTIME_PKGS[@]}"
	echo "# columns: arch  package  source  version  filename  sha256"
} > "$OUT"

total_runtime=0
arches_seen=()
for archdir in "$BUILD_ROOT"/*/; do
	[ -d "$archdir" ] || continue
	arch="$(basename "$archdir")"
	ls "$archdir"/*.deb >/dev/null 2>&1 || continue
	arches_seen+=("$arch")

	# Index this arch's debs by package name.
	declare -A FILE_OF=()
	for deb in "$archdir"/*.deb; do
		FILE_OF["$(deb_field "$(basename "$deb")" pkg)"]="$deb"
	done

	for pkg in "${RUNTIME_PKGS[@]}"; do
		deb="${FILE_OF[$pkg]:-}"
		[ -n "$deb" ] || { echo "generate-release-manifest: MISSING runtime deb '$pkg' for $arch" >&2; exit 2; }
		fn="$(basename "$deb")"
		ver="$(deb_field "$fn" version)"
		sha="$(sha256sum "$deb" | awk '{print $1}')"
		printf '%s  %s  %s  %s  %s  %s\n' "$arch" "$pkg" "${SOURCE_OF[$pkg]}" "$ver" "$fn" "$sha" >> "$OUT"
		total_runtime=$((total_runtime + 1))
	done
	unset FILE_OF
done

{
	echo "# arches: ${arches_seen[*]:-none}"
	echo "# runtime_debs_total: ${total_runtime}  (= ${#RUNTIME_PKGS[@]} runtime x ${#arches_seen[@]} arch)"
} >> "$OUT"

[ "$total_runtime" -gt 0 ] || { echo "generate-release-manifest: no runtime debs found under $BUILD_ROOT" >&2; exit 2; }

cat "$OUT"
echo "generate-release-manifest: wrote $OUT (${total_runtime} runtime deb rows across ${#arches_seen[@]} arch)" >&2
