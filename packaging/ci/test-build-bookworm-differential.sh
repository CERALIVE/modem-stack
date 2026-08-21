#!/usr/bin/env bash
# test-build-bookworm-differential.sh — differential builder + rebuild-counter contract.
#
# HOST-RUNNABLE, OFFLINE, NO DOCKER. The builder's BUILD_BOOKWORM_STUB_DIR seam replaces only
# the expensive source-build body with fixture artifacts; build-set parsing, carried-deb repo
# seeding, bootstrap-order dispatch, the unchanged check-package-sets.sh call, and the merged
# runtime-closure assertion are the production paths. A poisoned docker stub proves the
# zero-build host path never starts a container.
#
# Counter fixtures drive the real inject-deb-version.sh with stubbed dpkg-parsechangelog/dch.
# Every previous-manifest row is parsed by production code; the dch transcript proves the suffix
# that would be injected without touching a checked-in changelog.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_SCRIPT="$HERE/build-bookworm.sh"
INJECT_SCRIPT="$HERE/inject-deb-version.sh"
EXPECTED="$HERE/expected-packages.txt"

for required in "$BUILD_SCRIPT" "$INJECT_SCRIPT" "$EXPECTED" "$HERE/check-package-sets.sh" "$HERE/tag-guard.sh"; do
	[ -r "$required" ] || { echo "missing: $required" >&2; exit 1; }
done

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ceralive-build-differential.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

FIXTURE_PKG="$ROOT/pkg"
STUB_BIN="$ROOT/bin"
STUB_BUILDS="$ROOT/stub-builds"
OUT="$ROOT/stdout.txt"
ERR="$ROOT/stderr.txt"
TRACE="$ROOT/build-trace.txt"
DCH_LOG="$ROOT/dch.log"
DOCKER_LOG="$ROOT/docker.log"
mkdir -p "$FIXTURE_PKG/ci" "$STUB_BIN" "$STUB_BUILDS"

# ---- a minimal standalone packaging tree ------------------------------------------------------
cp "$INJECT_SCRIPT" "$FIXTURE_PKG/ci/inject-deb-version.sh"
cp "$HERE/tag-guard.sh" "$FIXTURE_PKG/ci/tag-guard.sh"
cp "$HERE/check-package-sets.sh" "$FIXTURE_PKG/ci/check-package-sets.sh"
cp "$EXPECTED" "$FIXTURE_PKG/ci/expected-packages.txt"

base_version() {
	case "$1" in
	libqrtr-glib) printf '1.4.0-1\n' ;;
	libmbim) printf '1.34.0-1\n' ;;
	libqmi) printf '1.38.0-1\n' ;;
	modemmanager) printf '1.24.2-2\n' ;;
	*) echo "fixture: unknown source '$1'" >&2; return 1 ;;
	esac
}

recipe_dir() { case "$1" in modemmanager) echo ModemManager ;; *) echo "$1" ;; esac; }

for source_name in libqrtr-glib libmbim libqmi modemmanager; do
	dir="$(recipe_dir "$source_name")"
	mkdir -p "$FIXTURE_PKG/$dir/debian"
	printf '%s (%s) unstable; urgency=medium\n\n  * fixture\n\n -- CeraLive CI <ci@ceralive.tv>  Fri, 21 Aug 2026 00:00:00 +0000\n' \
		"$source_name" "$(base_version "$source_name")" >"$FIXTURE_PKG/$dir/debian/changelog"
done

# These stubs remove the host's devscripts/dpkg dependency without moving counter parsing out of
# inject-deb-version.sh. dpkg-parsechangelog reads only the fixture changelog's top version; dch
# records the exact --newversion and working source directory it was asked to mutate.
cat >"$STUB_BIN/dpkg-parsechangelog" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
changelog=""
while [ $# -gt 0 ]; do
	case "$1" in
	-l) shift; changelog="${1:-}" ;;
	-S) shift; [ "${1:-}" = Version ] || { echo "stub: only -S Version is supported" >&2; exit 97; } ;;
	esac
	shift
done
[ -r "$changelog" ] || { echo "stub: unreadable changelog '$changelog'" >&2; exit 97; }
IFS= read -r first <"$changelog"
version="${first#*(}"
version="${version%%)*}"
printf '%s\n' "$version"
STUB
cat >"$STUB_BIN/dch" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "$PWD" "$*" >>"$DCH_LOG"
STUB
cat >"$STUB_BIN/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$DOCKER_LOG"
echo "docker(stub): zero-build path must not invoke docker" >&2
exit 97
STUB
chmod +x "$STUB_BIN/dpkg-parsechangelog" "$STUB_BIN/dch" "$STUB_BIN/docker"

# ---- expected-set fixture helpers --------------------------------------------------------------
expected_set() { # <source>
	awk -v want="[$1 all-artifact]" '
		/^\[/ { h=$0; sub(/[ \t]*#.*$/, "", h); insec=(h==want)?1:0; next }
		insec { l=$0; sub(/#.*$/, "", l); gsub(/[ \t]+/, "", l); if (l!="") print l }
	' "$EXPECTED" | LC_ALL=C sort -u
}

write_source_debs() { # <source> <dest> <suffix>
	local source_name="$1" dest="$2" suffix="$3" package version
	version="$(base_version "$source_name")${suffix}"
	mkdir -p "$dest"
	while IFS= read -r package; do
		[ -n "$package" ] || continue
		printf 'fixture deb: %s %s\n' "$package" "$version" >"$dest/${package}_${version}_amd64.deb"
	done < <(expected_set "$source_name")
}

write_changes() { # <source> <dest>
	local source_name="$1" dest="$2" binaries
	binaries="$(expected_set "$source_name" | tr '\n' ' ')"
	cat >"$dest/${source_name}_amd64.changes" <<EOF
Format: 1.8
Source: $source_name
Binary: $binaries
Architecture: amd64
EOF
}

write_full_staged_set() { # <dest> <suffix>
	local dest="$1" suffix="$2" source_name
	for source_name in libqrtr-glib libmbim libqmi modemmanager; do
		write_source_debs "$source_name" "$dest" "$suffix"
	done
}

assert_rc()  { if [ "$1" -eq "$2" ]; then ok "$3"; else bad "$3 — exit $1, expected $2"; fi; }
assert_nz()  { if [ "$1" -ne 0 ]; then ok "$2"; else bad "$2 — expected a non-zero exit, got 0"; fi; }
assert_err() { if grep -qF -- "$1" "$ERR"; then ok "$2"; else bad "$2 — stderr does not name '$1'"; fi; }
assert_log() { if grep -qF -- "$1" "$2"; then ok "$3"; else bad "$3 — '$1' absent from $2"; fi; }

# ---- previous-manifest fixtures for one source -------------------------------------------------
write_qmi_manifest() { # <path> <amd64-runtime> <amd64-aux> <arm64-runtime> <arm64-aux>
	local path="$1" v_ar="$2" v_aa="$3" v_rr="$4" v_ra="$5"
	cat >"$path" <<EOF
# CeraLive modem-stack release manifest (counter fixture)
tag: v1.1.0
version: 1.1.0
closure_version: 2
# columns: build_arch package source version role filename sha256
amd64 libqmi-glib5 libqmi $v_ar runtime libqmi-glib5_${v_ar}_amd64.deb 0000
amd64 libqmi-glib-dev libqmi $v_aa aux libqmi-glib-dev_${v_aa}_amd64.deb 0000
arm64 libqmi-glib5 libqmi $v_rr runtime libqmi-glib5_${v_rr}_arm64.deb 0000
arm64 gir1.2-qmi-1.0 libqmi $v_ra aux gir1.2-qmi-1.0_${v_ra}_arm64.deb 0000
EOF
}

M_UNIFORM="$ROOT/manifest-uniform.txt"
M_DISAGREE="$ROOT/manifest-disagree.txt"
M_MIXED="$ROOT/manifest-mixed.txt"
M_MALFORMED="$ROOT/manifest-malformed.txt"
M_LEGACY="$ROOT/manifest-legacy.txt"
M_ZERO="$ROOT/manifest-zero-source.txt"
counter2='1.38.0-1~ceralive.2'
counter10='1.38.0-1~ceralive.10'
legacy='1.38.0-1~ceralive1.0.0'
malformed='1.38.0-1~ceralive.bad'
write_qmi_manifest "$M_UNIFORM" "$counter2" "$counter2" "$counter2" "$counter2"
write_qmi_manifest "$M_DISAGREE" "$counter2" "$counter2" "$counter10" "$counter2"
write_qmi_manifest "$M_MIXED" "$counter2" "$legacy" "$counter2" "$counter2"
write_qmi_manifest "$M_MALFORMED" "$counter2" "$counter2" "$malformed" "$counter2"
write_qmi_manifest "$M_LEGACY" "$legacy" "$legacy" "$legacy" "$legacy"
cat >"$M_ZERO" <<'EOF'
# CeraLive modem-stack release manifest (source intentionally absent)
tag: v1.1.0
version: 1.1.0
closure_version: 2
amd64 libmbim-glib4 libmbim 1.34.0-1~ceralive.2 runtime libmbim-glib4_1.34.0-1~ceralive.2_amd64.deb 0000
EOF

if [ "$(awk '$3=="libqmi" && $1=="amd64" {a=1} $3=="libqmi" && $1=="arm64" {b=1} $3=="libqmi" && $5=="runtime" {r=1} $3=="libqmi" && $5=="aux" {x=1} END {print a+b+r+x}' "$M_UNIFORM")" -eq 4 ]; then
	ok "counter fixture covers both arches and runtime+aux rows"
else
	bad "counter fixture does not cover both arches and runtime+aux rows"
fi

run_inject() { # <manifest-or-ABSENT>
	: >"$DCH_LOG"
	if [ "$1" = ABSENT ]; then
		env -u PREV_MANIFEST_FILE PATH="$STUB_BIN:$PATH" DCH_LOG="$DCH_LOG" \
			bash "$FIXTURE_PKG/ci/inject-deb-version.sh" --source libqmi v1.2.0 >"$OUT" 2>"$ERR"
	else
		PREV_MANIFEST_FILE="$1" PATH="$STUB_BIN:$PATH" DCH_LOG="$DCH_LOG" \
			bash "$FIXTURE_PKG/ci/inject-deb-version.sh" --source libqmi v1.2.0 >"$OUT" 2>"$ERR"
	fi
}

assert_injected_suffix() { # <suffix> <label>
	if [ "$(grep -c -- '--newversion' "$DCH_LOG" 2>/dev/null)" -eq 1 ] && grep -qF -- "$1" "$DCH_LOG"; then
		ok "$2"
	else
		bad "$2 — dch transcript: $(tr '\n' ' ' <"$DCH_LOG")"
	fi
}

echo "== counter derivation: all rows participate, every incoherent shape fails closed =="
run_inject "$M_UNIFORM"; rc=$?
assert_rc "$rc" 0 "uniform prior counter .2 exits 0"
assert_injected_suffix '~ceralive.3' "uniform .2 rows inject .3"

run_inject "$M_DISAGREE"; rc=$?
assert_nz "$rc" "prior counters .2 and .10 disagree"
assert_err "libqmi" "counter-disagreement failure NAMES the source"
assert_err "differing counters" "counter-disagreement reason is explicit"

run_inject "$M_MIXED"; rc=$?
assert_nz "$rc" "counter/legacy mixture exits non-zero"
assert_err "libqmi" "counter/legacy failure NAMES the source"
assert_err "mixes counter and legacy" "counter/legacy reason is explicit"

run_inject "$M_MALFORMED"; rc=$?
assert_nz "$rc" "malformed suffix exits non-zero"
assert_err "libqmi" "malformed-suffix failure NAMES the source"
assert_err "~ceralive.bad" "malformed-suffix failure NAMES the bad value"

run_inject "$M_LEGACY"; rc=$?
assert_rc "$rc" 0 "entirely legacy source exits 0"
assert_injected_suffix '~ceralive.1' "entirely legacy source initializes .1"

run_inject ABSENT; rc=$?
assert_rc "$rc" 0 "absent previous manifest exits 0"
assert_injected_suffix '~ceralive.1' "absent previous manifest initializes .1"

run_inject "$M_ZERO"; rc=$?
assert_nz "$rc" "present v2 manifest with zero source rows exits non-zero"
assert_err "libqmi" "zero-row failure NAMES the rebuilt source"
assert_err "ZERO rows" "zero-row failure states the producer/consumer disagreement"

# ---- one-source build: carried inputs seed before bootstrap dispatch ----------------------------
echo
echo "== one selected source: seed carried local repo before BUILD, then assert merged set =="
ONE_OUT="$ROOT/build-one/amd64"
for source_name in libqrtr-glib libmbim modemmanager; do
	write_source_debs "$source_name" "$ONE_OUT" '~ceralive.2'
done
mkdir -p "$STUB_BUILDS/libqmi"
write_source_debs libqmi "$STUB_BUILDS/libqmi" '~ceralive.3'
write_changes libqmi "$STUB_BUILDS/libqmi"
VERDICTS="$ROOT/verdicts-one.txt"
cat >"$VERDICTS" <<'EOF'
libqrtr-glib=unchanged
libmbim=unchanged
libqmi=changed
modemmanager=unchanged
mode=differential
EOF

: >"$DCH_LOG"
BUILD_IN_CONTAINER=1 ARCH=amd64 VERDICTS_FILE="$VERDICTS" RELEASE_VERSION=v1.2.0 \
	PREV_MANIFEST_FILE="$M_UNIFORM" BUILD_BOOKWORM_PKG_ROOT="$FIXTURE_PKG" \
	BUILD_BOOKWORM_OUT_DIR="$ONE_OUT" BUILD_BOOKWORM_STUB_DIR="$STUB_BUILDS" \
	PATH="$STUB_BIN:$PATH" DCH_LOG="$DCH_LOG" \
	bash "$BUILD_SCRIPT" amd64 >"$TRACE" 2>&1
rc=$?
assert_rc "$rc" 0 "one-source stub build exits 0"
assert_log "seed libqrtr-glib" "$TRACE" "a skipped source's carried debs seed the local repo"
seed_line="$(grep -n -m1 'seed libqrtr-glib' "$TRACE" | cut -d: -f1)"
build_line="$(grep -n -m1 '==== BUILD libqmi' "$TRACE" | cut -d: -f1)"
if [ -n "$seed_line" ] && [ -n "$build_line" ] && [ "$seed_line" -lt "$build_line" ]; then
	ok "carried-deb seed is ordered strictly BEFORE the first BUILD"
else
	bad "seed/build ordering is wrong (seed=${seed_line:-missing}, build=${build_line:-missing})"
fi
if [ "$(grep -c '==== BUILD ' "$TRACE")" -eq 1 ] && grep -q '==== BUILD libqmi' "$TRACE"; then
	ok "only the selected source builds"
else
	bad "build trace does not contain exactly one libqmi build"
fi
assert_log "MERGED RUNTIME CLOSURE OK" "$TRACE" "runtime closure is asserted over built + carried debs"
if [ "$(grep -c -- '--newversion' "$DCH_LOG" 2>/dev/null)" -eq 1 ] && \
	grep -qF '/libqmi|--force-bad-version --newversion 1.38.0-1~ceralive.3' "$DCH_LOG"; then
	ok "version injection runs once, only for the source being built, at its next counter"
else
	bad "selected-source injection transcript is wrong: $(tr '\n' ' ' <"$DCH_LOG")"
fi
if compgen -G "$ONE_OUT/libqrtr-glib0_*~ceralive.2_amd64.deb" >/dev/null; then
	ok "the output cleanup preserved carried debs for skipped sources"
else
	bad "a carried libqrtr-glib deb was wiped before the build"
fi

# ---- zero-build host path + missing carried package --------------------------------------------
echo
echo "== zero selected sources: no docker, carried-only merged closure still enforced =="
ZERO_OUT="$ROOT/build-zero/amd64"
write_full_staged_set "$ZERO_OUT" '~ceralive.2'
before_count="$(find "$ZERO_OUT" -maxdepth 1 -type f -name '*.deb' | wc -l)"
: >"$DOCKER_LOG"
OUT="$ZERO_OUT" BUILD_SOURCES="" PATH="$STUB_BIN:$PATH" DOCKER_LOG="$DOCKER_LOG" \
	bash "$BUILD_SCRIPT" amd64 >"$OUT" 2>"$ERR"
rc=$?
assert_rc "$rc" 0 "complete carried-only set exits 0"
if [ ! -s "$DOCKER_LOG" ]; then ok "zero-build path never invokes docker"; else bad "zero-build path invoked docker"; fi
after_count="$(find "$ZERO_OUT" -maxdepth 1 -type f -name '*.deb' | wc -l)"
if [ "$before_count" -eq "$after_count" ]; then ok "zero-build cleanup preserves every carried deb"; else bad "zero-build cleanup removed carried debs"; fi
assert_log "MERGED RUNTIME CLOSURE OK" "$ERR" "carried-only set still runs the merged closure assertion"

victim="$(find "$ZERO_OUT" -maxdepth 1 -type f -name 'libqmi-glib5_*.deb' -print -quit)"
rm -f "$victim"
: >"$DOCKER_LOG"
OUT="$ZERO_OUT" BUILD_SOURCES="" PATH="$STUB_BIN:$PATH" DOCKER_LOG="$DOCKER_LOG" \
	bash "$BUILD_SCRIPT" amd64 >"$OUT" 2>"$ERR"
rc=$?
assert_nz "$rc" "carried-only set with one deleted runtime deb fails closed"
assert_err "libqmi-glib5" "merged-set failure NAMES the missing carried package"
assert_err "MISSING (expected, not staged)" "failure comes from the merged runtime-set assertion"
if [ ! -s "$DOCKER_LOG" ]; then ok "failing zero-build assertion also never invokes docker"; else bad "failing zero-build path invoked docker"; fi

echo
echo "passed: $pass   failed: $fail"
if [ "$fail" -eq 0 ]; then
	echo "PASS: differential builds seed carried deps, preserve bootstrap order, and enforce coherent counters + merged closure"
	exit 0
fi
echo "FAIL: build-bookworm differential contract violated"
exit 1
