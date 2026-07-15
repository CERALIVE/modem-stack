#!/usr/bin/env bash
# build-bookworm.sh <amd64|arm64> — rebuild the ModemManager stack for bookworm.
#
# WHAT IT DOES
#   Builds the four provenance-pinned sources (upstream-pins.yaml) in the mandatory
#   bootstrap order  libqrtr-glib -> libmbim -> libqmi -> modemmanager  inside a
#   `debian:bookworm` container. Each source's freshly built .debs are dropped into a
#   temporary LOCAL apt repo (dpkg-scanpackages + `deb [trusted=yes] file:` line) so the
#   NEXT source's build-deps resolve against the just-built package, not the older
#   bookworm-main version. Real `dpkg-buildpackage` — no faking.
#
# ARCHES (native — never cross)
#   amd64 -> `--platform linux/amd64`; arm64 -> `--platform linux/arm64` (full-system QEMU
#   via the host's binfmt_misc `qemu-aarch64` handler — a genuine aarch64 userland, not a
#   cross-compile).
#
# INPUTS (all under packaging/, this script's parent)
#   <Source>/debian/    the pinned salsa debian/ dir + the bookworm adaptations (ModemManager
#                       only: debhelper relax, systemd-dev->udev, and the systemd/udev
#                       install-dir rules pins — see packaging/BOOKWORM-ADAPTATIONS.md).
#   upstream-pins.yaml  orig_tar_url / orig_tar_name / orig_tar_sha256 per source.
#   ci/inject-deb-version.sh  writes ~ceralive0.0.0~dev (dev build) into each changelog.
#
# OUTPUT
#   Binary .debs + the four *.changes into  $OUT  (default: packaging/build/<arch>, gitignored).
#   The runtime closure is asserted from the *.changes: EXACTLY the 9 runtime packages
#   (modemmanager libmm-glib0 libmbim-{glib4,proxy,utils} libqmi-{glib5,proxy,utils}
#   libqrtr-glib0). Any drift => exit 3 (STOP-and-surface).
#
# USAGE
#   packaging/ci/build-bookworm.sh amd64
#   packaging/ci/build-bookworm.sh arm64
#   OUT=/some/dir packaging/ci/build-bookworm.sh amd64     # override output dir
#
# EXIT
#   0 success (all 4 built, closure == the 9). 2 usage/env. 3 closure drift. non-zero build fail.
set -euo pipefail

# ------------------------------------------------------------------------------------------
# Bootstrap order + the 9-package runtime closure are contract constants.
BUILD_ORDER=(libqrtr-glib libmbim libqmi ModemManager)
EXPECTED_RUNTIME=(libmbim-glib4 libmbim-proxy libmbim-utils libmm-glib0 libqmi-glib5 \
	libqmi-proxy libqmi-utils libqrtr-glib0 modemmanager)

# Map a packaging dir name -> its upstream-pins.yaml source key (only ModemManager differs).
pin_key() { case "$1" in ModemManager) echo modemmanager ;; *) echo "$1" ;; esac; }

# ==========================================================================================
# HOST ROLE — arg parse, launch the container, then post-process the results it wrote.
# ==========================================================================================
if [ "${BUILD_IN_CONTAINER:-0}" != "1" ]; then
	ARCH="${1:-}"
	case "$ARCH" in
		amd64) PLATFORM="linux/amd64" ;;
		arm64) PLATFORM="linux/arm64" ;;
		*) echo "usage: build-bookworm.sh <amd64|arm64>" >&2; exit 2 ;;
	esac

	command -v docker >/dev/null 2>&1 || { echo "build-bookworm: docker not found" >&2; exit 2; }

	HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	PKG_ROOT="$(cd "$HERE/.." && pwd)"
	OUT="${OUT:-$PKG_ROOT/build/$ARCH}"
	mkdir -p "$OUT"
	# Clean any prior artifacts so the closure check sees only this run's output.
	rm -f "$OUT"/*.deb "$OUT"/*.changes "$OUT"/*.buildinfo 2>/dev/null || true

	echo "build-bookworm: arch=$ARCH platform=$PLATFORM"
	echo "build-bookworm: packaging root=$PKG_ROOT"
	echo "build-bookworm: output=$OUT"

	# Mount packaging/ read-only at /pkg; output read-write at /out. Re-invoke self in-container.
	docker run --rm --platform "$PLATFORM" \
		-e BUILD_IN_CONTAINER=1 \
		-e ARCH="$ARCH" \
		-v "$PKG_ROOT":/pkg:ro \
		-v "$OUT":/out \
		debian:bookworm \
		bash /pkg/ci/build-bookworm.sh "$ARCH"

	echo "build-bookworm: container finished; artifacts in $OUT"
	exit 0
fi

# ==========================================================================================
# CONTAINER ROLE — the real build, inside debian:bookworm.
# ==========================================================================================
ARCH="${ARCH:-$(dpkg --print-architecture)}"
echo "== in-container build (arch=$(dpkg --print-architecture), target=$ARCH, $(uname -m)) =="

export DEBIAN_FRONTEND=noninteractive
# nocheck: skip the upstream test phase (needs a live session bus; that is A5.2 daemon-smoke,
#          not a build-time concern). nodoc: skip gtk-doc (arch:all -doc pkgs are not in the
#          runtime closure). Both are standard for a binary rebuild.
NPROC="$(nproc)"
export DEB_BUILD_OPTIONS="nocheck nodoc parallel=$NPROC"
# dch (version injection) needs a maintainer identity; the container has none by default.
export DEBEMAIL="ci@ceralive.tv"
export DEBFULLNAME="CeraLive CI"

log()  { echo "  [build] $*"; }
step() { echo; echo "==== $* ===="; }

# apt drops to the unprivileged `_apt` user for acquire, which cannot read the local
# file: repo under a 0700 mktemp dir — turn the sandbox off (standard container fix).
echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/01-no-sandbox

step "install build tooling"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
	build-essential dpkg-dev devscripts equivs \
	meson ninja-build pkgconf ca-certificates curl xz-utils bzip2 >/dev/null
DPKGBP_VER="$(dpkg-buildpackage --version 2>/dev/null | sed -n '1p' || true)"
log "toolchain ready: $DPKGBP_VER"

# ---- writable copy of the packaging tree (source of truth is the ro mount) ---------------
WORK="$(mktemp -d /tmp/mmbuild.XXXXXX)"
PKGW="$WORK/pkg"
cp -a /pkg "$PKGW"
REPO="$WORK/repo"                 # the temporary LOCAL apt repo
mkdir -p "$REPO"
: > "$REPO/Packages"              # empty index so `apt-get update` is happy before build 1
echo "deb [trusted=yes] file:$REPO ./" > /etc/apt/sources.list.d/local-mm.list
# Prefer the freshly built local packages over bookworm-main for the stack's own libs.
cat > /etc/apt/preferences.d/local-mm.pref <<'EOF'
Package: *
Pin: origin ""
Pin-Priority: 1001
EOF
apt-get update -qq

refresh_repo() {
	( cd "$REPO" && dpkg-scanpackages -m . /dev/null > Packages 2>/dev/null )
	apt-get update -qq
}

# ---- version injection: A1.1's script, run against the writable packaging copy -----------
step "inject dev version (~ceralive0.0.0~dev) via ci/inject-deb-version.sh"
( cd "$PKGW" && bash ci/inject-deb-version.sh --dev )

# ---- tiny pin reader (same awk shape as verify-upstream-pins.sh) -------------------------
pin_scalar() {
	awk -v src="$1" -v key="$2" '
		$0 ~ "^  " src ":[ \t]*$" { inblk=1; next }
		inblk && /^  [^ ]/ { inblk=0 }
		inblk && /^[^ ]/   { inblk=0 }
		inblk && $0 ~ "^    " key ":" {
			v=$0; sub("^    " key ":[ \t]*", "", v); gsub(/^"|"$/, "", v); print v; exit
		}
	' "$PKGW/upstream-pins.yaml"
}

# ---- build one source -------------------------------------------------------------------
build_one() {
	local dir="$1" key; key="$(pin_key "$dir")"
	step "BUILD $dir  (pin key: $key)"

	# Resolve the injected source + upstream version from the (now version-injected) changelog.
	local src ver upstream
	src="$(dpkg-parsechangelog -l "$PKGW/$dir/debian/changelog" -S Source)"
	ver="$(dpkg-parsechangelog -l "$PKGW/$dir/debian/changelog" -S Version)"
	upstream="${ver%%-*}"                         # strip -<rev>~ceralive...
	log "source=$src version=$ver upstream=$upstream"

	# Fetch + verify the provenance-pinned orig tarball.
	local url name sha
	url="$(pin_scalar "$key" orig_tar_url)"
	name="$(pin_scalar "$key" orig_tar_name)"
	sha="$(pin_scalar "$key" orig_tar_sha256)"
	[ -n "$url" ] && [ -n "$name" ] && [ -n "$sha" ] || { echo "missing pin for $key" >&2; exit 2; }
	log "orig: $name"
	curl -fsSL --retry 3 --retry-delay 2 -o "$WORK/$name" "$url"
	local got; got="$(sha256sum "$WORK/$name" | awk '{print $1}')"
	[ "$got" = "$sha" ] || { echo "STOP: orig sha256 drift for $name (pin $sha, got $got)" >&2; exit 3; }
	log "orig sha256 OK ($sha)"

	# Assemble the build tree: <src>-<upstream>/ with debian/ overlaid; orig in the parent.
	local bdir="$WORK/build"
	mkdir -p "$bdir"
	local tree="$bdir/${src}-${upstream}"
	rm -rf "$tree"; mkdir -p "$tree"
	tar -xf "$WORK/$name" -C "$tree" --strip-components=1
	cp -a "$PKGW/$dir/debian" "$tree/debian"
	# Non-native 3.0 (quilt): dpkg-source wants ../<src>_<upstream>.orig.tar.<ext>.
	cp "$WORK/$name" "$bdir/${src}_${upstream}.orig.${name#*.orig.}"

	# Resolve build-deps against bookworm-main + the local repo (freshly built deps).
	log "apt-get build-dep (resolves against local repo for stack deps)"
	apt-get build-dep -y --no-install-recommends "$tree" >/dev/null

	# Real binary build, arch-only (-B): all 9 runtime pkgs are arch-specific; -B skips the
	# arch:all -doc pkgs and the -indep DEP-8 patch target.
	log "dpkg-buildpackage -B (DEB_BUILD_OPTIONS='$DEB_BUILD_OPTIONS')"
	( cd "$tree" && dpkg-buildpackage -B -us -uc )

	# dpkg-buildpackage writes artifacts to $bdir (the source tree's PARENT); prior sources'
	# debs were already moved to $REPO, so $bdir holds only this source's fresh output.
	find "$bdir" -maxdepth 1 -name '*.changes'  -exec cp -t /out {} + 2>/dev/null || true
	find "$bdir" -maxdepth 1 -name '*.buildinfo' -exec cp -t /out {} + 2>/dev/null || true
	find "$bdir" -maxdepth 1 -name '*.deb'       -exec cp -t /out {} + 2>/dev/null || true
	find "$bdir" -maxdepth 1 -name '*.deb'       -exec mv -t "$REPO" {} + 2>/dev/null || true

	refresh_repo
	log "$dir built; local repo now has $(ls "$REPO"/*.deb 2>/dev/null | wc -l) .deb(s)"
}

for d in "${BUILD_ORDER[@]}"; do build_one "$d"; done

# ---- runtime-closure verification from the four *.changes --------------------------------
step "runtime closure verification (from *.changes)"
# All binary package names across the 4 binary .changes (RFC822 Binary: field, fold-safe).
mapfile -t ALL_BINS < <(
	for ch in /out/*.changes; do
		awk '
			/^[A-Za-z][A-Za-z0-9-]*:/ { inb=0 }
			/^Binary:/ { inb=1; l=$0; sub(/^Binary:[ \t]*/, "", l); print l; next }
			inb && /^[ \t]/ { l=$0; sub(/^[ \t]+/, "", l); print l }
		' "$ch"
	done | tr ' ' '\n' | sed '/^$/d' | sort -u
)
# Runtime = not -dev, not -doc, not an auto-generated -dbgsym, not a gir typelib.
RUNTIME=()
for b in "${ALL_BINS[@]}"; do
	case "$b" in
		*-dev|*-doc|*-dbgsym|gir1.2-*) : ;;
		*) RUNTIME+=("$b") ;;
	esac
done
mapfile -t RUNTIME_SORTED < <(printf '%s\n' "${RUNTIME[@]}" | sort -u)

echo "all binary packages produced:"; printf '  %s\n' "${ALL_BINS[@]}"
echo "runtime closure (dev/doc/gir excluded):"; printf '  %s\n' "${RUNTIME_SORTED[@]}"

expected="$(printf '%s\n' "${EXPECTED_RUNTIME[@]}" | sort -u)"
got="$(printf '%s\n' "${RUNTIME_SORTED[@]}")"
if [ "$expected" = "$got" ]; then
	echo "CLOSURE OK: exactly the 9 expected runtime packages."
else
	echo "STOP: runtime closure drift." >&2
	echo "--- expected ---" >&2; printf '%s\n' "$expected" >&2
	echo "--- got ---" >&2;      printf '%s\n' "$got" >&2
	echo "--- diff (want<->got) ---" >&2; diff <(printf '%s\n' "$expected") <(printf '%s\n' "$got") >&2 || true
	exit 3
fi

echo
echo "PASS [$ARCH]: 4 sources built in bootstrap order; runtime closure == the 9."
