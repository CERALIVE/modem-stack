#!/usr/bin/env bash
# test-detect-changed-sources.sh — the change-detector's behaviour contract.
#
# HOST-RUNNABLE, OFFLINE, NO DOCKER. Two seams make that possible, and the choice of seam is
# deliberate in each case:
#
#   1. THE DIFF IS REAL. There is no stubbed `git diff` and no injected changed-file list.
#      Each case runs inside a THROWAWAY GIT REPO built here — real commits, a real `v1.1.0`
#      tag, real `git diff --name-only <prev>..HEAD` and real `git show <ref>:<path>` for the
#      pin-block comparison. A stubbed file list would prove the classifier and leave the two
#      things most likely to break — the diff invocation and the block-scoped pin comparison —
#      completely uncovered. The fixture repo mirrors the real layout (`packaging/ci/`,
#      `packaging/<Source>/debian/`, `packaging/upstream-pins.yaml`) and carries a COPY of the
#      REAL `upstream-pins.yaml`, so the detector's pinned-set-vs-BUILD_ORDER contract check
#      runs against the real manifest.
#
#   2. `gh` IS STUBBED ON PATH. The previous-release resolution is `gh release list` /
#      `gh release download` by contract (never `git describe`), and both are network calls.
#      A stub dir is prepended to PATH; it shadows any real `gh`, answers per `STUB_GH`, and
#      exits 97 on an invocation no case expects — so a test can never silently reach the
#      network. The FORCE-ALL RULES THEMSELVES ARE NEVER STUBBED: case (d) forces because the
#      manifest genuinely could not be fetched, and the non-vacuity control right after it
#      proves the very same fixture goes `differential` once a manifest exists.
#
# Cases: (a) recipe change  (b) pin-block change  (c) shared input  (d) no release / no manifest
#        (e) v1-shaped manifest  (f) FORCE_REBUILD=all  + companion / non-packaging / no-change /
#        block-scoping controls.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="$HERE/detect-changed-sources.sh"
REAL_PINS="$PKG_ROOT/upstream-pins.yaml"

[ -f "$SCRIPT" ] || { echo "missing: $SCRIPT" >&2; exit 1; }
[ -r "$REAL_PINS" ] || { echo "missing: $REAL_PINS" >&2; exit 1; }

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ceralive-detect-changed.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

REPO="$ROOT/repo"
STUB_BIN="$ROOT/bin"
ERR="$ROOT/stderr.txt"
mkdir -p "$STUB_BIN"

# ---- the offline `gh` stub -------------------------------------------------------------------
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
# Offline `gh` stub for test-detect-changed-sources.sh. Behaviour is selected by STUB_GH.
# Anything unexpected exits 97 so a case can never silently reach the real gh / the network.
set -uo pipefail
sub="${1:-}/${2:-}"
case "${STUB_GH:-unset}:${sub}" in
	no-release:release/list)   exit 0 ;;                 # a repo with no published release
	have-release:release/list) echo "v1.1.0"; exit 0 ;;  # a release exists ...
	*:release/download)        echo "gh(stub): no asset matched the pattern" >&2; exit 1 ;;
	*) echo "gh(stub): unexpected invocation: $*" >&2; exit 97 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

# ---- the throwaway fixture repo ---------------------------------------------------------------
mkdir -p "$REPO/packaging/ci" "$REPO/packaging/ceralive-modem-support/debian" "$REPO/control/src"
cp "$SCRIPT" "$REPO/packaging/ci/detect-changed-sources.sh"
cp "$REAL_PINS" "$REPO/packaging/upstream-pins.yaml"
printf 'shared build inputs live here\n' >"$REPO/packaging/SUITE-ADAPTATIONS.md"
printf '# stand-in for the real builder\n' >"$REPO/packaging/ci/build-stack.sh"
printf '[libqmi all-artifact]\nlibqmi-glib5\n' >"$REPO/packaging/ci/expected-packages.txt"
printf 'Source: ceralive-modem-support\n' >"$REPO/packaging/ceralive-modem-support/debian/control"
printf 'export const x = 1;\n' >"$REPO/control/src/index.ts"
for d in libqrtr-glib libmbim libqmi ModemManager; do
	mkdir -p "$REPO/packaging/$d/debian"
	printf '#!/usr/bin/make -f\n%%:\n\tdh $@\n' >"$REPO/packaging/$d/debian/rules"
	printf '%s (0.0.0-1) unstable; urgency=medium\n' "$d" >"$REPO/packaging/$d/debian/changelog"
done

git -C "$REPO" init -q
git -C "$REPO" config user.email "ci@ceralive.tv"
git -C "$REPO" config user.name "CeraLive CI"
git -C "$REPO" config commit.gpgsign false
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "fixture: release v1.1.0 state"
git -C "$REPO" tag v1.1.0

# ---- fixture previous-release manifests --------------------------------------------------------
M_V2="$ROOT/release-manifest-v2.txt"
M_V1="$ROOT/release-manifest-v1.txt"
cat >"$M_V2" <<'EOF'
# CeraLive modem-stack release manifest (fixture)
tag: v1.1.0
version: 1.1.0
closure_version: 2
amd64  libqmi-glib5  libqmi  1.38.0-1~ceralive1.1.0  runtime  libqmi-glib5_1.38.0-1~ceralive1.1.0_amd64.deb  0000
EOF
cat >"$M_V1" <<'EOF'
# CeraLive modem-stack release manifest (fixture) — v1 shape: NO closure_version header.
tag: v1.0.0
version: 1.0.0
amd64  libqmi-glib5  libqmi  1.38.0-1~ceralive1.0.0  runtime  libqmi-glib5_1.38.0-1~ceralive1.0.0_amd64.deb  0000
EOF

# ---- harness -----------------------------------------------------------------------------------
reset_repo() {
	git -C "$REPO" reset --hard -q v1.1.0
	git -C "$REPO" clean -qfd
}
commit_all() {
	git -C "$REPO" add -A
	git -C "$REPO" commit -q -m "$1"
}
# Runs the detector inside the fixture repo with the stub `gh` shadowing any real one.
detect() { (cd "$REPO" && PATH="$STUB_BIN:$PATH" bash packaging/ci/detect-changed-sources.sh 2>"$ERR"); }

assert_has()  { if printf '%s\n' "$2" | grep -qxF "$1"; then ok "$3"; else bad "$3 — stdout has no '$1'"; fi; }
assert_err()  { if grep -qE "$1" "$ERR"; then ok "$2"; else bad "$2 — stderr has no /$1/"; fi; }
assert_rc()   { if [ "$1" -eq "$2" ]; then ok "$3"; else bad "$3 — exit $1, expected $2"; fi; }
# All four sources at one verdict, in one assertion.
assert_all()  {
	local want="$1" out="$2" label="$3" s
	for s in libqrtr-glib libmbim libqmi modemmanager; do
		if ! printf '%s\n' "$out" | grep -qxF "$s=$want"; then bad "$label — $s is not '$want'"; return; fi
	done
	ok "$label"
}

echo "== (a) a recipe change implicates ONLY its own source =="
reset_repo
printf '\n# a real recipe edit\n' >>"$REPO/packaging/libqmi/debian/rules"
commit_all "touch libqmi recipe"
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_has "libqmi=changed" "$out" "libqmi=changed"
assert_has "libmbim=unchanged" "$out" "libmbim=unchanged"
assert_has "modemmanager=unchanged" "$out" "modemmanager=unchanged"
assert_has "libqrtr-glib=unchanged" "$out" "libqrtr-glib=unchanged"
assert_has "mode=differential" "$out" "mode=differential"
assert_err "libqmi=changed .*recipe" "the reason names the changed recipe file"
# The stdout contract is exactly five lines — a consumer greps it, so stray output is a break.
if [ "$(printf '%s\n' "$out" | grep -c .)" -eq 5 ]; then ok "stdout is exactly 4 source lines + mode"; else bad "stdout is not 5 lines: $out"; fi

echo "== (b) editing a source's pin block implicates ONLY that source =="
reset_repo
sed -i 's|^    upstream_tag: "1.38.0"|    upstream_tag: "1.38.1"|' "$REPO/packaging/upstream-pins.yaml"
if grep -q '1.38.1' "$REPO/packaging/upstream-pins.yaml"; then ok "fixture: libqmi pin block edited"; else bad "fixture: pin edit did not apply"; fi
commit_all "bump the libqmi pin"
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_has "libqmi=changed" "$out" "libqmi=changed"
assert_has "libmbim=unchanged" "$out" "libmbim=unchanged"
assert_has "modemmanager=unchanged" "$out" "modemmanager=unchanged"
assert_has "libqrtr-glib=unchanged" "$out" "libqrtr-glib=unchanged"
assert_has "mode=differential" "$out" "mode=differential"
assert_err "libqmi=changed .*pin block" "the reason names the pin block"

echo "== (b-control) the pin comparison is BLOCK-SCOPED, not whole-file =="
reset_repo
printf '\n# a comment outside every source block\n' >>"$REPO/packaging/upstream-pins.yaml"
commit_all "comment-only pins edit"
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_all unchanged "$out" "a comment-only pins edit implicates no source"
assert_has "mode=differential" "$out" "mode=differential"

echo "== (b-control-2) the NON-IDENTITY dir->pin-key mapping is exercised =="
reset_repo
printf '\n# a real recipe edit\n' >>"$REPO/packaging/ModemManager/debian/rules"
commit_all "touch ModemManager recipe"
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_has "modemmanager=changed" "$out" "dir 'ModemManager' reports as pin key 'modemmanager'"
if printf '%s\n' "$out" | grep -q '^ModemManager='; then bad "the directory name leaked into stdout"; else ok "no directory name leaked into stdout"; fi
assert_has "libqmi=unchanged" "$out" "libqmi=unchanged"

echo "== (c) a shared build input forces every source =="
for shared in packaging/ci/build-stack.sh packaging/ci/expected-packages.txt packaging/SUITE-ADAPTATIONS.md; do
	reset_repo
	printf '\n# shared input edit\n' >>"$REPO/$shared"
	commit_all "touch $shared"
	out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
	assert_rc "$rc" 0 "exit 0 ($shared)"
	assert_has "mode=force-all" "$out" "mode=force-all ($shared)"
	assert_all changed "$out" "every source changed ($shared)"
	assert_err "shared-input-changed" "the reason is shared-input-changed ($shared)"
done

echo "== (d) previous release absent, or carrying no manifest, forces every source =="
reset_repo
printf '\n# a real recipe edit\n' >>"$REPO/packaging/libqmi/debian/rules"
commit_all "touch libqmi recipe"
# (d1) no published release at all — PREV_TAG unset, `gh release list` answers nothing.
out="$(STUB_GH=no-release detect)"; rc=$?
assert_rc "$rc" 0 "exit 0 (no published release)"
assert_has "mode=force-all" "$out" "mode=force-all (no published release)"
assert_all changed "$out" "every source changed (no published release)"
assert_err "previous-release-absent" "the reason is previous-release-absent"
# (d2) a release exists but carries no manifest asset — `gh release download` fails.
out="$(STUB_GH=have-release detect)"; rc=$?
assert_rc "$rc" 0 "exit 0 (release without a manifest asset)"
assert_has "mode=force-all" "$out" "mode=force-all (release without a manifest asset)"
assert_all changed "$out" "every source changed (release without a manifest asset)"
assert_err "previous-manifest-absent" "the reason is previous-manifest-absent"

echo "== (d-non-vacuity) the SAME commit goes differential once a manifest exists =="
# Nothing about the force-all rules is stubbed anywhere in (d); the only difference here is that
# a manifest is reachable. If this went force-all too, (d) would have proven nothing.
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_has "mode=differential" "$out" "mode=differential with a reachable v2 manifest"
assert_has "libqmi=changed" "$out" "libqmi=changed"
assert_has "libmbim=unchanged" "$out" "libmbim=unchanged"

echo "== (e) a v1-shaped previous manifest (no closure_version header) forces every source =="
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V1" detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_has "mode=force-all" "$out" "mode=force-all"
assert_all changed "$out" "every source changed"
assert_err "previous-manifest-v1-shaped" "the reason is previous-manifest-v1-shaped"

echo "== (f) FORCE_REBUILD=all forces every source with no release lookup at all =="
# STUB_GH is deliberately left unset: the stub exits 97 on any call, so this case also proves
# the override short-circuits BEFORE any previous-release resolution.
out="$(FORCE_REBUILD=all detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_has "mode=force-all" "$out" "mode=force-all"
assert_all changed "$out" "every source changed"
assert_err "FORCE_REBUILD=all" "the reason names the operator override"
out="$(FORCE_REBUILD=libqmi PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
assert_rc "$rc" 2 "an unrecognized FORCE_REBUILD value fails closed"
assert_err "FORCE_REBUILD='libqmi' is not a recognized value" "the error names the bad value"

echo "== (g) the companion is never part of detection =="
reset_repo
printf 'Description: a companion-only change\n' >>"$REPO/packaging/ceralive-modem-support/debian/control"
commit_all "touch the companion"
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_all unchanged "$out" "a companion-only change leaves all four sources unchanged"
assert_has "mode=differential" "$out" "mode=differential"
if printf '%s\n' "$out" | grep -q 'ceralive-modem-support'; then bad "the companion was verdicted"; else ok "the companion is never verdicted"; fi

echo "== (h) a TypeScript-only release changes no packaging source =="
reset_repo
printf 'export const y = 2;\n' >>"$REPO/control/src/index.ts"
commit_all "touch control/"
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_all unchanged "$out" "all four sources unchanged"
assert_has "mode=differential" "$out" "mode=differential"

echo "== (i) an empty diff is differential with nothing changed =="
reset_repo
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_all unchanged "$out" "all four sources unchanged"
assert_has "mode=differential" "$out" "mode=differential"

echo "== (j) --out writes the same contract lines to a file =="
outfile="$ROOT/verdicts.txt"
out="$(cd "$REPO" && PATH="$STUB_BIN:$PATH" PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" \
	bash packaging/ci/detect-changed-sources.sh --out "$outfile" 2>"$ERR")"; rc=$?
assert_rc "$rc" 0 "exit 0"
if [ -f "$outfile" ] && [ "$(cat "$outfile")" = "$out" ]; then ok "--out file matches stdout"; else bad "--out file differs from stdout"; fi

echo "== (k) seam misuse fails closed rather than silently forcing =="
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$ROOT/does-not-exist.txt" detect)"; rc=$?
assert_rc "$rc" 2 "an unreadable PREV_MANIFEST_FILE exits 2"
assert_err "PREV_MANIFEST_FILE=.*is set but not readable" "the error names the seam"
out="$(PREV_TAG=v1.1.0 PREV_MANIFEST_FILE="$M_V2" HEAD_REF=refs/heads/nope detect)"; rc=$?
assert_rc "$rc" 2 "an unresolvable HEAD_REF exits 2"
assert_err "HEAD ref 'refs/heads/nope' does not resolve" "the error names the ref"

echo "== (l) an unfetched previous tag forces every source rather than guessing =="
out="$(PREV_TAG=v9.9.9 PREV_MANIFEST_FILE="$M_V2" detect)"; rc=$?
assert_rc "$rc" 0 "exit 0"
assert_has "mode=force-all" "$out" "mode=force-all"
assert_all changed "$out" "every source changed"
assert_err "previous-ref-unresolvable" "the reason is previous-ref-unresolvable"

echo
echo "passed: $pass   failed: $fail"
if [ "$fail" -eq 0 ]; then
	echo "PASS: per-source change detection + force-all bootstrap rules hold"
	exit 0
fi
echo "FAIL: detect-changed-sources contract violated"
exit 1
