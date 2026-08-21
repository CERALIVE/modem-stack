#!/usr/bin/env bash
# inject-deb-version.sh — inject one selected source's CeraLive rebuild version.
#
# Release suffixes are per-source counters: <upstream>-<rev>~ceralive.N. N is derived from
# EVERY previous-manifest row for that source (both arches, runtime and aux), and is accepted
# only when those rows are coherent. Entirely legacy rows (~ceraliveX.Y.Z), or an absent previous
# manifest during the force-all bootstrap, initialize at .1. Non-tag builds keep the fixed
# ~ceralive0.0.0~dev suffix.
#
# Usage:
#   PREV_MANIFEST_FILE=release-manifest.txt \
#     inject-deb-version.sh --source libqmi vX.Y.Z
#   inject-deb-version.sh --source modemmanager --dev
#
# Source names are upstream-pins.yaml pin keys. The ModemManager recipe-directory mapping is
# deliberately non-identity. The previous manifest is an input seam supplied by the caller; this
# script never resolves or downloads a release independently.
set -euo pipefail

LOG_PREFIX="inject-deb-version"
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

SOURCE_KEYS=(libqrtr-glib libmbim libqmi modemmanager)
recipe_dir() { case "$1" in modemmanager) echo ModemManager ;; *) echo "$1" ;; esac; }

usage() {
	echo "usage: inject-deb-version.sh --source <libqrtr-glib|libmbim|libqmi|modemmanager> <vX.Y.Z|X.Y.Z|--dev>"
}

SOURCE=""
VERSION_ARG=""
while [ $# -gt 0 ]; do
	case "$1" in
	--source)
		shift
		[ $# -gt 0 ] || die "--source requires a pin-key name"
		[ -z "$SOURCE" ] || die "--source was supplied more than once"
		SOURCE="$1"
		;;
	--source=*)
		[ -z "$SOURCE" ] || die "--source was supplied more than once"
		SOURCE="${1#--source=}"
		;;
	-h | --help)
		usage
		exit 0
		;;
	--dev | v* | [0-9]*)
		[ -z "$VERSION_ARG" ] || die "version argument was supplied more than once ('$VERSION_ARG' then '$1')"
		VERSION_ARG="$1"
		;;
	*) die "unknown argument '$1'" ;;
	esac
	shift
done

[ -n "$SOURCE" ] || die "--source is required (version injection is per-source and may only touch a source being built)"
[ -n "$VERSION_ARG" ] || die "a release version or --dev is required"

known=0
for key in "${SOURCE_KEYS[@]}"; do
	if [ "$key" = "$SOURCE" ]; then known=1; break; fi
done
[ "$known" -eq 1 ] || die "unknown source '$SOURCE' (expected one of: ${SOURCE_KEYS[*]})"

derive_release_suffix() { # <source>
	local source_name="$1" manifest version kind="" counter="" next
	local versions=()

	if [ -z "${PREV_MANIFEST_FILE:-}" ]; then
		log "source '$source_name': no previous manifest supplied (force-all bootstrap); initializing counter at .1"
		printf '%s\n' '~ceralive.1'
		return 0
	fi

	manifest="$PREV_MANIFEST_FILE"
	[ -r "$manifest" ] ||
		die "source '$source_name': PREV_MANIFEST_FILE='$manifest' is set but not readable"

	mapfile -t versions < <(
		awk -v source_name="$source_name" \
			'$0 !~ /^#/ && NF==7 && $1 !~ /:$/ && $3==source_name { print $4 }' "$manifest"
	)
	if [ "${#versions[@]}" -eq 0 ]; then
		refuse "source '$source_name' is being rebuilt but previous manifest '$manifest' contains ZERO rows for it; no counter can be derived"
	fi

	for version in "${versions[@]}"; do
		if [[ "$version" =~ ~ceralive\.([1-9][0-9]*)$ ]]; then
			if [ "$kind" = legacy ]; then
				refuse "source '$source_name' mixes counter and legacy suffixes across its previous-manifest rows (encountered '$version')"
			fi
			kind=counter
			if [ -z "$counter" ]; then
				counter="${BASH_REMATCH[1]}"
			elif [ "$counter" != "${BASH_REMATCH[1]}" ]; then
				refuse "source '$source_name' has differing counters in its previous-manifest rows (.$counter vs .${BASH_REMATCH[1]}); refusing to risk a downgrade"
			fi
		elif [[ "$version" =~ ~ceralive[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
			if [ "$kind" = counter ]; then
				refuse "source '$source_name' mixes counter and legacy suffixes across its previous-manifest rows (encountered '$version')"
			fi
			kind=legacy
		else
			refuse "source '$source_name' has malformed previous-manifest version '$version'; expected terminal '~ceralive.[1-9][0-9]*' or legacy '~ceraliveX.Y.Z'"
		fi
	done

	if [ "$kind" = legacy ]; then
		log "source '$source_name': all ${#versions[@]} previous-manifest row(s) use the legacy suffix; initializing counter at .1"
		printf '%s\n' '~ceralive.1'
		return 0
	fi

	next=$((10#$counter + 1))
	log "source '$source_name': all ${#versions[@]} previous-manifest row(s) agree on counter .$counter; next counter is .$next"
	printf '~ceralive.%s\n' "$next"
}

if [ "$VERSION_ARG" = --dev ]; then
	SUFFIX="~ceralive0.0.0~dev"
else
	# Reuse the tag guard so release invocation syntax is rejected identically everywhere. The
	# tag no longer supplies the suffix: release provenance lives in the manifest, while the
	# package version records this source's rebuild count.
	# shellcheck source=./tag-guard.sh
	source "$HERE/tag-guard.sh"
	case "$VERSION_ARG" in
	v*) validate_tag "$VERSION_ARG" >/dev/null ;;
	*) validate_tag "v$VERSION_ARG" >/dev/null ;;
	esac
	SUFFIX="$(derive_release_suffix "$SOURCE")"
fi

DIR="$(recipe_dir "$SOURCE")"
CHANGELOG="$PKG_ROOT/$DIR/debian/changelog"
[ -r "$CHANGELOG" ] || die "source '$SOURCE' changelog '$CHANGELOG' is not readable"
command -v dpkg-parsechangelog >/dev/null 2>&1 || die "source '$SOURCE': dpkg-parsechangelog is not installed"
command -v dch >/dev/null 2>&1 || die "source '$SOURCE': dch is not installed"

TOP="$(dpkg-parsechangelog -l "$CHANGELOG" -S Version)"
BASE="${TOP%%~ceralive*}"
VERSION="${BASE}${SUFFIX}"
log "source '$SOURCE': $TOP -> $VERSION"
(cd "$PKG_ROOT/$DIR" && dch --force-bad-version --newversion "$VERSION" "CeraLive rebuild")
log "source '$SOURCE': injected suffix '$SUFFIX'"
