#!/usr/bin/env bash
# contract.sh — the packaging PR lane (bookworm container, ci-packaging.yml).
#
# This is the LIGHTWEIGHT gate that runs on every packaging PR without building any .deb:
# it needs no docker-in-docker and no built artifacts. It asserts the packaging scaffold is
# present, the tag-guard contract holds, the dch version-injection works on a COPY (never
# the committed source tree), and the tilde version ordering is real.
#
# The HEAVY, deb-consuming contract — metadata / closure install / upgrade / rollback /
# coherence / piuparts and the daemon smoke — lives in ci/test-package-contract.sh and
# ci/daemon-smoke.sh. Those each launch their own debian:bookworm container against the
# A5.1 build output and run inside release.yml's build-deb job (which has the host docker
# daemon), not in this container-based PR lane.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"

echo "packaging PR contract lane (bookworm)"
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
require "BOOKWORM-ADAPTATIONS.md"
require "ci/tag-guard.sh"
require "ci/test-tag-guard.sh"
require "ci/read-pin.sh"
require "ci/inject-deb-version.sh"
require "ci/build-bookworm.sh"
require "ci/test-package-contract.sh"
require "ci/daemon-smoke.sh"
require "ci/generate-release-manifest.sh"

# The tag-guard contract must hold.
echo "  running tag-guard contract..."
bash "$HERE/test-tag-guard.sh" >/dev/null

# Reading the base here also runs read-pin.sh's changelog-top vs salsa_tag cross-check on every
# PR-lane run, so a `-1`-vs-`-2` revision drift fails closed before any ordering proof.
MM_BASE="$(bash "$HERE/read-pin.sh" modemmanager --base-version)"
echo "  ok: pin reader resolves ModemManager base $MM_BASE (changelog top == salsa_tag suffix)"

# Version injection must run WITHOUT mutating the committed debian/changelog files. Now that
# the recipes carry real changelogs (A5.1), `inject-deb-version.sh --dev` would dch-rewrite
# the source-of-truth tree if run in place — so run it against a throwaway COPY and then
# prove the committed changelogs are byte-for-byte unchanged.
echo "  running version-injection (dev) on a COPY (committed tree must stay pristine)..."
export DEBEMAIL="${DEBEMAIL:-ci@ceralive.tv}" DEBFULLNAME="${DEBFULLNAME:-CeraLive CI}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for item in "$PKG_ROOT"/*; do
	[ "$(basename "$item")" = build ] && continue   # skip the (gitignored) .deb output
	cp -a "$item" "$TMP/"
done
if command -v dch >/dev/null 2>&1; then
	( cd "$TMP" && bash ci/inject-deb-version.sh --dev >/dev/null )
	# The copy's changelogs must now carry the dev suffix; the SOURCE tree must not.
	for src in ModemManager libmbim libqmi libqrtr-glib; do
		cl="$PKG_ROOT/$src/debian/changelog"
		[ -f "$cl" ] || continue
		if grep -q '~ceralive' "$cl"; then
			echo "  FAIL: committed $src/debian/changelog was mutated by injection"; fail=1
		fi
		if ! grep -q '~ceralive0.0.0~dev' "$TMP/$src/debian/changelog" 2>/dev/null; then
			echo "  FAIL: injection did not write the dev suffix into the copy for $src"; fail=1
		fi
	done
	echo "  ok: injection wrote to the copy; committed changelogs untouched"
else
	# No devscripts here (e.g. a non-container run) — document instead of failing.
	echo "  note: dch not present; skipping live injection (runs in the bookworm PR lane)"
fi

# Real tilde-ordering proofs (dpkg is present in the bookworm lane). These are the invariant
# the encoded ~ceralive<X.Y.Z> version depends on; a broken comparator would silently invert
# release ordering.
if command -v dpkg >/dev/null 2>&1; then
	echo "  running dpkg --compare-versions ordering proofs (base $MM_BASE, pin-derived)..."
	ord_ok() { dpkg --compare-versions "$1" lt "$2" || { echo "  FAIL: '$1' !lt '$2'"; fail=1; }; }
	ord_ok "${MM_BASE}~ceralive0.1.0" "${MM_BASE}~ceralive0.2.0"
	ord_ok "${MM_BASE}~ceralive0.9.0" "${MM_BASE}~ceralive0.10.0"
	ord_ok "${MM_BASE}~ceralive0.1.0" "${MM_BASE}"
	if dpkg --compare-versions "${MM_BASE}~ceralive0.2.0" lt "${MM_BASE}~ceralive0.1.0"; then
		echo "  FAIL: comparator is always-true (0.2.0 lt 0.1.0)"; fail=1
	fi
	echo "  ok: tilde ordering holds"
fi

if [ "$fail" -eq 0 ]; then
	echo "PASS: scaffold present; tag-guard + non-mutating injection + version ordering wired"
else
	echo "FAIL: packaging PR contract lane"
	exit 1
fi
