#!/usr/bin/env bash
# contract.sh — the packaging container lane (bookworm) entry point.
#
# STUB (Wave A1): the real ModemManager-stack recipes and their contract tests (metadata /
# dependency closure / upgrade / rollback semantics / build ordering / daemon smoke) land in
# the packaging wave. Until then this lane asserts the packaging scaffold is present and that
# the tag-guard + version-injection scripts are wired and pass, so the container lane runs
# something real and stays green.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"

echo "packaging contract lane (Wave A1 stub)"
echo "  packaging root: $PKG_ROOT"

fail=0
require() {
	if [ -e "$PKG_ROOT/$1" ]; then
		echo "  ok:      $1"
	else
		echo "  MISSING: $1"
		fail=1
	fi
}

require "README.md"
require "ci/tag-guard.sh"
require "ci/test-tag-guard.sh"
require "ci/inject-deb-version.sh"

# The tag-guard contract must hold.
echo "  running tag-guard contract..."
bash "$HERE/test-tag-guard.sh" >/dev/null

# The version-injection script must run in dev mode without real recipes present.
echo "  running version-injection (dev)..."
bash "$HERE/inject-deb-version.sh" --dev >/dev/null

if [ "$fail" -eq 0 ]; then
	echo "PASS: packaging scaffold present; tag-guard + version-injection wired"
else
	echo "FAIL: packaging scaffold incomplete"
	exit 1
fi
