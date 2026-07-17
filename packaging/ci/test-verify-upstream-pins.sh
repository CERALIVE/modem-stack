#!/usr/bin/env bash
# test-verify-upstream-pins.sh — executable proof that verify-upstream-pins.sh FAILS CLOSED.
#
# Runs the four negative fixtures under ci/fixtures/ and asserts that each makes the verifier
# exit non-zero AND print the correct NAMED failing field on stderr:
#
#   wrong-signer       -> FAIL [modemmanager] signer_fingerprint: signer mismatch …
#   altered-dsc        -> FAIL [modemmanager] dsc_signature:      signature invalid (BADSIG) …
#   altered-orig       -> FAIL [modemmanager] orig_tar_sha256:    checksum mismatch …
#   altered-salsa-tree -> FAIL [libqrtr-glib] debian_tree:        salsa vs .debian.tar.xz differ …
#
# The first three trip a link-1/2/3 tamper; altered-salsa-tree passes links 1–3 and trips the
# 4th (PACKAGING) link — a hash-valid .debian.tar.xz whose debian/ tree diverges (a dropped
# executable bit on debian/rules) from the fixture's local salsa comparison tree.
#
# Fixtures are OFFLINE: they use `local:` URLs (files packaged next to each fixture manifest)
# and are run with --no-lineage, so this test needs no network and isolates the one tamper it
# targets. The real acceptance run (verify-upstream-pins.sh with no flags) does the full
# network verification and is exercised by ci/contract.sh, not here.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"          # packaging/  (holds keys/)
FIX="$HERE/fixtures"
VERIFY="$HERE/verify-upstream-pins.sh"

rc=0

# assert_reject <fixture-dir> <expected-field> <expected-substring> [source-name]
#   Runs the verifier on <fixture-dir>/pins.yaml and requires: non-zero exit, a
#   `FAIL [<source>] <expected-field>:` line, and <expected-substring> somewhere in stderr.
#   <source-name> defaults to modemmanager (the source keyed by the first three fixtures);
#   the tree-equality fixture keys its stanza `libqrtr-glib`, so it passes that name.
assert_reject() {
	local dir="$1" field="$2" needle="$3" src="${4:-modemmanager}"
	local manifest="$FIX/$dir/pins.yaml" out ec
	out="$(bash "$VERIFY" --no-lineage --source "$src" --keys-base "$PKG_ROOT" "$manifest" 2>&1)"
	ec=$?
	if [ "$ec" -eq 0 ]; then
		echo "FAIL:   '$dir' unexpectedly PASSED (exit 0) — fail-closed broken"
		rc=1
		return
	fi
	if ! printf '%s\n' "$out" | grep -q "FAIL \[$src\] $field:"; then
		echo "FAIL:   '$dir' rejected but not on field '$field'; got:"
		printf '        %s\n' "$out" | tail -1
		rc=1
		return
	fi
	if ! printf '%s\n' "$out" | grep -qi "$needle"; then
		echo "FAIL:   '$dir' rejected on '$field' but message lacked '$needle'"
		rc=1
		return
	fi
	echo "ok:     REJECT '$dir' (exit $ec) -> $(printf '%s\n' "$out" | grep -o "FAIL \[$src\] $field:.*" | sed "s/^FAIL \[$src\] //")"
}

assert_reject wrong-signer       signer_fingerprint "signer mismatch"
assert_reject altered-dsc        dsc_signature      "signature invalid"
assert_reject altered-orig       orig_tar_sha256    "checksum mismatch"
assert_reject altered-salsa-tree debian_tree        "executable-bit"     libqrtr-glib

if [ "$rc" -eq 0 ]; then
	echo "PASS: verify-upstream-pins fails closed on wrong-signer / altered-.dsc / altered-.orig.tar / altered-salsa-tree"
else
	echo "FAIL: fail-closed contract violated"
fi
exit "$rc"
