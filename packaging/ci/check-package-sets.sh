#!/usr/bin/env bash
# check-package-sets.sh <changes-dir> [expected-packages.txt] — exact per-source package-set
# EQUALITY enforcement for the ModemManager stack rebuild.
#
# WHAT IT DOES
#   For every *.changes in <changes-dir>, reads its `Source:` and `Binary:` fields and asserts
#   the produced binary package set EQUALS, with no additions / removals / renames, the
#   `[<source> all-artifact]` set frozen in expected-packages.txt (the two-set model finalized
#   in todo 1.4: declared arch-dependent stanzas + enumerated -dbgsym outputs).
#
# WHY EQUALITY, NOT A COUNT
#   A `>=` or count-based check passes an add+remove that nets to the same size (a silent
#   rename, or a dropped runtime package masked by a new -dbgsym). Set EQUALITY catches it and
#   names the exact offending package.
#
# USED BY
#   build-bookworm.sh (in-container, after the runtime-closure check — fail-closed on drift)
#   and standalone on the host against build/<arch>/ for per-arch equality evidence + the
#   set-equality negative drill.
#
# EXIT
#   0  every source's set == its finalized all-artifact set.
#   3  a set differs (names the source + the exact missing/unexpected packages).
#   2  usage / unreadable input / a source with no [all-artifact] block.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHANGES_DIR="${1:-}"
EXPECTED="${2:-$HERE/expected-packages.txt}"

[ -n "$CHANGES_DIR" ] && [ -d "$CHANGES_DIR" ] || {
	echo "usage: check-package-sets.sh <changes-dir> [expected-packages.txt]" >&2; exit 2; }
[ -r "$EXPECTED" ] || { echo "check-package-sets: cannot read '$EXPECTED'" >&2; exit 2; }

# Source name from a .changes `Source:` field (drops any trailing "(version)").
changes_source() { awk '/^Source:/ { print $2; exit }' "$1"; }

# Binary package names from a .changes `Binary:` field (RFC822, fold-safe), sorted-unique.
changes_binaries() {
	awk '
		/^[A-Za-z][A-Za-z0-9-]*:/ { inb=0 }
		/^Binary:/ { inb=1; l=$0; sub(/^Binary:[ \t]*/, "", l); print l; next }
		inb && /^[ \t]/ { l=$0; sub(/^[ \t]+/, "", l); print l }
	' "$1" | tr ' ' '\n' | sed '/^$/d' | sort -u
}

# The `[<source> all-artifact]` block of expected-packages.txt (inline/# comments stripped).
expected_set() {
	awk -v want="[$1 all-artifact]" '
		/^\[/ { h=$0; sub(/[ \t]*#.*$/, "", h); insec=(h==want)?1:0; next }
		insec { l=$0; sub(/#.*$/, "", l); gsub(/[ \t]+/, "", l); if (l!="") print l }
	' "$EXPECTED" | sort -u
}

shopt -s nullglob
changes_files=("$CHANGES_DIR"/*.changes)
[ "${#changes_files[@]}" -gt 0 ] || { echo "check-package-sets: no *.changes in $CHANGES_DIR" >&2; exit 2; }

rc=0
for ch in "${changes_files[@]}"; do
	src="$(changes_source "$ch")"
	got="$(changes_binaries "$ch")"
	want="$(expected_set "$src")"
	echo "== ${src} (from $(basename "$ch")) =="
	if [ -z "$want" ]; then
		echo "FAIL [${src}] no [${src} all-artifact] block in $(basename "$EXPECTED")" >&2
		rc=3; continue
	fi
	echo "  expected all-artifact set ($(printf '%s\n' "$want" | grep -c .)):"
	printf '%s\n' "$want" | sed 's/^/    /'
	echo "  produced binary set ($(printf '%s\n' "$got" | grep -c .)):"
	printf '%s\n' "$got" | sed 's/^/    /'
	if [ "$want" = "$got" ]; then
		echo "  EQUAL: OK"
	else
		echo "FAIL [${src}] package-set inequality (produced != finalized all-artifact):" >&2
		comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$got") \
			| sed 's/^/  MISSING (expected, not built): /' >&2 || true
		comm -13 <(printf '%s\n' "$want") <(printf '%s\n' "$got") \
			| sed 's/^/  UNEXPECTED (built, not expected): /' >&2 || true
		rc=3
	fi
done

echo
if [ "$rc" -eq 0 ]; then
	echo "PACKAGE-SET EQUALITY OK: every source .changes set == its finalized all-artifact set."
else
	echo "STOP: package-set equality failed (see MISSING/UNEXPECTED above)." >&2
fi
exit "$rc"
