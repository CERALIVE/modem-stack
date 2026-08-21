#!/usr/bin/env bash
# read-pin.sh — dependency-free reader for packaging/upstream-pins.yaml + the Debian base.
#
# THREE MODES
#   read-pin.sh <source> <field>          Print a scalar field of a source from upstream-pins.yaml
#                                         (e.g. `read-pin.sh modemmanager upstream_tag` -> 1.24.2).
#   read-pin.sh <source> --base-version   Print the FULL Debian base `<upstream>-<rev>` (e.g.
#                                         1.24.2-2) taken from that source's debian/changelog TOP
#                                         entry, cross-checked to equal the pin's salsa_tag suffix
#                                         (`debian/1.24.2-2` -> `1.24.2-2`). Mismatch FAILS CLOSED.
#   read-pin.sh --list-sources            Print the pinned source NAMES, one per line, in manifest
#                                         order. Exposes the reader's own `yaml_sources` so a
#                                         caller that must iterate every source (e.g.
#                                         check-upstream-freshness.sh) does not grow a second
#                                         copy of the YAML parser to enumerate the keys.
#
# WHY A SHARED READER
#   The packaging CI assertion scripts (daemon-smoke.sh, test-package-contract.sh, contract.sh)
#   used to hardcode the pinned versions. When the pins move (they just did: MM 1.24.0-1 ->
#   1.24.2-2, libmbim 1.32.0 -> 1.34.0, libqmi 1.36.0 -> 1.38.0, libqrtr-glib 1.2.2 -> 1.4.0),
#   those literals silently rot — worst of all a `-1` revision assertion against a real `-2`
#   build. Routing every assertion through this one reader makes the pin the single source of
#   truth and makes a stale-or-wrong-revision literal impossible.
#
# YAML PARSER PARITY
#   yaml_scalar / yaml_sources below are kept BYTE-IDENTICAL to
#   packaging/ci/verify-upstream-pins.sh's own readers. That verifier is frozen (todo 1.1), so
#   the parser is duplicated here rather than factored out of it — it is the SAME parser, never
#   a second, subtly-different one. Keep the two copies in lockstep if either is ever touched.
#
# DEPENDENCY-FREE
#   bash + awk only (like the verifier). No dpkg / devscripts — so it runs unchanged on the
#   Arch dev host and inside the bookworm CI container alike.
#
# EXIT
#   0  value printed on stdout.
#   1  unknown source, unknown/empty field, or a base-version cross-check mismatch (fail-closed,
#      reason on stderr).
#   2  usage / unreadable manifest or changelog.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"
MANIFEST="$PKG_ROOT/upstream-pins.yaml"

if [ "${1-}" = "--list-sources" ]; then
	MODE="list-sources"; SRC=""; FIELD=""
else
	[ $# -ge 2 ] || {
		echo "read-pin: usage: read-pin.sh <source> <field|--base-version> | read-pin.sh --list-sources" >&2
		exit 2
	}
	MODE="scalar"; SRC="$1"; FIELD="$2"
fi
[ -r "$MANIFEST" ] || { echo "read-pin: cannot read manifest '$MANIFEST'" >&2; exit 2; }

# ---- tiny dependency-free YAML readers (byte-identical to verify-upstream-pins.sh) ---------
# Scalar field of a source:  sources.<src>.<field>  ->  unquoted value.
yaml_scalar() {
	awk -v src="$1" -v key="$2" '
		$0 ~ "^  " src ":[ \t]*$" { inblk=1; next }
		inblk && /^  [^ ]/ { inblk=0 }
		inblk && /^[^ ]/   { inblk=0 }
		inblk && $0 ~ "^    " key ":" {
			v=$0; sub("^    " key ":[ \t]*", "", v); gsub(/^"|"$/, "", v); print v; exit
		}
	' "$MANIFEST"
}
# The list of source names under `sources:`.
yaml_sources() {
	awk '
		/^sources:[ \t]*$/ { ins=1; next }
		ins && /^[^ ]/ { ins=0 }
		ins && /^  [^ ]+:[ \t]*$/ { s=$0; sub(/^  /, "", s); sub(/:[ \t]*$/, "", s); print s }
	' "$MANIFEST"
}

if [ "$MODE" = "list-sources" ]; then
	names="$(yaml_sources)"
	[ -n "$names" ] || { echo "read-pin: no sources found in $MANIFEST" >&2; exit 1; }
	printf '%s\n' "$names"
	exit 0
fi

# The pinned source must exist (fail-closed on a typo'd / wrong source name).
src_known=0
while IFS= read -r s; do
	[ "$s" = "$SRC" ] && { src_known=1; break; }
done < <(yaml_sources)
[ "$src_known" -eq 1 ] || { echo "read-pin: unknown source '$SRC' (not in $MANIFEST)" >&2; exit 1; }

# Map a pin source name to its checked-in debian/ recipe directory (only MM differs in case).
recipe_dir() {
	case "$1" in
		modemmanager) echo "ModemManager" ;;
		*)            echo "$1" ;;
	esac
}

if [ "$FIELD" = "--base-version" ]; then
	# (1) Full Debian base from the changelog TOP entry: `<source> (<version>) <dist>; ...`.
	rdir="$(recipe_dir "$SRC")"
	changelog="$PKG_ROOT/$rdir/debian/changelog"
	[ -r "$changelog" ] || { echo "read-pin: cannot read changelog '$changelog'" >&2; exit 2; }
	cl_ver="$(awk 'NR==1 { if (match($0, /\(([^)]+)\)/)) print substr($0, RSTART+1, RLENGTH-2); exit }' "$changelog")"
	cl_base="${cl_ver%%~ceralive*}"   # strip any injected ~ceralive suffix -> pure <upstream>-<rev>
	[ -n "$cl_base" ] || { echo "read-pin: could not parse a version from the top of $changelog" >&2; exit 1; }
	# (2) Cross-check vs the pin's salsa_tag suffix:  debian/1.24.2-2 -> 1.24.2-2.
	salsa_tag="$(yaml_scalar "$SRC" salsa_tag)"
	salsa_base="${salsa_tag#debian/}"
	[ -n "$salsa_base" ] || { echo "read-pin: [$SRC] has no salsa_tag in $MANIFEST" >&2; exit 1; }
	if [ "$cl_base" != "$salsa_base" ]; then
		echo "read-pin: [$SRC] base-version mismatch — changelog top '$cl_base' != salsa_tag suffix '$salsa_base'" >&2
		exit 1
	fi
	printf '%s\n' "$cl_base"
	exit 0
fi

# Plain scalar field.
val="$(yaml_scalar "$SRC" "$FIELD")"
[ -n "$val" ] || { echo "read-pin: [$SRC] field '$FIELD' not found or empty in $MANIFEST" >&2; exit 1; }
printf '%s\n' "$val"
