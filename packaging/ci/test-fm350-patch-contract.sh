#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$HERE/../ModemManager/debian/patches/0001-fm350gl-forward-port-rndis-bearer-and-modes.patch"

fail() {
	printf 'FAIL: %s\n' "$1" >&2
	exit 1
}

grep -Fq '+enabling_modem_init (MMBroadbandModem' "$PATCH" ||
	fail 'FM350 patch does not override the first-enable modem initialization'
grep -Fq '+                                   "Z0",' "$PATCH" ||
	fail 'FM350 first-enable override does not send the hardware-proven Z0 command'
grep -Fq '+    broadband_modem_class->enabling_modem_init = enabling_modem_init;' "$PATCH" ||
	fail 'FM350 class does not install the first-enable override'

if grep -Fq '+                                   "Z",' "$PATCH"; then
	fail 'FM350 override regressed to Z, which this firmware rejects with CME 59'
fi

printf 'PASS: FM350 patch preserves the hardware-required Z0 first-enable override\n'
