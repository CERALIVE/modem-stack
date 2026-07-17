#!/usr/bin/env bash
# daemon-smoke.sh <amd64|arm64> — start the rebuilt ModemManager on a real system bus
# and prove it is a working daemon, not just an installable file set.
#
# Inside a throwaway `debian:bookworm` container it installs system D-Bus + polkit +
# NetworkManager (bookworm ships 1.42.4 — the plan's "NM 1.42") and the A5.1 build output,
# then:
#   * starts a system dbus-daemon and the ModemManager daemon on it;
#   * `busctl introspect` the MM service at its root path -> the ObjectManager interface;
#   * `mmcli --version` reports the PINNED ModemManager upstream version (read-pin.sh, never
#     hardcoded — it tracks upstream-pins.yaml automatically across bumps);
#   * the udev-rules + FCC-unlock dispatcher directories exist at their install paths;
#   * the GIR typelib (gir1.2-modemmanager-1.0) and the Vala .vapi (libmm-glib-dev) are present.
#
# There is no modem hardware in CI, so MM starts with zero modems — the root ObjectManager
# is still exported, which is exactly what the smoke asserts. amd64 only by default
# (apt-install + daemon start under arm64 QEMU is too slow for a runner; arm64 daemon smoke
# is a bench/HIL item, see cli/ A6.1).
#
# EXIT  0 smoke green. 2 usage/env. non-zero = a smoke failure.
set -euo pipefail

# ==========================================================================================
# HOST ROLE — launch the container.
# ==========================================================================================
if [ "${IN_CONTAINER:-0}" != "1" ]; then
	ARCH="${1:-amd64}"
	case "$ARCH" in
		amd64) PLATFORM="linux/amd64" ;;
		arm64) PLATFORM="linux/arm64" ;;
		*) echo "usage: daemon-smoke.sh <amd64|arm64>" >&2; exit 2 ;;
	esac
	HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	PKG_ROOT="$(cd "$HERE/.." && pwd)"
	BUILD_DIR="${BUILD_DIR:-$PKG_ROOT/build/$ARCH}"

	command -v docker >/dev/null 2>&1 || { echo "smoke: docker not found" >&2; exit 2; }
	ls "$BUILD_DIR"/*.deb >/dev/null 2>&1 || {
		echo "smoke: no .deb in $BUILD_DIR — run ci/build-bookworm.sh $ARCH first" >&2; exit 2; }

	echo "======================================================================"
	echo "daemon smoke   arch=$ARCH"
	echo "  build dir: $BUILD_DIR"
	echo "======================================================================"

	# --privileged is NOT required: a plain container can run its own dbus-daemon + MM.
	docker run --rm --platform "$PLATFORM" \
		-e IN_CONTAINER=1 -e ARCH="$ARCH" \
		-v "$PKG_ROOT":/pkg:ro \
		-v "$BUILD_DIR":/debs:ro \
		debian:bookworm \
		bash /pkg/ci/daemon-smoke.sh "$ARCH"

	echo
	echo "======================================================================"
	echo "DAEMON SMOKE PASS [$ARCH]"
	echo "======================================================================"
	exit 0
fi

# ==========================================================================================
# CONTAINER ROLE — install, start the daemon, assert.
# ==========================================================================================
ARCH="${ARCH:-$(dpkg --print-architecture)}"
export DEBIAN_FRONTEND=noninteractive
case "$ARCH" in amd64) MA=x86_64-linux-gnu ;; arm64) MA=aarch64-linux-gnu ;; *) MA="$(dpkg --print-architecture)-linux-gnu" ;; esac

echo
echo "== in-container daemon smoke (arch=$(dpkg --print-architecture), multiarch=$MA) =="

echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/01-no-sandbox
apt-get update -qq

# System bus (dbus), busctl (systemd), polkit, NetworkManager 1.42, mmcli deps, and dpkg-dev
# (dpkg-scanpackages for the local repo). --no-install-recommends keeps NM from pulling stock
# modemmanager back in as a recommend.
echo "-- installing system D-Bus + polkit + NetworkManager (bookworm 1.42) + tooling --"
apt-get install -y -qq --no-install-recommends \
	dbus systemd policykit-1 network-manager \
	dpkg-dev iproute2 udev ca-certificates >/tmp/base.log 2>&1 || { sed 's/^/    /' /tmp/base.log; echo "FAIL: base install"; exit 1; }

NM_VER="$(dpkg-query -W -f='${Version}' network-manager 2>/dev/null || echo '?')"
echo "-- NetworkManager installed: $NM_VER"

# Local repo of the built stack, pinned above bookworm-main (coherent ceralive set wins).
REPO=/tmp/localrepo
rm -rf "$REPO"; mkdir -p "$REPO"; cp /debs/*.deb "$REPO/"
( cd "$REPO" && dpkg-scanpackages -m . /dev/null > Packages 2>/dev/null )
echo "deb [trusted=yes] file:$REPO ./" > /etc/apt/sources.list.d/local-mm.list
printf 'Package: *\nPin: origin ""\nPin-Priority: 1001\n' > /etc/apt/preferences.d/local-mm.pref
apt-get update -qq

echo "-- installing rebuilt MM 1.24 runtime + GIR + dev (for typelib/.vapi) --"
apt-get install -y -qq --allow-downgrades \
	modemmanager libmm-glib0 libmbim-glib4 libmbim-proxy libmbim-utils \
	libqmi-glib5 libqmi-proxy libqmi-utils libqrtr-glib0 \
	gir1.2-modemmanager-1.0 libmm-glib-dev >/tmp/mm.log 2>&1 || { sed 's/^/    /' /tmp/mm.log; echo "FAIL: MM install"; exit 1; }
echo "-- modemmanager installed: $(dpkg-query -W -f='${Version}' modemmanager)"

fail=0
ok()   { echo "  ok: $*"; }
bad()  { echo "  FAIL: $*"; fail=1; }

# ---- start a system D-Bus, then the ModemManager daemon on it ----------------------------
echo
echo "==== starting system D-Bus + ModemManager daemon ===="
mkdir -p /run/dbus
dbus-uuidgen --ensure=/etc/machine-id
dbus-daemon --system --fork
sleep 1
[ -S /run/dbus/system_bus_socket ] && ok "system bus socket up" || bad "no system bus socket"

# polkit is installed (plan: "polkit installed"); start it too for realism (best-effort).
if [ -x /usr/lib/polkit-1/polkitd ]; then /usr/lib/polkit-1/polkitd --no-debug >/tmp/polkitd.log 2>&1 & sleep 1; ok "polkitd started (pid $!)"; fi

# MM daemon in the background; poll until it owns its well-known name (<= ~15s).
/usr/sbin/ModemManager --debug >/tmp/mm-daemon.log 2>&1 &
MM_PID=$!
owned=0
for _ in $(seq 1 30); do
	if busctl --system list 2>/dev/null | grep -q org.freedesktop.ModemManager1; then owned=1; break; fi
	kill -0 "$MM_PID" 2>/dev/null || { echo "  MM daemon exited early; log:"; sed 's/^/    /' /tmp/mm-daemon.log; break; }
	sleep 0.5
done
[ "$owned" -eq 1 ] && ok "ModemManager owns org.freedesktop.ModemManager1 (pid $MM_PID)" || bad "MM never acquired its bus name"

# ---- ASSERTION 1: busctl introspect shows ObjectManager at the root path ------------------
echo
echo "==== busctl introspect (root ObjectManager) ===="
INTRO="$(busctl --system introspect org.freedesktop.ModemManager1 /org/freedesktop/ModemManager1 2>/tmp/introspect.err || true)"
echo "$INTRO" | sed 's/^/    /'
if echo "$INTRO" | grep -q 'org.freedesktop.DBus.ObjectManager'; then ok "root path exposes org.freedesktop.DBus.ObjectManager"; else sed 's/^/    /' /tmp/introspect.err; bad "ObjectManager interface not found at root"; fi

# ---- ASSERTION 2: mmcli --version reports the PINNED upstream version --------------------
echo
echo "==== mmcli --version ===="
# Derived from upstream-pins.yaml (never hardcoded): the mounted /pkg tree carries read-pin.sh.
MM_TAG="$(bash "$(dirname "${BASH_SOURCE[0]}")/read-pin.sh" modemmanager upstream_tag)"
MM_TAG_RE="${MM_TAG//./\\.}"
MMCLI_V="$(mmcli --version 2>&1 | head -1)"
echo "    $MMCLI_V  (expecting pinned upstream $MM_TAG)"
echo "$MMCLI_V" | grep -qE "(^|[^0-9.])${MM_TAG_RE}([^0-9]|\$)" && ok "mmcli reports $MM_TAG" || bad "mmcli version is not $MM_TAG"

# ---- ASSERTION 3: udev-rules + FCC-unlock dispatcher directories at install paths --------
echo
echo "==== udev / FCC-unlock install paths ===="
ls /usr/lib/udev/rules.d/77-mm-*.rules >/dev/null 2>&1 && ok "udev rules present (/usr/lib/udev/rules.d/77-mm-*.rules)" || bad "udev rules missing"
[ -d /etc/ModemManager/fcc-unlock.d ]                && ok "FCC-unlock dispatcher dir (/etc/ModemManager/fcc-unlock.d)" || bad "FCC-unlock dispatcher dir missing"
[ -d /usr/share/ModemManager/fcc-unlock.available.d ] && ok "FCC-unlock available dir (/usr/share/ModemManager/fcc-unlock.available.d)" || bad "FCC-unlock available dir missing"

# ---- ASSERTION 4: GIR typelib + Vala .vapi in the installed file set ----------------------
echo
echo "==== GIR / Vala artifacts ===="
TYPELIB="/usr/lib/${MA}/girepository-1.0/ModemManager-1.0.typelib"
[ -f "$TYPELIB" ]                                 && ok "GIR typelib present ($TYPELIB)" || bad "GIR typelib missing ($TYPELIB)"
[ -f /usr/share/gir-1.0/ModemManager-1.0.gir ]    && ok "GIR xml present (/usr/share/gir-1.0/ModemManager-1.0.gir)" || bad "GIR xml missing"
[ -f /usr/share/vala/vapi/libmm-glib.vapi ]        && ok "Vala .vapi present (/usr/share/vala/vapi/libmm-glib.vapi)" || bad "Vala .vapi missing"

# ---- teardown ----------------------------------------------------------------------------
kill "$MM_PID" 2>/dev/null || true

echo
if [ "$fail" -eq 0 ]; then
	echo "IN-CONTAINER DAEMON SMOKE PASS [$ARCH]  (NetworkManager $NM_VER)"
else
	echo "IN-CONTAINER DAEMON SMOKE FAIL [$ARCH]" >&2
	exit 1
fi
