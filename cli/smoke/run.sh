#!/usr/bin/env bash
# Run the cross-arch D-Bus probe smoke: amd64 native + arm64 under Docker QEMU, plus a
# negative-bundle sanity run that MUST fail (proving the smoke exercises the real dep).
#
# amd64 runs the compiled smoke harness natively under dbus-run-session; the harness
# spawns the SHIPPED compiled `modem-control probe` against a fake ModemManager and then
# proves signal reception + source-unavailable-vs-removal in-process. arm64 runs the SAME
# compiled arm64 binaries inside `docker run --platform linux/arm64` (A5.1's proven QEMU
# path), so the arm64 build's real D-Bus handshake is exercised, not just designed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="${ROOT}/cli/dist"
ARM64_IMAGE="${SMOKE_ARM64_IMAGE:-debian:trixie-slim}"

"${ROOT}/cli/smoke/build-binaries.sh"

echo
echo "== amd64 native probe smoke =="
dbus-run-session -- "${DIST}/modem-control-smoke-amd64" --cli "${DIST}/modem-control-amd64"

echo
echo "== arm64 QEMU probe smoke (docker --platform linux/arm64) =="
docker run --rm --platform linux/arm64 -v "${DIST}:/w:ro" "${ARM64_IMAGE}" bash -c '
	set -e
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq >/dev/null
	apt-get install -y -qq dbus >/dev/null
	dbus-run-session -- /w/modem-control-smoke-arm64 --cli /w/modem-control-arm64
'

echo
echo "== negative-bundle sanity (MUST fail — proves the smoke is not a no-op) =="
if dbus-run-session -- "${DIST}/modem-control-smoke-amd64" --cli "${DIST}/modem-control-amd64" --negative; then
	echo "NEGATIVE SANITY FAILED: the smoke passed against a broken fixture (no-op smoke)"
	exit 1
fi
echo "NEGATIVE SANITY OK: the smoke correctly detected the broken dependency"

echo
echo "ALL SMOKE CHECKS PASSED"
