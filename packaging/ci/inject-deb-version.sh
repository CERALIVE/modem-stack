#!/usr/bin/env bash
# inject-deb-version.sh — write the CeraLive-encoded version into each source's
# debian/changelog top entry.
#
# Encoded version: <upstream>-<rev>~ceralive<X.Y.Z>  (see docs/VERSIONING.md).
# The tilde makes it sort BELOW the pinned <upstream>-<rev> changelog top, so plain
# `dch --newversion` REFUSES it (dch(1) rejects a lower-than-current version). Hence
# `--force-bad-version` is REQUIRED, not optional. All four sources take the same suffix.
#
# Usage:
#   inject-deb-version.sh vX.Y.Z    # release: suffix ~ceraliveX.Y.Z
#   inject-deb-version.sh X.Y.Z     # same (leading v optional)
#   inject-deb-version.sh --dev     # non-tag CI: fixed suffix ~ceralive0.0.0~dev
#
# The 4 repackaged sources are ModemManager, libmbim, libqmi, libqrtr-glib. Their upstream
# versions are NOT hardcoded here — each is read from that source's own debian/changelog
# top entry (added in the packaging wave). Until those recipes exist, this script documents
# the exact `dch` invocation per source and exits 0.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"

# Names only — versions/pins are provenance-verified in a later task, never hardcoded here.
SOURCES=(ModemManager libmbim libqmi libqrtr-glib)

arg="${1-}"
if [ -z "$arg" ]; then
	echo "usage: inject-deb-version.sh <vX.Y.Z|X.Y.Z|--dev>" >&2
	exit 2
fi

if [ "$arg" = "--dev" ]; then
	SUFFIX="~ceralive0.0.0~dev"
else
	# Reuse the tag guard so a bad version is rejected identically everywhere.
	# shellcheck source=./tag-guard.sh
	source "$HERE/tag-guard.sh"
	case "$arg" in
	v*) XYZ="$(validate_tag "$arg")" ;;
	*) XYZ="$(validate_tag "v$arg")" ;;
	esac
	SUFFIX="~ceralive${XYZ}"
fi

echo "inject-deb-version: suffix ${SUFFIX}"

injected=0
pending=0
for src in "${SOURCES[@]}"; do
	changelog="$PKG_ROOT/$src/debian/changelog"
	if [ -f "$changelog" ]; then
		# Derive <upstream>-<rev> from the top entry, strip any prior ~ceralive suffix,
		# then append ours.
		top="$(dpkg-parsechangelog -l "$changelog" -S Version)"
		base="${top%%~ceralive*}"
		version="${base}${SUFFIX}"
		echo "  ${src}: ${top} -> ${version}"
		(cd "$PKG_ROOT/$src" && dch --force-bad-version --newversion "$version" "CeraLive rebuild")
		injected=$((injected + 1))
	else
		# No recipe yet (packaging wave). Document the exact invocation this WILL run.
		echo "  ${src}: no debian/changelog yet — will run:"
		echo "      dch --force-bad-version --newversion \"<upstream>-1${SUFFIX}\" \"CeraLive rebuild\""
		pending=$((pending + 1))
	fi
done

echo "inject-deb-version: ${injected} injected, ${pending} pending recipes"
