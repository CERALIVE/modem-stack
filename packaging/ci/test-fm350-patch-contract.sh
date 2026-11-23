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

grep -Fq '+    info = mm_fm350gl_parse_cgcontrdp_response (response, ctx->cid, &error);' "$PATCH" ||
	fail 'FM350 bearer does not parse +CGCONTRDP with its own lenient parser'
if grep -Fq '+    if (!response || !mm_3gpp_parse_cgcontrdp_response' "$PATCH"; then
	fail 'FM350 bearer regressed to the generic +CGCONTRDP parser, which rejects an empty bearer id'
fi
grep -Fq '+    g_test_add_func ("/MM/fm350gl/cgcontrdp/tmobile", test_cgcontrdp_tmobile);' "$PATCH" ||
	fail 'FM350 patch lost the empty-bearer-id +CGCONTRDP regression test'

printf 'PASS: FM350 patch preserves the hardware-required Z0 first-enable override\n'

printf 'PASS: FM350 patch keeps the lenient +CGCONTRDP parser and its regression test\n'
