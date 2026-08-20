#!/usr/bin/env bash
# build-companion.sh — build the first-party `ceralive-modem-support` companion .deb.
#
# The companion is `Architecture: all`: ONE build produces ONE immutable release asset that
# is later indexed into BOTH per-arch APT indexes. It is therefore built exactly ONCE, into
# packaging/build/all/, and never per-arch — a per-arch build would produce two byte-different
# files claiming the same package/version key and break the publisher's immutable-key rule.
#
# It shares NOTHING with the four upstream sources' build: those are byte-faithful, zero-patch
# rebuilds (packaging/README.md, POLICY.md) and this package exists precisely so they never
# have to absorb a CeraLive-specific asset.
#
# USAGE  build-companion.sh [--native]
#   default: builds inside a `debian:bookworm` container (matches the upstream lane).
#   --native: builds on the host (needs debhelper + dpkg-dev); used by the local QA harness.
#
# ENV
#   RELEASE_VERSION  vX.Y.Z -> the .deb Version: is X.Y.Z. Unset -> 0.0.0~dev.
#   CONTAINER_ENGINE podman|docker (auto-detected, podman preferred).
#   BUILD_ROOT       output root (default packaging/build).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"
SRC_DIR="$PKG_ROOT/ceralive-modem-support"
BUILD_ROOT="${BUILD_ROOT:-$PKG_ROOT/build}"
OUT_DIR="$BUILD_ROOT/all"
IMAGE="${COMPANION_BUILD_IMAGE:-debian:bookworm}"

NATIVE=0
[[ "${1:-}" == "--native" ]] && NATIVE=1

# ── Version ──────────────────────────────────────────────────────────────────
# The companion is a native package versioned with the repo's SemVer tag verbatim
# (v1.1.0 -> 1.1.0). It deliberately does NOT use the upstream rebuilds'
# `<upstream>-<rev>~ceraliveX.Y.Z` form: there is no upstream version to order against,
# and a bare SemVer sorts correctly under dpkg on its own.
resolve_version() {
  local tag="${RELEASE_VERSION:-}"
  if [[ -z "$tag" ]]; then echo "0.0.0~dev"; return 0; fi
  bash "$HERE/tag-guard.sh" "$tag" >/dev/null
  echo "${tag#v}"
}

VERSION="$(resolve_version)"
echo "build-companion: version=$VERSION out=$OUT_DIR native=$NATIVE" >&2

build_here() {
  local work="$1" version="$2"
  cd "$work"
  # Rewrite the changelog top entry in the WORK COPY only; the committed changelog stays
  # pristine, exactly as inject-deb-version.sh does for the four upstream sources.
  DEBEMAIL="dev@ceralive.tv" DEBFULLNAME="CeraLive" \
    dch --force-bad-version --newversion "$version" --distribution stable --force-distribution \
        "CeraLive modem-stack release $version."
  dpkg-buildpackage -us -uc -b
}

if [[ "$NATIVE" -eq 1 ]]; then
  command -v dpkg-buildpackage >/dev/null || { echo "build-companion: dpkg-buildpackage not found (--native needs dpkg-dev + debhelper)" >&2; exit 2; }
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  cp -a "$SRC_DIR" "$WORK/ceralive-modem-support"
  ( build_here "$WORK/ceralive-modem-support" "$VERSION" )
  mkdir -p "$OUT_DIR"
  find "$WORK" -maxdepth 1 -name '*.deb' -exec cp {} "$OUT_DIR/" \;
else
  ENGINE="${CONTAINER_ENGINE:-}"
  if [[ -z "$ENGINE" ]]; then
    if command -v podman >/dev/null 2>&1; then ENGINE=podman
    elif command -v docker >/dev/null 2>&1; then ENGINE=docker
    else echo "build-companion: no podman/docker available" >&2; exit 2; fi
  fi
  mkdir -p "$OUT_DIR"
  "$ENGINE" run --rm \
    -v "$SRC_DIR:/src:ro" \
    -v "$OUT_DIR:/out" \
    -e "VERSION=$VERSION" \
    "$IMAGE" bash -euo pipefail -c '
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq --no-install-recommends build-essential debhelper devscripts dpkg-dev >/dev/null
      cp -a /src /work
      cd /work
      DEBEMAIL=dev@ceralive.tv DEBFULLNAME=CeraLive \
        dch --force-bad-version --newversion "$VERSION" --distribution stable --force-distribution \
            "CeraLive modem-stack release $VERSION."
      dpkg-buildpackage -us -uc -b
      cp /*.deb /out/
      chmod 0644 /out/*.deb
    '
fi

DEB="$(find "$OUT_DIR" -maxdepth 1 -name 'ceralive-modem-support_*.deb' -newermt '-1 day' | head -n1)"
[[ -n "$DEB" ]] || { echo "build-companion: no .deb produced in $OUT_DIR" >&2; exit 1; }

# Fail closed on the two identity axes the publisher and the manifest both rely on.
got_arch="$(dpkg-deb -f "$DEB" Architecture)"
got_ver="$(dpkg-deb -f "$DEB" Version)"
[[ "$got_arch" == "all" ]] || { echo "build-companion: Architecture '$got_arch' != all" >&2; exit 1; }
[[ "$got_ver"  == "$VERSION" ]] || { echo "build-companion: Version '$got_ver' != '$VERSION'" >&2; exit 1; }

echo "build-companion: built $(basename "$DEB") (Architecture: all, Version: $VERSION)" >&2
