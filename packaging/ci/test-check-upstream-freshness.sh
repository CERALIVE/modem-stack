#!/usr/bin/env bash
# test-check-upstream-freshness.sh — the OFFLINE contract for check-upstream-freshness.sh.
#
# NO NETWORK. Every case drives the script through its documented fixture seam
# (UPSTREAM_FRESHNESS_FIXTURE_DIR / --fixture-dir), which replaces `git ls-remote --tags --refs`
# with a read of `<dir>/<source>.<upstream|salsa>.tags`. The fixtures hold VERBATIM ls-remote
# output (`<sha>\trefs/tags/<tag>`), so the tag parse under test is the same parse the network
# path runs — only the transport is stubbed. Fixtures are generated into a scratch dir here
# rather than committed, so a case's tag set is readable beside the assertion it drives.
#
# The pins themselves are NOT stubbed: every case reads the real packaging/upstream-pins.yaml
# through the shared reader, so a pin bump immediately shows up here.
#
# CASES
#   (a) all four sources current                       => `current` x4, exit 0, NO issue body
#   (b) upstream 1.26.0 + salsa debian/1.26.0-1        => `behind`, body names src + both versions
#   (c) ONLY 1.25.95 added  <-- the real ModemManager   => still `current` (dev series ignored)
#       dev-series trap; 1.25.95 was uploaded to
#       Debian EXPERIMENTAL and must never bump a pin
#   (d) newer upstream, NO salsa packaging tag          => `upstream-ahead-no-packaging`,
#                                                          distinct from `behind`, exit 0, no body
#   (e) -rc / -dev / .90 pre-release noise              => `current`, each rejected on its own
#                                                          NAMED reason
#   (f) packaging-only revision debian/1.24.2-3         => `behind`, bump names the packaging tag
#   (g) fence: the script cannot mutate pins or dispatch a build (comment-stripped source scan,
#       with a non-vacuity control)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/check-upstream-freshness.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/upstream-freshness-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

rc=0
pass() { echo "ok:     $*"; }
fail() { echo "FAIL:   $*"; rc=1; }

# ---- fixture construction --------------------------------------------------------------------
# A fake but well-formed 40-char object id per tag; the script only reads column 2.
sha_for() { printf '%s' "$1" | sha1sum | awk '{print $1}'; }

mk_tags() {
	local file="$1"; shift
	: > "$file"
	local t
	for t in "$@"; do
		printf '%s\trefs/tags/%s\n' "$(sha_for "$t")" "$t" >> "$file"
	done
}

# The at-the-pins baseline, with each project's real odd-minor development series present as
# noise so EVERY case (including "all current") exercises the stable filter rather than only
# the cases that name it.
seed_baseline() {
	local d="$1"
	mkdir -p "$d"
	mk_tags "$d/modemmanager.upstream.tags" 1.20.6 1.22.0 1.23.4 1.24.0 1.24.2
	mk_tags "$d/modemmanager.salsa.tags" \
		debian/1.22.0-3 debian/1.24.0-1 debian/1.24.2-1 debian/1.24.2-2 upstream/1.24.2
	mk_tags "$d/libmbim.upstream.tags" 1.30.0 1.31.2 1.32.0 1.34.0
	mk_tags "$d/libmbim.salsa.tags" debian/1.32.0-1 debian/1.34.0-1
	mk_tags "$d/libqmi.upstream.tags" 1.34.0 1.35.6 1.36.0 1.38.0
	mk_tags "$d/libqmi.salsa.tags" debian/1.36.0-1 debian/1.38.0-1
	mk_tags "$d/libqrtr-glib.upstream.tags" 1.2.2 1.4.0
	mk_tags "$d/libqrtr-glib.salsa.tags" debian/1.2.2-1 debian/1.4.0-1
}

# add_tags <dir> <fixture-basename> <tag...> — append to an already-seeded fixture.
add_tags() {
	local d="$1" base="$2"; shift 2
	local t
	for t in "$@"; do
		printf '%s\trefs/tags/%s\n' "$(sha_for "$t")" "$t" >> "$d/$base"
	done
}

# ---- runner ------------------------------------------------------------------------------------
# run_case <name> <fixture-dir> [extra args...] -> sets OUT / ERR / EC and BODY_FILE
run_case() {
	local name="$1" dir="$2"; shift 2
	BODY_FILE="$WORK/$name.issue.md"
	rm -f "$BODY_FILE"
	OUT="$(UPSTREAM_FRESHNESS_FIXTURE_DIR="$dir" bash "$SCRIPT" --dry-run --issue-body "$BODY_FILE" "$@" 2>"$WORK/$name.err")"
	EC=$?
	ERR="$(cat "$WORK/$name.err")"
}

assert_verdict() {
	local name="$1" src="$2" want="$3"
	if printf '%s\n' "$OUT" | grep -qxF "$src: $want"; then
		pass "$name: $src => $want"
	else
		fail "$name: expected '$src: $want', got: $(printf '%s\n' "$OUT" | grep "^$src:" || echo '<no verdict line>')"
	fi
}

assert_exit() {
	local name="$1" want="$2"
	[ "$EC" -eq "$want" ] && pass "$name: exit $want" || fail "$name: expected exit $want, got $EC"
}

assert_no_body() {
	local name="$1"
	if [ -e "$BODY_FILE" ]; then
		fail "$name: an issue body was produced when none should be"
	elif printf '%s\n' "$OUT" | grep -qF -- '--- no issue would be opened'; then
		pass "$name: no issue body produced"
	else
		fail "$name: dry-run did not state that no issue would be opened"
	fi
}

assert_body_has() {
	local name="$1"; shift
	[ -r "$BODY_FILE" ] || { fail "$name: no issue body file at $BODY_FILE"; return; }
	local needle missing=""
	for needle in "$@"; do
		grep -qF -- "$needle" "$BODY_FILE" || missing+=" '$needle'"
	done
	[ -z "$missing" ] && pass "$name: issue body names$(printf ' %s' "$@")" \
		|| fail "$name: issue body is missing$missing"
}

assert_stderr_has() {
	local name="$1" needle="$2"
	printf '%s\n' "$ERR" | grep -qF -- "$needle" \
		&& pass "$name: reported '$needle'" \
		|| fail "$name: stderr never reported '$needle'"
}

echo "== (a) every source at its pin — nothing newer is released =="
CASE_A="$WORK/fx-current"; seed_baseline "$CASE_A"
run_case current "$CASE_A"
assert_exit current 0
for s in modemmanager libmbim libqmi libqrtr-glib; do assert_verdict current "$s" current; done
assert_no_body current

echo
echo "== (b) upstream 1.26.0 AND its Debian packaging tag exist => behind =="
CASE_B="$WORK/fx-behind"; seed_baseline "$CASE_B"
add_tags "$CASE_B" modemmanager.upstream.tags 1.26.0
add_tags "$CASE_B" modemmanager.salsa.tags debian/1.26.0-1
run_case behind "$CASE_B"
assert_exit behind 10
assert_verdict behind modemmanager "behind (1.26.0)"
assert_verdict behind libmbim current
assert_verdict behind libqmi current
assert_verdict behind libqrtr-glib current
assert_body_has behind modemmanager 1.24.2 1.26.0 debian/1.26.0-1
printf '%s\n' "$OUT" | grep -qF -- '--- issue body (dry-run, not sent) ---' \
	&& pass "behind: --dry-run printed the would-be issue body" \
	|| fail "behind: --dry-run did not print the issue body"

echo
echo "== (c) THE 1.25.95 TRAP — a dev-series release must NOT bump anything =="
CASE_C="$WORK/fx-devseries"; seed_baseline "$CASE_C"
add_tags "$CASE_C" modemmanager.upstream.tags 1.25.95
run_case devseries "$CASE_C"
assert_exit devseries 0
assert_verdict devseries modemmanager current
assert_no_body devseries
assert_stderr_has devseries "upstream tag '1.25.95' — odd-minor-development-series"

echo
echo "== (c') the same trap through Debian: 1.25.95-1 was an EXPERIMENTAL upload =="
CASE_C2="$WORK/fx-devseries-salsa"; seed_baseline "$CASE_C2"
add_tags "$CASE_C2" modemmanager.upstream.tags 1.25.95
add_tags "$CASE_C2" modemmanager.salsa.tags debian/1.25.95-1 debian/1.24.2-2~exp1
run_case devseries_salsa "$CASE_C2"
assert_exit devseries_salsa 0
assert_verdict devseries_salsa modemmanager current
assert_stderr_has devseries_salsa "salsa tag 'debian/1.25.95-1' — odd-minor-development-series"
assert_stderr_has devseries_salsa "salsa tag 'debian/1.24.2-2~exp1' — non-stable-debian-revision"

echo
echo "== (d) upstream released, Debian has not packaged it — NOT 'behind' =="
CASE_D="$WORK/fx-nopackaging"; seed_baseline "$CASE_D"
add_tags "$CASE_D" modemmanager.upstream.tags 1.26.0
run_case nopackaging "$CASE_D"
assert_exit nopackaging 0
assert_verdict nopackaging modemmanager "upstream-ahead-no-packaging (1.26.0)"
assert_no_body nopackaging
if printf '%s\n' "$OUT" | grep -q "^modemmanager: behind"; then
	fail "nopackaging: reported 'behind' for an unpackaged upstream release"
else
	pass "nopackaging: 'upstream-ahead-no-packaging' is distinct from 'behind' — no bump recommended"
fi

echo
echo "== (e) -rc / -dev / .9x pre-release noise, each rejected on its own named reason =="
CASE_E="$WORK/fx-prerelease"; seed_baseline "$CASE_E"
add_tags "$CASE_E" modemmanager.upstream.tags 1.26.0-rc1 1.26.0-dev 1.24.90 v1.26.0
add_tags "$CASE_E" modemmanager.salsa.tags debian/1.26.0-rc1-1
run_case prerelease "$CASE_E"
assert_exit prerelease 0
assert_verdict prerelease modemmanager current
assert_no_body prerelease
assert_stderr_has prerelease "upstream tag '1.26.0-rc1' — prerelease-suffix"
assert_stderr_has prerelease "upstream tag '1.26.0-dev' — prerelease-suffix"
assert_stderr_has prerelease "upstream tag '1.24.90' — snapshot-micro-series"
assert_stderr_has prerelease "upstream tag 'v1.26.0' — not-a-plain-triple"

echo
echo "== (f) packaging-only bump: same upstream, newer Debian revision =="
CASE_F="$WORK/fx-packaging-rev"; seed_baseline "$CASE_F"
add_tags "$CASE_F" libqmi.salsa.tags debian/1.38.0-3
run_case packagingrev "$CASE_F"
assert_exit packagingrev 10
assert_verdict packagingrev libqmi "behind (debian/1.38.0-3)"
assert_verdict packagingrev modemmanager current
assert_body_has packagingrev libqmi debian/1.38.0-1 debian/1.38.0-3

echo
echo "== (g) fence: issue-only — the script can neither mutate a pin nor dispatch a build =="
STRIPPED="$WORK/check-upstream-freshness.executable.sh"
# Drop whole-line comments and the quoted heredoc bodies. Both carry prose that legitimately
# names the very things the fence forbids (the header explains the contract; the issue body
# tells a reader the watch never edits the pins), so scanning the raw file would fence on the
# script's own documentation. Whole-LINE only — a partial strip would eat `${rest#debian/}`.
awk '
	/^[[:space:]]*#/ && NR > 1 { next }
	/<<-?'"'"'EOF'"'"'/ { inheredoc = 1; next }
	inheredoc && /^[[:space:]]*EOF[[:space:]]*$/ { inheredoc = 0; next }
	inheredoc { next }
	{ print }
' "$SCRIPT" > "$STRIPPED"

strip_control() {
	local what="$1" gone="$2" kept="$3"
	if grep -qF -- "$gone" "$STRIPPED"; then
		fail "fence: the $what strip is vacuous — '$gone' survived it"
	elif ! grep -qF -- "$kept" "$STRIPPED"; then
		fail "fence: the $what strip is over-eager — it removed '$kept'"
	else
		pass "fence: $what strip proven non-vacuous in both directions"
	fi
}
strip_control "comment" "ISSUE-ONLY BY CONTRACT" "ls_remote_tags"
strip_control "heredoc" "What this issue is NOT" "render_issue_body"

forbidden=""
for pat in 'upstream-pins.yaml' 'dch ' 'inject-deb-version' 'repository_dispatch' '/dispatches' \
	'gh api' 'gh issue' 'gh workflow' 'sed -i' 'tee '; do
	grep -qF -- "$pat" "$STRIPPED" && forbidden+=" '$pat'"
done
[ -z "$forbidden" ] \
	&& pass "fence: executable code names no pin file, no GitHub API call and no build dispatch" \
	|| fail "fence: executable code contains$forbidden"

echo
if [ "$rc" -eq 0 ]; then
	echo "PASS: upstream-freshness watch — dev-series (1.25.95) ignored, real bumps reported, unpackaged upstream kept distinct, issue-only"
else
	echo "FAIL: upstream-freshness contract violated"
fi
exit "$rc"
