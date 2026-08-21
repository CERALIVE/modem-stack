#!/usr/bin/env bash
# test-stage-carryforward-debs.sh — the carry-forward stager's behaviour contract.
#
# HOST-RUNNABLE, OFFLINE, NO DOCKER, NO `gh`. Two seams make that possible:
#
#   1. `PREV_MANIFEST_FILE` supplies a fixture previous-release manifest, generated here in the
#      real 7-column `build_arch package source version role filename sha256` shape (closure
#      version 2 — four upstream sources at runtime AND aux roles, plus the companion row every
#      real v2 manifest carries).
#
#   2. `CARRYFORWARD_ASSET_DIR` supplies the release assets as local files. Every upstream
#      fixture asset is written under the GITHUB-MANGLED name (`~` -> `.`), never the canonical
#      one, and a control asserts the directory contains no `~` at all — so the glob-based
#      reconciliation is the ONLY way any of them can be found. If the inverse mapping regressed,
#      every case would fail with a missing asset rather than passing by accident.
#
# The assets are tiny placeholder files rather than real archives on purpose: this script's
# contract is sha256 + name reconciliation + placement. It never invokes `dpkg-deb` (unlike
# apt-worker's `verify_staged_deb`, which additionally reads the control stanza), so a real
# archive would prove nothing extra here and would make the fixture non-deterministic —
# `dpkg-deb --build` output is not bit-reproducible.
#
# Cases: (a) mangled assets -> canonical staging, aux rows included  (a2) zero-upstream-build
#        shape  (b) flipped byte  (c) missing asset  (d) v1-shaped manifest  (e) unverdicted
#        source  (f) companion never carried  (g) nothing to carry  (h) unchanged source with no
#        rows  (i) stdin == --verdicts  (k) ambiguous asset name  (l/m) malformed verdict stream
#        (n) idempotent re-run  (o) destination collision.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/stage-carryforward-debs.sh"
[ -f "$SCRIPT" ] || { echo "missing: $SCRIPT" >&2; exit 1; }

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ceralive-stage-carryforward.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

ASSETS="$ROOT/gh-assets"
OUT="$ROOT/stdout.txt"
ERR="$ROOT/stderr.txt"
mkdir -p "$ASSETS"

# ---- the fixture previous release --------------------------------------------------------------
# Two arches x four sources x {runtime, aux}. The aux members are deliberately one dbgsym, one
# -dev and one gir1.2-* — the three classes a runtime-only carry would silently drop.
ROWS_SPEC=(
	"libqrtr-glib|libqrtr-glib0|1.4.0-1~ceralive1.1.0|runtime"
	"libqrtr-glib|gir1.2-qrtr-1.0|1.4.0-1~ceralive1.1.0|aux"
	"libmbim|libmbim-glib4|1.34.0-1~ceralive1.1.0|runtime"
	"libmbim|libmbim-glib4-dbgsym|1.34.0-1~ceralive1.1.0|aux"
	"libqmi|libqmi-glib5|1.38.0-1~ceralive1.1.0|runtime"
	"libqmi|libqmi-glib-dev|1.38.0-1~ceralive1.1.0|aux"
	"modemmanager|modemmanager|1.24.2-2~ceralive1.1.0|runtime"
	"modemmanager|modemmanager-dev|1.24.2-2~ceralive1.1.0|aux"
)
COMPANION_DEB="ceralive-modem-support_1.1.0_all.deb"

M_V2="$ROOT/release-manifest-v2.txt"
cat >"$M_V2" <<'EOF'
# CeraLive modem-stack release manifest (fixture)
tag: v1.1.0
version: 1.1.0
sources: [ceralive-modem-support libmbim libqmi libqrtr-glib modemmanager]
closure_version: 2
runtime_closure_size: 9
arch_all_closure_size: 1
index_arches: [arm64 amd64]
# columns: build_arch  package  source  version  role  filename  sha256
EOF

sha_of() { sha256sum "$1" | awk '{print $1}'; }

for arch in amd64 arm64; do
	for spec in "${ROWS_SPEC[@]}"; do
		IFS='|' read -r f_src f_pkg f_ver f_role <<<"$spec"
		canonical="${f_pkg}_${f_ver}_${arch}.deb"
		stored="${canonical//\~/.}"           # exactly what the release uploader stores
		printf 'fixture payload for %s\n' "$canonical" >"$ASSETS/$stored"
		printf '%s  %s  %s  %s  %s  %s  %s\n' \
			"$arch" "$f_pkg" "$f_src" "$f_ver" "$f_role" "$canonical" "$(sha_of "$ASSETS/$stored")" >>"$M_V2"
	done
done
printf 'fixture payload for %s\n' "$COMPANION_DEB" >"$ASSETS/$COMPANION_DEB"
printf 'all  ceralive-modem-support  ceralive-modem-support  1.1.0  runtime  %s  %s\n' \
	"$COMPANION_DEB" "$(sha_of "$ASSETS/$COMPANION_DEB")" >>"$M_V2"
echo "# build_dirs: all amd64 arm64" >>"$M_V2"

# v1 SHAPE: the same manifest with no `closure_version:` header (an absent header IS version 1).
M_V1="$ROOT/release-manifest-v1.txt"
grep -v '^closure_version:' "$M_V2" >"$M_V1"

# A v2 manifest carrying ZERO rows for libqrtr-glib.
M_NOQRTR="$ROOT/release-manifest-no-qrtr.txt"
awk '$3 != "libqrtr-glib"' "$M_V2" >"$M_NOQRTR"

# ---- fixture controls ---------------------------------------------------------------------------
echo "== fixture controls =="
if find "$ASSETS" -maxdepth 1 -name '*~*' | grep -q .; then
	bad "the asset dir must hold ONLY GitHub-mangled names — a '~' name would let the glob pass vacuously"
else
	ok "every upstream asset is stored under its mangled '.' name (the glob is the only way to find it)"
fi
if [ "$(grep -c 'ceralive-modem-support' "$M_V2")" -ge 2 ] && [ -f "$ASSETS/$COMPANION_DEB" ]; then
	ok "the companion is present in BOTH the manifest and the asset dir (its skip cannot be vacuous)"
else
	bad "fixture: the companion row/asset is missing"
fi
if [ "$(awk 'NF==7 && $1 !~ /:$/ && $0 !~ /^#/' "$M_V2" | wc -l)" -eq 17 ]; then
	ok "fixture manifest carries 17 deb rows (8 packages x 2 arches + the companion)"
else
	bad "fixture manifest row count is $(awk 'NF==7 && $1 !~ /:$/ && $0 !~ /^#/' "$M_V2" | wc -l), expected 17"
fi

# ---- harness ------------------------------------------------------------------------------------
verdicts() { # <out-file> <mode> <src=verdict>...
	local out="$1" mode="$2"; shift 2
	: >"$out"
	local v
	for v in "$@"; do printf '%s\n' "$v" >>"$out"; done
	printf 'mode=%s\n' "$mode" >>"$out"
}

stage() { # <manifest> <asset-dir> <build-root> <verdicts-file>
	PREV_MANIFEST_FILE="$1" CARRYFORWARD_ASSET_DIR="$2" \
		bash "$SCRIPT" --build-root "$3" --verdicts "$4" >"$OUT" 2>"$ERR"
}

staged_count() { find "$1" -type f -name '*.deb' 2>/dev/null | wc -l; }
assert_rc()  { if [ "$1" -eq "$2" ]; then ok "$3"; else bad "$3 — exit $1, expected $2"; fi; }
assert_nz()  { if [ "$1" -ne 0 ]; then ok "$2"; else bad "$2 — expected a non-zero exit, got 0"; fi; }
assert_err() { if grep -qF -- "$1" "$ERR"; then ok "$2"; else bad "$2 — stderr does not name '$1'"; fi; }
assert_file()    { if [ -f "$1" ]; then ok "$2"; else bad "$2 — missing $1"; fi; }
assert_no_file() { if [ -e "$1" ]; then bad "$2 — $1 exists"; else ok "$2"; fi; }
assert_eq()  { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 — got '$1', expected '$2'"; fi; }

# One byte overwritten IN PLACE (not appended, which would also change the length). The new byte
# is derived from the existing one so a file whose last byte already equalled it cannot make the
# case vacuous; the sha256 change is asserted before the case runs.
corrupt_one_byte() { # <file>
	local f="$1" sz cur next
	sz="$(stat -c%s "$f")"
	cur="$(dd if="$f" bs=1 skip=$((sz - 1)) count=1 2>/dev/null | od -An -tu1 | tr -d ' ')"
	next=$(((cur + 1) % 256))
	printf '%b' "\\$(printf '%03o' "$next")" | dd of="$f" bs=1 seek=$((sz - 1)) count=1 conv=notrunc 2>/dev/null
}

V_THREE="$ROOT/verdicts-three.txt"
V_ALL="$ROOT/verdicts-all.txt"
V_NONE="$ROOT/verdicts-none.txt"
verdicts "$V_THREE" differential libqrtr-glib=unchanged libmbim=unchanged libqmi=changed modemmanager=unchanged
verdicts "$V_ALL"   differential libqrtr-glib=unchanged libmbim=unchanged libqmi=unchanged modemmanager=unchanged
verdicts "$V_NONE"  force-all    libqrtr-glib=changed libmbim=changed libqmi=changed modemmanager=changed

echo
echo "== (a) mangled release assets stage under CANONICAL names, runtime AND aux =="
BR_A="$ROOT/build-a"
stage "$M_V2" "$ASSETS" "$BR_A" "$V_THREE"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_eq "$(staged_count "$BR_A")" 12 "12 debs staged (3 unchanged sources x 2 packages x 2 arches)"
assert_file "$BR_A/amd64/libqrtr-glib0_1.4.0-1~ceralive1.1.0_amd64.deb" "runtime row staged (amd64)"
assert_file "$BR_A/arm64/libqrtr-glib0_1.4.0-1~ceralive1.1.0_arm64.deb" "runtime row staged (arm64)"
assert_file "$BR_A/arm64/gir1.2-qrtr-1.0_1.4.0-1~ceralive1.1.0_arm64.deb" "AUX gir1.2-* row staged"
assert_file "$BR_A/amd64/libmbim-glib4-dbgsym_1.34.0-1~ceralive1.1.0_amd64.deb" "AUX dbgsym row staged"
assert_file "$BR_A/arm64/modemmanager-dev_1.24.2-2~ceralive1.1.0_arm64.deb" "AUX -dev row staged"
assert_no_file "$BR_A/amd64/libqmi-glib5_1.38.0-1~ceralive1.1.0_amd64.deb" "a CHANGED source's runtime deb is not carried"
assert_no_file "$BR_A/amd64/libqmi-glib-dev_1.38.0-1~ceralive1.1.0_amd64.deb" "a CHANGED source's aux deb is not carried"
if find "$BR_A" -type f -name '*.ceralive1.1.0_*' | grep -q .; then
	bad "a GitHub-mangled name survived into the build tree"
else
	ok "no mangled '.ceralive' name reached the build tree"
fi
if [ "$(find "$BR_A" -type f -name '*~ceralive1.1.0*' | wc -l)" -eq 12 ]; then
	ok "every staged deb carries the canonical '~ceralive' name dpkg orders on"
else
	bad "not every staged deb carries a '~ceralive' name"
fi
if cmp -s "$ASSETS/libmbim-glib4_1.34.0-1.ceralive1.1.0_amd64.deb" \
	"$BR_A/amd64/libmbim-glib4_1.34.0-1~ceralive1.1.0_amd64.deb"; then
	ok "the staged bytes are the release asset's bytes, verbatim"
else
	bad "the staged deb does not match the release asset byte-for-byte"
fi
assert_eq "$(grep -c . "$OUT")" 12 "stdout carries one <arch>/<filename> line per staged deb"
if grep -qxF 'amd64/libmbim-glib4_1.34.0-1~ceralive1.1.0_amd64.deb' "$OUT"; then
	ok "stdout names staged debs by canonical <build_arch>/<filename>"
else
	bad "stdout does not carry the expected <build_arch>/<filename> line"
fi

echo "== (a2) the zero-upstream-build shape: all four sources carried =="
BR_A2="$ROOT/build-a2"
stage "$M_V2" "$ASSETS" "$BR_A2" "$V_ALL"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_eq "$(staged_count "$BR_A2")" 16 "all 16 upstream rows staged (8 packages x 2 arches)"
assert_file "$BR_A2/amd64/libqmi-glib5_1.38.0-1~ceralive1.1.0_amd64.deb" "libqmi is carried once it is unchanged"

echo "== (f) the companion is NEVER carried, even with all sources unchanged =="
if find "$BR_A2" -type f -name 'ceralive-modem-support*' | grep -q .; then
	bad "the companion was staged — it must always rebuild"
else
	ok "the companion deb is never staged"
fi
assert_no_file "$BR_A2/all" "no build/all directory is created for a carry"
assert_err "the companion 'ceralive-modem-support' always rebuilds" "the skip is logged with its reason"

echo "== (b) one flipped byte fails closed, naming the file =="
ASSETS_B="$ROOT/assets-b"
cp -a "$ASSETS" "$ASSETS_B"
VICTIM="$ASSETS_B/libmbim-glib4_1.34.0-1.ceralive1.1.0_amd64.deb"
before="$(sha_of "$VICTIM")"
corrupt_one_byte "$VICTIM"
if [ "$(sha_of "$VICTIM")" != "$before" ]; then
	ok "fixture: the flipped byte actually changed the sha256"
else
	bad "fixture: corruption did not change the sha256 — the case would be vacuous"
fi
BR_B="$ROOT/build-b"
stage "$M_V2" "$ASSETS_B" "$BR_B" "$V_ALL"; rc=$?
assert_nz "$rc" "a corrupted carried deb exits non-zero"
assert_err "libmbim-glib4_1.34.0-1~ceralive1.1.0_amd64.deb" "stderr NAMES the corrupted file"
assert_err "sha256" "stderr says the failure is a sha256 mismatch"
assert_no_file "$BR_B/amd64/libmbim-glib4_1.34.0-1~ceralive1.1.0_amd64.deb" "the corrupted deb is never staged"
printf '  evidence (exit %s): %s\n' "$rc" "$(grep -m1 'FAIL CLOSED' "$ERR")"

echo "== (c) a missing asset fails closed, naming the file =="
ASSETS_C="$ROOT/assets-c"
cp -a "$ASSETS" "$ASSETS_C"
rm -f "$ASSETS_C/modemmanager-dev_1.24.2-2.ceralive1.1.0_arm64.deb"
BR_C="$ROOT/build-c"
stage "$M_V2" "$ASSETS_C" "$BR_C" "$V_ALL"; rc=$?
assert_nz "$rc" "a manifest row with no release asset exits non-zero"
assert_err "modemmanager-dev_1.24.2-2~ceralive1.1.0_arm64.deb" "stderr NAMES the missing file"
assert_err "is missing" "stderr says the asset is missing"

echo "== (d) a v1-shaped previous manifest is REFUSED, not guessed at =="
BR_D="$ROOT/build-d"
stage "$M_V1" "$ASSETS" "$BR_D" "$V_ALL"; rc=$?
assert_nz "$rc" "carrying from a v1-shaped manifest exits non-zero"
assert_err "closure_version" "stderr names the absent closure_version header"
assert_err "refusing to carry from a v1-shaped manifest" "stderr says it refuses rather than guessing"
assert_eq "$(staged_count "$BR_D")" 0 "nothing is staged from a v1-shaped manifest"

echo "== (e) a row naming an UNVERDICTED source fails closed =="
V_MISSING="$ROOT/verdicts-missing-source.txt"
verdicts "$V_MISSING" differential libqrtr-glib=unchanged libqmi=changed modemmanager=unchanged
BR_E="$ROOT/build-e"
stage "$M_V2" "$ASSETS" "$BR_E" "$V_MISSING"; rc=$?
assert_nz "$rc" "a source the caller never adjudicated exits non-zero"
assert_err "libmbim" "stderr NAMES the unverdicted source"
assert_err "never verdicted" "stderr explains the row was never adjudicated"

echo "== (g) nothing to carry needs no manifest at all =="
BR_G="$ROOT/build-g"
bash "$SCRIPT" --build-root "$BR_G" --verdicts "$V_NONE" >"$OUT" 2>"$ERR"; rc=$?
assert_rc "$rc" 0 "force-all with every source changed exits 0"
assert_eq "$(staged_count "$BR_G")" 0 "nothing is staged"
assert_err "nothing to carry" "stderr says nothing was carried"
if grep -q 'previous release manifest:' "$ERR"; then
	bad "a previous manifest was resolved when there was nothing to carry"
else
	ok "no previous manifest is resolved when there is nothing to carry"
fi

echo "== (h) an unchanged source with ZERO rows in the previous manifest fails closed =="
BR_H="$ROOT/build-h"
stage "$M_NOQRTR" "$ASSETS" "$BR_H" "$V_ALL"; rc=$?
assert_nz "$rc" "an unchanged source absent from the manifest exits non-zero"
assert_err "libqrtr-glib" "stderr NAMES the source with no rows"
assert_err "ZERO rows" "stderr says the manifest carries no rows for it"

echo "== (i) verdicts on STDIN are identical to --verdicts =="
BR_I="$ROOT/build-i"
PREV_MANIFEST_FILE="$M_V2" CARRYFORWARD_ASSET_DIR="$ASSETS" \
	bash "$SCRIPT" --build-root "$BR_I" <"$V_THREE" >"$OUT" 2>"$ERR"; rc=$?
assert_rc "$rc" 0 "exit 0 reading the verdict stream from stdin"
assert_eq "$(staged_count "$BR_I")" 12 "stdin staged the same 12 debs"
if diff -q <(cd "$BR_A" && find . -type f | LC_ALL=C sort) <(cd "$BR_I" && find . -type f | LC_ALL=C sort) >/dev/null; then
	ok "the stdin run staged exactly the same tree as the --verdicts run"
else
	bad "stdin and --verdicts produced different trees"
fi

echo "== (k) an AMBIGUOUS asset name fails closed rather than picking one =="
ASSETS_K="$ROOT/assets-k"
cp -a "$ASSETS" "$ASSETS_K"
cp "$ASSETS_K/libqmi-glib5_1.38.0-1.ceralive1.1.0_amd64.deb" \
	"$ASSETS_K/libqmi-glib5_1.38.0-1~ceralive1.1.0_amd64.deb"
BR_K="$ROOT/build-k"
stage "$M_V2" "$ASSETS_K" "$BR_K" "$V_ALL"; rc=$?
assert_nz "$rc" "two assets matching one canonical name exits non-zero"
assert_err "is ambiguous" "stderr says the asset name is ambiguous"

echo "== (l/m) a malformed verdict stream fails closed rather than assuming a default =="
V_NOMODE="$ROOT/verdicts-no-mode.txt"
printf 'libqmi=unchanged\n' >"$V_NOMODE"
BR_L="$ROOT/build-l"
stage "$M_V2" "$ASSETS" "$BR_L" "$V_NOMODE"; rc=$?
assert_rc "$rc" 2 "a verdict stream with no mode= line exits 2"
assert_err "no 'mode=' line" "stderr names the missing mode line"
V_CONTRA="$ROOT/verdicts-contradiction.txt"
verdicts "$V_CONTRA" force-all libqrtr-glib=changed libmbim=unchanged libqmi=changed modemmanager=changed
stage "$M_V2" "$ASSETS" "$BR_L" "$V_CONTRA"; rc=$?
assert_rc "$rc" 2 "force-all carrying an 'unchanged' verdict exits 2"
assert_err "mode=force-all but source(s)" "stderr names the self-contradicting stream"
V_JUNK="$ROOT/verdicts-junk.txt"
printf 'libqmi=maybe\nmode=differential\n' >"$V_JUNK"
stage "$M_V2" "$ASSETS" "$BR_L" "$V_JUNK"; rc=$?
assert_rc "$rc" 2 "an unparseable verdict line exits 2"
assert_err "unparseable verdict line" "stderr names the bad line"
stage "$ROOT/no-such-manifest.txt" "$ASSETS" "$BR_L" "$V_ALL"; rc=$?
assert_rc "$rc" 2 "a set-but-unreadable PREV_MANIFEST_FILE exits 2"
assert_err "PREV_MANIFEST_FILE=" "stderr names the seam"

echo "== (n) a re-run over an already-staged tree is idempotent =="
stage "$M_V2" "$ASSETS" "$BR_A" "$V_THREE"; rc=$?
assert_rc "$rc" 0 "the second run exits 0"
assert_eq "$(staged_count "$BR_A")" 12 "the tree still holds exactly 12 debs"
assert_err "already staged, integrity matches" "the re-run reports the existing debs as integrity-matched"

echo "== (o) a destination holding DIFFERENT bytes is never overwritten =="
BR_O="$ROOT/build-o"
mkdir -p "$BR_O/amd64"
printf 'a freshly built deb that must not be clobbered\n' \
	>"$BR_O/amd64/libmbim-glib4_1.34.0-1~ceralive1.1.0_amd64.deb"
stage "$M_V2" "$ASSETS" "$BR_O" "$V_ALL"; rc=$?
assert_nz "$rc" "a differing destination file exits non-zero"
assert_err "already exists with different bytes" "stderr says the destination differs"
if grep -q 'must not be clobbered' "$BR_O/amd64/libmbim-glib4_1.34.0-1~ceralive1.1.0_amd64.deb"; then
	ok "the pre-existing file was left untouched"
else
	bad "the pre-existing file was overwritten"
fi

echo
echo "passed: $pass   failed: $fail"
if [ "$fail" -eq 0 ]; then
	echo "PASS: carry-forward staging reconciles GitHub-mangled names, verifies bytes, and fails closed"
	exit 0
fi
echo "FAIL: stage-carryforward-debs contract violated"
exit 1
