#!/usr/bin/env bash
# test-tag-guard.sh — executable proof that the release-tag guard accepts ONLY vX.Y.Z.
#
# Locks the negative cases from docs/VERSIONING.md:
#   v1.0.0        -> ACCEPT   (canonical)
#   v0.1.0        -> ACCEPT
#   v12.34.56     -> ACCEPT
#   v1.0.0-rc.1   -> REJECT   (pre-release inverts dpkg ordering)
#   v1.0.0+build5 -> REJECT   (build metadata is not part of the .deb version contract)
#   1.0.0         -> REJECT   (missing v prefix)
#   v1.0          -> REJECT   (not three-part)
#   v1.0.0.0      -> REJECT   (four-part)
#   vderp / ""    -> REJECT   (garbage / empty)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./tag-guard.sh
source "$HERE/tag-guard.sh"
set +e # sourcing tag-guard.sh enables `set -e`; the assertions below manage their own rc.

rc=0

assert_accept() {
	if out="$(validate_tag "$1" 2>/dev/null)"; then
		echo "ok:     ACCEPT '$1' -> '$out'"
	else
		echo "FAIL:   expected ACCEPT for '$1'"
		rc=1
	fi
}

assert_reject() {
	if validate_tag "$1" >/dev/null 2>&1; then
		echo "FAIL:   expected REJECT for '$1'"
		rc=1
	else
		echo "ok:     REJECT '$1'"
	fi
}

assert_accept "v1.0.0"
assert_accept "v0.1.0"
assert_accept "v12.34.56"

assert_reject "v1.0.0-rc.1"
assert_reject "v1.0.0+build5"
assert_reject "1.0.0"
assert_reject "v1.0"
assert_reject "v1.0.0.0"
assert_reject "vderp"
assert_reject ""

if [ "$rc" -eq 0 ]; then
	echo "PASS: tag guard accepts only vX.Y.Z"
else
	echo "FAIL: tag guard contract violated"
fi
exit "$rc"
