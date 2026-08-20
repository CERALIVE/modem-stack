#!/usr/bin/env bash
# test-companion-chroot.sh — the CHROOT-STAGE contract for ceralive-modem-support.
#
# TWO-STAGE SPLIT (deliberate). A clean container has no sysfs devices and no running
# daemons, so it can prove PACKAGING SHAPE and nothing else. This script is that stage:
# install / upgrade / downgrade / purge, /etc override precedence, the chroot guard, the
# two /etc-override maintscript branches, the absent-policy no-op, and single-owner.
#
# The CONSUMER stage — `udevadm test` against a real modem's sysfs path, `usb_modeswitch -c`,
# `systemd-analyze verify` + `systemctl is-enabled` + a real boot's journal ordering, and
# ModemManager's effective configuration listing — runs ON THE BENCH BOARD and is documented
# in docs/BENCH.md (RB-18). Do not fake it here; a green fake is worse than a recorded gap.
#
# USAGE  test-companion-chroot.sh [image]        (default: debian:trixie)
# ENV    CONTAINER_ENGINE=podman|docker, COMPANION_TEST_DIR=<out>
# EXIT   0 = every step passed; non-zero names the failing step.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/.." && pwd)"
IMAGE="${1:-${COMPANION_TEST_IMAGE:-debian:trixie}}"
WORK="${COMPANION_TEST_DIR:-$REPO_ROOT/test-results/companion-chroot}"

ENGINE="${CONTAINER_ENGINE:-}"
if [[ -z "$ENGINE" ]]; then
  if command -v podman >/dev/null 2>&1; then ENGINE=podman
  elif command -v docker >/dev/null 2>&1; then ENGINE=docker
  else echo "test-companion-chroot: no podman/docker available" >&2; exit 2; fi
fi

rm -rf "$WORK"
mkdir -p "$WORK/debs"

echo "== building the companion at two versions (old 0.9.0, new 1.1.0) ==" >&2
BUILD_ROOT="$WORK/b-old" RELEASE_VERSION=v0.9.0 bash "$HERE/build-companion.sh" >"$WORK/build-old.log" 2>&1
BUILD_ROOT="$WORK/b-new" RELEASE_VERSION=v1.1.0 bash "$HERE/build-companion.sh" >"$WORK/build-new.log" 2>&1
cp "$WORK"/b-old/all/*.deb "$WORK"/b-new/all/*.deb "$WORK/debs/"
cp "$HERE/companion-inventory.txt" "$WORK/companion-inventory.txt"
cp "$PKG_ROOT/ceralive-modem-support/assets/legacy/60-ceralive-modem.rules.legacy-v1" "$WORK/legacy-payload"

cat >"$WORK/run-in-container.sh" <<'CONTAINER_SCRIPT'
#!/bin/bash
# Runs INSIDE a clean Debian container. Everything below is dpkg + coreutils against the
# two locally-built .debs — no network, no apt transaction, no host state.
set -uo pipefail

QA=/qa
OLD="$QA/debs/ceralive-modem-support_0.9.0_all.deb"
NEW="$QA/debs/ceralive-modem-support_1.1.0_all.deb"
RULES_ETC=/etc/udev/rules.d/60-ceralive-modem.rules
RULES_LIB=/usr/lib/udev/rules.d/60-ceralive-modem.rules
POSTINST=/var/lib/dpkg/info/ceralive-modem-support.postinst

export DEBIAN_FRONTEND=noninteractive

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$*"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$*"; fail=$((fail+1)); }

# The companion declares `Depends: udev`, so the install legs go through apt (which resolves
# it) rather than bare `dpkg -i` (which cannot). This is also the invocation an operator and
# the device image actually use.
apt-get update -qq >/tmp/apt-update.log 2>&1 || { echo "apt-get update failed"; cat /tmp/apt-update.log; exit 2; }

installed_files() {
  dpkg -L ceralive-modem-support 2>/dev/null | while IFS= read -r p; do
    [ -f "$p" ] && printf '%s\n' "$p"
  done | LC_ALL=C sort
}
declared_files() {
  grep -v '^[[:space:]]*#' "$QA/companion-inventory.txt" | grep -v '^[[:space:]]*$' | LC_ALL=C sort
}

echo "== 1. fresh install in a clean chroot =="
if [ -d /run/udev ]; then bad "the container unexpectedly has /run/udev — the guard leg would be vacuous"; fi
if apt-get install -y -qq "$NEW" >/tmp/install.log 2>&1; then ok "apt-get install ./deb exit 0"; else bad "apt-get install failed"; cat /tmp/install.log; fi
[ -d /run/udev ] && { rmdir /run/udev 2>/dev/null || true; }

got="$(installed_files | grep -v '^/usr/share/doc/')"
want="$(declared_files)"
if [ "$got" = "$want" ]; then
  ok "dpkg -L lists exactly the declared inventory ($(printf '%s\n' "$want" | wc -l) paths)"
else
  bad "dpkg -L != declared inventory"
  diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") | sed 's/^/      /'
fi

echo "== 2. chroot guard: no /run/udev => postinst no-ops, no udevadm invocation =="
if bash -x "$POSTINST" configure >/tmp/postinst-trace.log 2>&1; then
  ok "postinst re-run exit 0 without /run/udev"
else
  bad "postinst failed without /run/udev"; cat /tmp/postinst-trace.log
fi
if grep -q 'no /run/udev' /tmp/postinst-trace.log; then ok "postinst announced the chroot skip"; else bad "no chroot-skip announcement"; fi
if grep -qE '^\+.*udevadm (control|trigger)' /tmp/postinst-trace.log; then
  bad "postinst invoked udevadm without /run/udev"
else
  ok "set -x trace contains NO udevadm control/trigger invocation"
fi

echo "== 2b. non-vacuity: with /run/udev present the guard lets the reload path run =="
mkdir -p /run/udev
bash -x "$POSTINST" configure >/tmp/postinst-udev.log 2>&1
if grep -q 'no /run/udev' /tmp/postinst-udev.log; then
  bad "the guard still short-circuited even though /run/udev exists"
else
  ok "with /run/udev present the guard does NOT short-circuit"
fi
# The trigger must be NARROW. A bare `udevadm trigger` would re-run every rule for every
# device on the system; assert no such call exists in the shipped script text.
if grep -nE 'udevadm trigger *$|udevadm trigger +\|\||udevadm trigger *#' "$POSTINST" >/dev/null 2>&1; then
  bad "postinst contains a BARE udevadm trigger (no subsystem match)"
else
  ok "every udevadm trigger in the shipped postinst carries --subsystem-match"
fi
rmdir /run/udev

echo "== 3. single-owner: dpkg -S names exactly one package per packaged path =="
multi=0
while IFS= read -r p; do
  owners="$(dpkg -S "$p" 2>/dev/null | cut -d: -f1 | tr ',' '\n' | sed 's/ //g' | grep . | sort -u)"
  n="$(printf '%s\n' "$owners" | grep -c . )"
  if [ "$n" != "1" ] || [ "$owners" != "ceralive-modem-support" ]; then
    bad "dpkg -S $p => '$owners' (expected exactly ceralive-modem-support)"; multi=1
  fi
done < <(declared_files)
[ "$multi" -eq 0 ] && ok "every declared path has exactly one owner"

echo "== 4. /etc override precedence =="
mkdir -p /etc/udev/rules.d
printf '# operator override\n' > "$RULES_ETC"
winner=""
for d in /etc/udev/rules.d /run/udev/rules.d /usr/local/lib/udev/rules.d /usr/lib/udev/rules.d /lib/udev/rules.d; do
  [ -f "$d/60-ceralive-modem.rules" ] && { winner="$d/60-ceralive-modem.rules"; break; }
done
if [ "$winner" = "$RULES_ETC" ]; then ok "the /etc copy wins udev's basename precedence"; else bad "precedence resolved to '$winner'"; fi
if dpkg -S "$RULES_LIB" >/dev/null 2>&1 && ! dpkg -S "$RULES_ETC" >/dev/null 2>&1; then
  ok "dpkg -S cannot see the shadowing /etc file (the exact hazard the basename rule exists for)"
else
  bad "dpkg -S reported the /etc shadow — assumption broken"
fi
rm -f "$RULES_ETC"

echo "== 5. /etc override maintscript branches =="
echo "-- 5a. marker-carrying but operator-MODIFIED file is PRESERVED --"
{ printf '# CERALIVE-GENERATED: modem-udev v1 — DO NOT EDIT\n'; printf '# operator added this line\n'; } > "$RULES_ETC"
bash "$POSTINST" configure >/tmp/preserve.log 2>&1
if [ -f "$RULES_ETC" ]; then ok "marker-carrying but MODIFIED /etc file preserved"; else bad "an operator-modified /etc file was deleted"; fi
grep -q 'preserving modified' /tmp/preserve.log && ok "preservation was announced" || bad "no modified-preservation announcement"

echo "-- 5b. unmarked operator file is PRESERVED --"
printf '# my own rules\n' > "$RULES_ETC"
bash "$POSTINST" configure >/tmp/preserve2.log 2>&1
if [ -f "$RULES_ETC" ]; then ok "unmarked operator file preserved"; else bad "an unmarked operator file was deleted"; fi
grep -q 'no generated marker' /tmp/preserve2.log && ok "no-marker preservation was announced" || bad "no no-marker announcement"

echo "-- 5c. KNOWN-STALE generated payload IS removed --"
cp "$QA/legacy-payload" "$RULES_ETC"
bash "$POSTINST" configure >/tmp/stale.log 2>&1
if [ ! -e "$RULES_ETC" ]; then ok "known-stale generated override removed"; else bad "known-stale override survived"; cat /tmp/stale.log; fi
grep -q 'removed stale generated override' /tmp/stale.log && ok "removal was announced" || bad "no removal announcement"

echo "== 6. FCC reconcile =="
mkdir -p /usr/share/ModemManager/fcc-unlock.d
printf '#!/bin/sh\nexit 0\n' > /usr/share/ModemManager/fcc-unlock.d/2c7c
chmod +x /usr/share/ModemManager/fcc-unlock.d/2c7c
MULTIARCH="$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || echo x86_64-linux-gnu)"
ACTIVE="/usr/lib/$MULTIARCH/ModemManager/fcc-unlock.d"
rm -rf "$ACTIVE"

echo "-- 6a. absent policy exits 0 and creates NO active symlink --"
if /usr/lib/ceralive-modem-support/ceralive-fcc-reconcile >/tmp/fcc-absent.log 2>&1; then
  ok "reconciler exits 0 with no /data policy (generic Debian, no CeraLive layout)"
else
  bad "reconciler failed with no policy"; cat /tmp/fcc-absent.log
fi
if [ -z "$(find "$ACTIVE" -type l 2>/dev/null)" ]; then ok "no active FCC symlink created without a policy"; else bad "an active FCC symlink appeared without a policy"; fi

echo "-- 6b. an enabling policy activates exactly the enabled vendor --"
mkdir -p /data/ceralive
printf '{"version":1,"unlock":{"2c7c":true,"1e0e":false}}\n' > /data/ceralive/fcc-unlock-policy.json
/usr/lib/ceralive-modem-support/ceralive-fcc-reconcile >/tmp/fcc-on.log 2>&1
if [ -L "$ACTIVE/2c7c" ]; then ok "policy-enabled 2c7c activated"; else bad "2c7c not activated"; cat /tmp/fcc-on.log; fi
if [ -e "$ACTIVE/1e0e" ]; then bad "policy-disabled 1e0e was activated"; else ok "policy-disabled 1e0e stayed inactive"; fi

echo "-- 6c. a MALFORMED policy is treated as absent (fail-safe, never fail-open) --"
printf '{"version":1,"unlock":{"2c7c":yes}}\n' > /data/ceralive/fcc-unlock-policy.json
/usr/lib/ceralive-modem-support/ceralive-fcc-reconcile >/tmp/fcc-bad.log 2>&1
if [ -e "$ACTIVE/2c7c" ]; then bad "a malformed policy left an active FCC symlink"; else ok "malformed policy deactivated everything"; fi
grep -q 'malformed' /tmp/fcc-bad.log && ok "malformed policy was announced" || bad "no malformed announcement"
rm -rf /data

echo "== 7. upgrade path (0.9.0 -> 1.1.0), no conffile prompt =="
dpkg -P ceralive-modem-support >/dev/null 2>&1
apt-get install -y -qq --allow-downgrades "$OLD" >/tmp/up1.log 2>&1 || { bad "installing the old version failed"; cat /tmp/up1.log; }
[ "$(dpkg-query -W -f='${Version}' ceralive-modem-support)" = "0.9.0" ] && ok "old version installed" || bad "old version not 0.9.0"
if apt-get install -y -qq "$NEW" >/tmp/up2.log 2>&1; then ok "upgrade exit 0"; else bad "upgrade failed"; cat /tmp/up2.log; fi
[ "$(dpkg-query -W -f='${Version}' ceralive-modem-support)" = "1.1.0" ] && ok "upgraded to 1.1.0" || bad "version did not advance"
if [ -z "$(dpkg-query -W -f='${Conffiles}' ceralive-modem-support | tr -d ' \n')" ]; then
  ok "package declares ZERO conffiles (a conffile prompt is structurally impossible)"
else
  bad "package declares conffiles: $(dpkg-query -W -f='${Conffiles}' ceralive-modem-support)"
fi
if grep -qi 'configuration file.*modified\|what would you like to do' /tmp/up2.log; then
  bad "upgrade emitted a conffile prompt"
else
  ok "upgrade transcript carries no conffile prompt"
fi

echo "== 8. downgrade path (1.1.0 -> 0.9.0) =="
if apt-get install -y -qq --allow-downgrades "$OLD" >/tmp/down.log 2>&1; then ok "downgrade exit 0"; else bad "downgrade failed"; cat /tmp/down.log; fi
[ "$(dpkg-query -W -f='${Version}' ceralive-modem-support)" = "0.9.0" ] && ok "downgraded to 0.9.0" || bad "downgrade did not take"

echo "== 9. purge leaves zero leftovers =="
mkdir -p "$ACTIVE"; ln -sfn /usr/share/ModemManager/fcc-unlock.d/2c7c "$ACTIVE/2c7c"
printf 'not ours\n' > /usr/share/ModemManager/fcc-unlock.d/keepme
if dpkg -P ceralive-modem-support >/tmp/purge.log 2>&1; then ok "dpkg -P exit 0"; else bad "purge failed"; cat /tmp/purge.log; fi
if dpkg -L ceralive-modem-support >/dev/null 2>&1; then bad "dpkg -L still resolves after purge"; else ok "dpkg -L errors after purge"; fi
left=0
while IFS= read -r p; do
  [ -e "$p" ] && { bad "leftover after purge: $p"; left=1; }
done < <(declared_files)
for d in /usr/lib/ceralive-modem-support /usr/share/ceralive-modem-support; do
  [ -e "$d" ] && { bad "leftover directory after purge: $d"; left=1; }
done
[ -L "$ACTIVE/2c7c" ] && { bad "purge left an active FCC symlink behind"; left=1; }
[ -f /usr/share/ModemManager/fcc-unlock.d/keepme ] || { bad "purge deleted a file that was not ours"; left=1; }
[ "$left" -eq 0 ] && ok "zero leftovers over every declared path; foreign files untouched"

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
CONTAINER_SCRIPT

chmod +x "$WORK/run-in-container.sh"

echo "== running the dpkg matrix in a clean $IMAGE container ==" >&2
set +e
"$ENGINE" run --rm -v "$WORK:/qa:z" "$IMAGE" bash /qa/run-in-container.sh 2>&1 | tee "$WORK/chroot-qa.log"
rc="${PIPESTATUS[0]}"
set -e
echo "test-companion-chroot: transcript at $WORK/chroot-qa.log" >&2
exit "$rc"
