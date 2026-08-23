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
require "ci/detect-changed-sources.sh"
require "ci/test-detect-changed-sources.sh"
require "ci/stage-carryforward-debs.sh"
require "ci/test-stage-carryforward-debs.sh"
require "ci/read-pin.sh"
require "ci/inject-deb-version.sh"
require "ci/build-bookworm.sh"
require "ci/test-build-bookworm-differential.sh"
require "ci/test-package-contract.sh"
require "ci/daemon-smoke.sh"
require "ci/generate-release-manifest.sh"
require "ci/suffix-contract.sh"
require "ci/test-suffix-coherence-manifest.sh"
require "ci/test-release-workflow-wiring.sh"
require "ci/test-fm350-patch-contract.sh"
require "ci/check-upstream-freshness.sh"
require "ci/test-check-upstream-freshness.sh"
require "ci/build-companion.sh"
require "ci/test-companion-chroot.sh"
require "ci/companion-inventory.txt"
require "ceralive-modem-support/debian/control"
require "ceralive-modem-support/debian/rules"
require "ceralive-modem-support/debian/legacy-etc-overrides.sha256"
require "ceralive-modem-support/assets/udev/60-ceralive-modem.rules"
require "ceralive-modem-support/assets/systemd/ceralive-fcc-reconcile.service"
require "ceralive-modem-support/assets/fcc/ceralive-fcc-reconcile"

# The companion's udev rules file may never carry a device MUTATION. This is a text contract
# because the failure it prevents — a generic package writing device permissions or running a
# command from udev — is invisible to every other gate in this repo.
echo "  running companion udev no-mutation contract..."
if grep -nE '^[^#]*(RUN\+?=|MODE=|OWNER=|GROUP=|SYMLINK\+?=|ATTR\{[^}]+\}=[^=])' \
     "$PKG_ROOT/ceralive-modem-support/assets/udev/60-ceralive-modem.rules"; then
	echo "  MUTATION FOUND in 60-ceralive-modem.rules — the companion tags devices, it never mutates them"
	fail=1
else
	echo "  ok: companion udev rules are identification/tagging only"
fi

# The packaged basename must not collide with an image-owned /etc/udev/rules.d basename: udev
# resolves by basename and an /etc file shadows the packaged one in a way dpkg -S cannot see.
echo "  running companion udev basename contract..."
for reserved in 99-ceralive-hardware.rules 78-mm-ceralive-slot-uid.rules; do
	if [ -e "$PKG_ROOT/ceralive-modem-support/assets/udev/$reserved" ]; then
		echo "  RESERVED BASENAME: the companion must not ship $reserved (image-owned)"
		fail=1
	fi
done
echo "  ok: companion ships no image-owned udev basename"

# The tag-guard contract must hold.
echo "  running tag-guard contract..."
bash "$HERE/test-tag-guard.sh" >/dev/null

# The differential-release change detector must hold. It builds its own throwaway git repo and
# stubs `gh` on PATH, so it needs no docker, no network and no built .deb — which is exactly why
# it belongs in this lightweight lane rather than the deb-consuming suite.
echo "  running change-detection contract..."
bash "$HERE/test-detect-changed-sources.sh" >/dev/null

# The carry-forward stager must hold. It builds its own fixture manifest + GitHub-mangled asset
# dir and drives the script through the PREV_MANIFEST_FILE / CARRYFORWARD_ASSET_DIR seams, so it
# needs no docker, no network and no built .deb — the same reason the detector's test lives here.
echo "  running carry-forward staging contract..."
bash "$HERE/test-stage-carryforward-debs.sh" >/dev/null

# The differential builder contract stubs only the expensive source-build body. Build-set parsing,
# carry seeding, bootstrap dispatch, counter derivation, package-set checking and merged closure all
# run through their production paths, with no docker or network.
echo "  running differential build + rebuild-counter contract..."
bash "$HERE/test-build-bookworm-differential.sh" >/dev/null

# The per-source suffix + mixed-version manifest contract. It stages placeholder debs and runs the
# real generate-release-manifest.sh over them, and proves the migration-continuity ordering with
# real `dpkg --compare-versions` — no docker, no network, no built .deb. The same suffix-contract.sh
# library backs test-package-contract.sh's CHECK 5/6, so the heavy lane cannot drift from this one.
echo "  running per-source suffix coherence + mixed-version manifest contract..."
bash "$HERE/test-suffix-coherence-manifest.sh" >/dev/null

# The release.yml wiring proof is STATIC — it reads the workflow text and never dispatches a run.
# It belongs in this lane because the invariant it guards (carry-forward staged before every
# build-bookworm.sh call) fails SILENTLY: a late stage still produces a green release, built
# against stock bookworm dependencies instead of the carried ones.
echo "  running release.yml differential wiring contract..."
bash "$HERE/test-release-workflow-wiring.sh" >/dev/null

echo "  running FM350 patch contract..."
bash "$HERE/test-fm350-patch-contract.sh" >/dev/null

# The upstream freshness proof is offline and fixture-driven, so it needs no docker, no network
# and no built .deb — exactly the kind of invariant this lightweight lane should exercise.
echo "  running upstream freshness contract..."
bash "$HERE/test-check-upstream-freshness.sh" >/dev/null

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
	for source_key in libqrtr-glib libmbim libqmi modemmanager; do
		( cd "$TMP" && bash ci/inject-deb-version.sh --source "$source_key" --dev >/dev/null )
	done
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
