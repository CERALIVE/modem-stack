#!/usr/bin/env bash
# The FCC reconciler's BEHAVIOUR contract, runnable on any host.
#
# The chroot contract (`test-companion-chroot.sh` § 6) proves the reconciler works
# from its PACKAGED location after a real dpkg install. This script proves the same
# logic against the source file with every path redirected into a scratch tree, so it
# needs no container, no root and no ModemManager — which is what makes it usable as
# the pre-bench proof for the todo-33 policy work and as a fast local gate.
#
# Both are kept: this one can be run in a second, that one proves the packaging.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# CERALIVE_FCC_RECONCILE_BIN lets the SAME suite run against a copy that is not
# beside this script — the INSTALLED helper on a bench board, which is how the
# packaged path gets exercised without a container.
RECONCILE="${CERALIVE_FCC_RECONCILE_BIN:-$HERE/../ceralive-modem-support/assets/fcc/ceralive-fcc-reconcile}"
[ -x "$RECONCILE" ] || { echo "not executable: $RECONCILE" >&2; exit 1; }

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ceralive-fcc-reconcile.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

AVAILABLE="$ROOT/available"
ACTIVE="$ROOT/active"
POLICY="$ROOT/data/ceralive/fcc-unlock-policy.json"
mkdir -p "$AVAILABLE" "$(dirname "$POLICY")"

# The available tier's real shape: one script per VENDOR, plus a `<vid>:<pid>` symlink
# onto it for every model that vendor script covers. The dispatcher opens ONLY the
# `<vid>:<pid>` name, which is why the policy keys on it.
printf '#!/bin/sh\nexit 0\n' > "$AVAILABLE/2c7c"
chmod +x "$AVAILABLE/2c7c"
ln -sfn 2c7c "$AVAILABLE/2c7c:0801"
ln -sfn 2c7c "$AVAILABLE/2c7c:0313"

run() {
  CERALIVE_FCC_POLICY_FILE="$POLICY" \
  CERALIVE_FCC_AVAILABLE_DIR="$AVAILABLE" \
  CERALIVE_FCC_ACTIVE_DIR="$ACTIVE" \
  "$RECONCILE" 2>&1
}

write_policy() { printf '%s\n' "$1" > "$POLICY"; }

echo "-- absent policy: exit 0, activate nothing --"
rm -rf "$ACTIVE"; rm -f "$POLICY"
if out="$(run)"; then ok "exit 0 with no policy"; else bad "non-zero exit with no policy"; fi
[ -z "$(find "$ACTIVE" -type l 2>/dev/null)" ] && ok "no link created" || bad "a link appeared with no policy"

echo "-- an absent AVAILABLE tier is a clean no-op (generic Debian) --"
if CERALIVE_FCC_POLICY_FILE="$POLICY" CERALIVE_FCC_AVAILABLE_DIR="$ROOT/nope" \
   CERALIVE_FCC_ACTIVE_DIR="$ACTIVE" "$RECONCILE" >/dev/null 2>&1; then
  ok "exit 0 with no ModemManager available tier"
else
  bad "non-zero exit with no available tier"
fi

echo "-- enabling policy: exactly the enabled MODEL, in the ADMIN tier --"
write_policy '{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c:0801":true,"2c7c:0313":false}}'
run >/dev/null
[ -L "$ACTIVE/2c7c:0801" ] && ok "2c7c:0801 activated" || bad "2c7c:0801 not activated"
[ -e "$ACTIVE/2c7c:0313" ] && bad "disabled model was activated" || ok "disabled model stayed inactive"
[ -e "$ACTIVE/2c7c" ] && bad "a vendor-only name was linked" || ok "no vendor-only link (the dispatcher never opens one)"
[ "$(readlink "$ACTIVE/2c7c:0801")" = "$AVAILABLE/2c7c:0801" ] \
  && ok "the link targets the available tier's model entry" \
  || bad "unexpected link target: $(readlink "$ACTIVE/2c7c:0801")"

echo "-- a single-entry policy is not read as an empty one --"
rm -rf "$ACTIVE"
write_policy '{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c:0801":true}}'
run >/dev/null
[ -L "$ACTIVE/2c7c:0801" ] && ok "one-model policy activated" || bad "one-model policy activated nothing"

echo "-- re-running is idempotent --"
before="$(readlink "$ACTIVE/2c7c:0801")"
run >/dev/null
[ "$(readlink "$ACTIVE/2c7c:0801")" = "$before" ] && ok "second run left the link unchanged" || bad "second run changed the link"

echo "-- opt-out removes what the previous run created --"
write_policy '{"schemaVersion":1,"savedAtMs":2,"unlock":{"2c7c:0801":false}}'
run >/dev/null
[ -e "$ACTIVE/2c7c:0801" ] && bad "opt-out left the link behind" || ok "opt-out deactivated the model"

echo "-- a malformed policy is treated as absent, and says so --"
write_policy '{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c:0801":true}}'
run >/dev/null
write_policy '{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c:0801":yes}}'
out="$(run)"
[ -e "$ACTIVE/2c7c:0801" ] && bad "malformed policy left an active link" || ok "malformed policy activated nothing"
printf '%s' "$out" | grep -q 'malformed' && ok "malformed policy announced" || bad "no malformed announcement"

echo "-- a vendor-only KEY names a file the dispatcher never opens, and is refused --"
rm -rf "$ACTIVE"
write_policy '{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c":true}}'
out="$(run)"
[ -e "$ACTIVE/2c7c" ] && bad "a vendor-only key was activated" || ok "vendor-only key refused"
printf '%s' "$out" | grep -q 'malformed' && ok "vendor-only key reported as malformed" || bad "vendor-only key silently ignored"

echo "-- an enabled model MM ships no script for is skipped, loudly --"
rm -rf "$ACTIVE"
write_policy '{"schemaVersion":1,"savedAtMs":1,"unlock":{"1199:9079":true}}'
out="$(run)"
[ -e "$ACTIVE/1199:9079" ] && bad "a link was created for an absent script" || ok "absent script skipped"
printf '%s' "$out" | grep -q 'ships no' && ok "the skip was announced" || bad "the skip was silent"

echo "-- a foreign REAL file in the ADMIN tier is left alone --"
mkdir -p "$ACTIVE"
printf '#!/bin/sh\nexit 0\n' > "$ACTIVE/2c7c:0801"
write_policy '{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c:0801":true}}'
run >/dev/null
[ -L "$ACTIVE/2c7c:0801" ] && bad "a foreign real file was replaced" || ok "foreign real file untouched"
rm -f "$ACTIVE/2c7c:0801"

echo "-- a foreign SYMLINK pointing outside the available tier is left alone --"
printf 'x\n' > "$ROOT/elsewhere"
ln -sfn "$ROOT/elsewhere" "$ACTIVE/1199:9079"
write_policy '{"schemaVersion":1,"savedAtMs":1,"unlock":{}}'
run >/dev/null
[ -L "$ACTIVE/1199:9079" ] && ok "foreign symlink untouched" || bad "a foreign symlink was pruned"

echo
echo "== fcc-reconcile: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
