#!/usr/bin/env bash
# test-verify-upstream-pins.sh — executable proof that verify-upstream-pins.sh FAILS CLOSED.
#
# Runs the three negative fixtures under ci/fixtures/ and asserts that each makes the verifier
# exit non-zero AND print the correct NAMED failing field on stderr:
#
#   wrong-signer  -> FAIL [modemmanager] signer_fingerprint: signer mismatch …
#   altered-dsc   -> FAIL [modemmanager] dsc_signature:      signature invalid (BADSIG) …
#   altered-orig  -> FAIL [modemmanager] orig_tar_sha256:    checksum mismatch …
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

# assert_reject <fixture-dir> <expected-field> <expected-substring>
#   Runs the verifier on <fixture-dir>/pins.yaml and requires: non-zero exit, a
#   `FAIL [..] <expected-field>:` line, and <expected-substring> somewhere in stderr.
assert_reject() {
	local dir="$1" field="$2" needle="$3"
	local manifest="$FIX/$dir/pins.yaml" out ec
	out="$(bash "$VERIFY" --no-lineage --source modemmanager --keys-base "$PKG_ROOT" "$manifest" 2>&1)"
	ec=$?
	if [ "$ec" -eq 0 ]; then
		echo "FAIL:   '$dir' unexpectedly PASSED (exit 0) — fail-closed broken"
		rc=1
		return
	fi
	if ! printf '%s\n' "$out" | grep -q "FAIL \[modemmanager\] $field:"; then
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
	echo "ok:     REJECT '$dir' (exit $ec) -> $(printf '%s\n' "$out" | grep -o "FAIL \[modemmanager\] $field:.*" | sed 's/^FAIL \[modemmanager\] //')"
}

assert_reject wrong-signer signer_fingerprint "signer mismatch"
assert_reject altered-dsc  dsc_signature      "signature invalid"
assert_reject altered-orig orig_tar_sha256    "checksum mismatch"

if [ "$rc" -eq 0 ]; then
	echo "PASS: verify-upstream-pins fails closed on wrong-signer / altered-.dsc / altered-.orig.tar"
else
	echo "FAIL: fail-closed contract violated"
fi
exit "$rc"
