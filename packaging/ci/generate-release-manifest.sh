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
# CLOSURE VERSION 2 — the versioned contract apt-worker's publisher validates against.
#   v1 (legacy, still valid): 9 arch-dependent runtime packages x 2 arches = 18 runtime rows.
#   v2 (this):                the same 9 x 2, PLUS the first-party `Architecture: all`
#                             companion `ceralive-modem-support`, emitted as ONE row with
#                             arch column `all`.
#
#   BUILD ARCHITECTURE vs INDEX MEMBERSHIP are different questions and the manifest now says
#   so. Column 1 is the BUILD architecture of the artifact (`arm64`, `amd64`, or `all`).
#   Index membership is DERIVED from it: `all` enters BOTH per-arch APT indexes, anything
#   else enters its own. That is why the companion is ONE immutable release asset with TWO
#   index memberships rather than two builds — two builds would produce two byte-different
#   files claiming the same package/version key and break the publisher's immutable-key rule.
#
#   The header therefore carries THREE counts rather than one, so a consumer never has to
#   infer the shape: `runtime_closure_size` (per-arch, arch-dependent), `arch_all_closure_size`,
#   and `index_arches`.
#
# NO `deb_version_suffix:` HEADER — `suffix_scheme: per-source-counter` REPLACES IT.
#   Releases are differential: each upstream source carries its own rebuild counter
#   `<upstream>-<rev>~ceralive.N`, and a source that was not rebuilt keeps the counter it
#   already had. There is therefore NO single truthful suffix value a header could state, so
#   the generator declares the SCHEME instead of a value and every row keeps carrying its own
#   version (which it always did — rows are parsed from real filenames, so a carried-forward
#   deb at an old counter and a freshly built one at a new counter both emit correctly).
#   Dropping the old header is safe on both sides: apt-worker's publisher/validator reads
#   NEITHER field (it extracts only tag / closure_version / sizes / rows), and legacy manifests
#   are untouched because validation never read the old header either. `version:` is unrelated
#   and stays — it is the RELEASE's own SemVer, not a per-deb suffix.
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

# Strip a leading v for the release's own version string (tag guard vetted the shape upstream).
# NOTE: this is NOT a deb suffix — per-deb versions come from each file's own name (see (d)).
VERSION="${TAG#v}"

CLOSURE_VERSION=2
SUFFIX_SCHEME="per-source-counter"

# The 9 arch-dependent runtime packages, and the arch-all runtime companion.
RUNTIME_PKGS=(modemmanager libmm-glib0 libmbim-glib4 libmbim-proxy libmbim-utils \
	libqmi-glib5 libqmi-proxy libqmi-utils libqrtr-glib0)
ARCH_ALL_RUNTIME_PKGS=(ceralive-modem-support)
INDEX_ARCHES=(arm64 amd64)

is_runtime() {
	local p="$1" r
	for r in "${RUNTIME_PKGS[@]}" "${ARCH_ALL_RUNTIME_PKGS[@]}"; do [ "$r" = "$p" ] && return 0; done
	return 1
}

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
is_arch_all_source() {
	awk -v want="$1" '
		/^\[/ { insec=($0 ~ /^\[arch-all sources\]/) ? 1 : 0; next }
		insec { l=$0; sub(/#.*$/, "", l); gsub(/[ \t]+/, "", l); if (l==want) { found=1 } }
		END { exit(found ? 0 : 1) }
	' "$EXPECTED"
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
	echo "suffix_scheme: ${SUFFIX_SCHEME}"
	echo "sources: [${SOURCES[*]}]"
	echo "closure_version: ${CLOSURE_VERSION}"
	echo "runtime_closure_size: ${#RUNTIME_PKGS[@]}"
	echo "arch_all_closure_size: ${#ARCH_ALL_RUNTIME_PKGS[@]}"
	echo "index_arches: [${INDEX_ARCHES[*]}]"
	echo "# columns: build_arch  package  source  version  role  filename  sha256"
	echo "# build_arch 'all' => the artifact enters EVERY index arch; otherwise its own only."
} > "$OUT"

total_all=0
total_runtime=0
total_arch_all=0
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

	# A build directory is either an INDEX-ARCH directory (arm64/amd64, holding the four
	# upstream sources' arch-dependent debs) or the single ARCH-ALL directory. Every check
	# below is scoped to its kind: without that, build/all would be required to contain
	# modemmanager and every per-arch dir would be required to contain the companion.
	dir_is_arch_all=0
	[ "$arch" = "all" ] && dir_is_arch_all=1

	# (a) No runtime package of this directory's kind may be absent.
	if [ "$dir_is_arch_all" -eq 1 ]; then
		required_pkgs=("${ARCH_ALL_RUNTIME_PKGS[@]}")
	else
		required_pkgs=("${RUNTIME_PKGS[@]}")
	fi
	for pkg in "${required_pkgs[@]}"; do
		[ -n "${FILE_OF[$pkg]:-}" ] || { echo "generate-release-manifest: MISSING runtime deb '$pkg' for $arch" >&2; exit 2; }
	done

	# (b) Every produced package must map to a known source (else it is unexpected).
	while IFS= read -r p; do
		[ -n "$p" ] || continue
		[ -n "${SOURCE_OF[$p]:-}" ] || { echo "generate-release-manifest: FAIL CLOSED — [$arch] produced package '$p' is in no expected all-artifact set" >&2; rc=3; }
	done <<< "$produced_sorted"

	# (c) Per-source EQUALITY: produced set for this source == its all-artifact set,
	#     over only the sources that belong in THIS directory's kind.
	for src in "${SOURCES[@]}"; do
		if is_arch_all_source "$src"; then
			[ "$dir_is_arch_all" -eq 1 ] || continue
		else
			[ "$dir_is_arch_all" -eq 0 ] || continue
		fi
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
		if is_runtime "$pkg"; then
			role=runtime
			if [ "$dir_is_arch_all" -eq 1 ]; then
				total_arch_all=$((total_arch_all + 1))
			else
				total_runtime=$((total_runtime + 1))
			fi
		else
			role=aux
		fi
		printf '%s  %s  %s  %s  %s  %s  %s\n' "$arch" "$pkg" "${SOURCE_OF[$pkg]:-UNKNOWN}" "$ver" "$role" "$fn" "$sha" >> "$OUT"
		total_all=$((total_all + 1))
	done <<< "$produced_sorted"

	unset FILE_OF
done

{
	echo "# build_dirs: ${arches_seen[*]:-none}"
	echo "# all_debs_total: ${total_all}  arch_runtime_rows: ${total_runtime}  arch_all_runtime_rows: ${total_arch_all}"
} >> "$OUT"

[ "$total_all" -gt 0 ] || { echo "generate-release-manifest: no debs found under $BUILD_ROOT" >&2; exit 2; }
if [ "$rc" -ne 0 ]; then
	echo "generate-release-manifest: STOP — produced package set != frozen all-artifact sets." >&2
	exit "$rc"
fi

cat "$OUT"
echo "generate-release-manifest: wrote $OUT (${total_all} deb rows; ${total_runtime} arch-runtime + ${total_arch_all} arch-all runtime; build dirs: ${arches_seen[*]})" >&2
