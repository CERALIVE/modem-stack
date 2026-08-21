#!/usr/bin/env bash
# Cross-compile the bench CLI and the smoke harness for amd64 + arm64.
#
# Bun 1.4.0 cross-compiles with `--compile --target=bun-linux-<x64|arm64>` (verified:
# the target flag downloads the matching bun runtime and emits a standalone ELF for that
# architecture). Outputs land in cli/dist/ (gitignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="${ROOT}/cli/dist"
mkdir -p "${DIST}"
cd "${ROOT}"

for pair in "x64:amd64" "arm64:arm64"; do
	bun_target="bun-linux-${pair%%:*}"
	arch="${pair##*:}"
	echo "== compiling modem-control (${arch}) =="
	bun build --compile --target="${bun_target}" --outfile="${DIST}/modem-control-${arch}" cli/src/index.ts
	echo "== compiling modem-control-smoke (${arch}) =="
	bun build --compile --target="${bun_target}" --outfile="${DIST}/modem-control-smoke-${arch}" cli/smoke/harness.ts
done

echo "== built binaries =="
ls -1 "${DIST}"
