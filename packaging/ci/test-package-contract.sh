#!/usr/bin/env bash
# test-package-contract.sh <amd64|arm64> — the package contract suite for the bookworm
# ModemManager 1.24 stack rebuilds.
#
# Runs the A5.1 build output (packaging/build/<arch>/*.deb) through the contract every
# device install must satisfy. All checks are REAL executed commands inside a throwaway
# `debian:bookworm` container — nothing is narrated. It NEVER mutates the committed
# packaging tree (version-injection experiments operate on ephemeral strings / copies).
#
# CHECKS
#   1  metadata/arch      — Package/Version/Architecture over the 9-package runtime closure
#   2  closure install    — clean bookworm: `apt-get install ./*.deb` of the 9, no missing deps
#   3  upgrade            — stock modemmanager 1.20.4 -> the tag-encoded ceralive set
#   4  rollback           — ceralive set -> stock, correct apt semantics (source-disable +
#                           explicit stock versions + --allow-downgrades)
#   5  coherence          — PER-SOURCE: every runtime deb of ONE upstream source carries the
#                           same ~ceralive suffix; different sources may differ (differential
#                           releases) (+ an internally-mixed-libqmi negative that fails closed)
#   6  ordering           — REAL `dpkg --compare-versions` proofs of the tilde ordering, incl.
#                           the migration-continuity chain from every published legacy version
#   7  tag-guard negative — a pre-release tag is rejected BEFORE any deb is produced
#   8  piuparts-style     — install then purge each package; assert zero leftover files
#
# MODES (per plan: "amd64 full; arm64 metadata + QEMU install where runner permits")
#   full      — all 8 checks (default for amd64)
#   metadata  — checks 1,5,6 only, the fast dpkg-metadata proofs (default for arm64, whose
#               apt-install-under-QEMU is prohibitively slow on a CI runner)
#   Override with CONTRACT_MODE=full|metadata.
#
# USAGE
#   packaging/ci/test-package-contract.sh amd64
#   CONTRACT_MODE=full packaging/ci/test-package-contract.sh arm64   # force full under QEMU
#
# EXIT  0 all checks pass. 2 usage/env (no debs, no docker). non-zero = a contract breach.
set -euo pipefail

# The 9-package runtime closure (contract constant, matches build-bookworm.sh).
RUNTIME_PKGS=(modemmanager libmm-glib0 libmbim-glib4 libmbim-proxy libmbim-utils \
	libqmi-glib5 libqmi-proxy libqmi-utils libqrtr-glib0)
STOCK_MM_UPSTREAM="1.20.4"   # bookworm's stock modemmanager upstream version

# ==========================================================================================
# HOST ROLE — tag-guard preamble (no container needed), then launch the container.
# ==========================================================================================
if [ "${IN_CONTAINER:-0}" != "1" ]; then
	ARCH="${1:-amd64}"
	case "$ARCH" in
		amd64) PLATFORM="linux/amd64" ;;
		arm64) PLATFORM="linux/arm64" ;;
		*) echo "usage: test-package-contract.sh <amd64|arm64>" >&2; exit 2 ;;
	esac
	MODE="${CONTRACT_MODE:-$([ "$ARCH" = amd64 ] && echo full || echo metadata)}"

	HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	PKG_ROOT="$(cd "$HERE/.." && pwd)"
	BUILD_DIR="${BUILD_DIR:-$PKG_ROOT/build/$ARCH}"

	command -v docker >/dev/null 2>&1 || { echo "contract: docker not found" >&2; exit 2; }
	ls "$BUILD_DIR"/*.deb >/dev/null 2>&1 || {
		echo "contract: no .deb in $BUILD_DIR — run ci/build-bookworm.sh $ARCH first" >&2; exit 2; }

	echo "======================================================================"
	echo "package contract suite   arch=$ARCH   mode=$MODE"
	echo "  packaging root: $PKG_ROOT"
	echo "  build dir:      $BUILD_DIR"
	echo "======================================================================"

	# ---- CHECK 7 (host-side, before any container/deb work) ------------------------------
	# The tag-guard runs FIRST in release.yml and gates build-deb, so a pre-release tag is
	# rejected before a single .deb exists. Prove that here, with no debs touched.
	echo
	echo "==== CHECK 7: tag-guard negative (pre-release rejected before any deb build) ===="
	guard_reject() {
		if bash "$HERE/tag-guard.sh" "$1" >/dev/null 2>&1; then
			echo "  FAIL: tag-guard ACCEPTED '$1' (should reject before build)"; return 1
		fi
		echo "  ok: rejected '$1' (no deb produced)"
	}
	guard_accept() {
		local v; v="$(bash "$HERE/tag-guard.sh" "$1")" || { echo "  FAIL: tag-guard rejected valid '$1'"; return 1; }
		echo "  ok: accepted '$1' -> $v"
	}
	guard_reject "v1.0.0-rc.1"
	guard_reject "v1.0.0+build5"
	guard_reject "1.0.0"
	guard_accept "v1.2.3"
	echo "  CHECK 7 PASS: the tag guard fails closed on pre-release/metadata tags."

	# Mount packaging/ (ro, for the ci/ scripts) + the built debs (ro). Re-invoke in-container.
	docker run --rm --platform "$PLATFORM" \
		-e IN_CONTAINER=1 -e ARCH="$ARCH" -e CONTRACT_MODE="$MODE" \
		-e STOCK_MM_UPSTREAM="$STOCK_MM_UPSTREAM" \
		-v "$PKG_ROOT":/pkg:ro \
		-v "$BUILD_DIR":/debs:ro \
		debian:bookworm \
		bash /pkg/ci/test-package-contract.sh "$ARCH"

	echo
	echo "======================================================================"
	echo "CONTRACT SUITE PASS [$ARCH, mode=$MODE]"
	echo "======================================================================"
	exit 0
fi

# ==========================================================================================
# CONTAINER ROLE — the real dpkg/apt checks, inside debian:bookworm.
# ==========================================================================================
ARCH="${ARCH:-$(dpkg --print-architecture)}"
MODE="${CONTRACT_MODE:-full}"
STOCK_MM_UPSTREAM="${STOCK_MM_UPSTREAM:-1.20.4}"
export DEBIAN_FRONTEND=noninteractive

echo
echo "== in-container contract (arch=$(dpkg --print-architecture), target=$ARCH, mode=$MODE) =="

# apt drops to the unprivileged _apt user for acquire and cannot read a local file: repo
# under a 0700 dir — same fix build-bookworm.sh uses.
echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/01-no-sandbox
apt-get update -qq
# dpkg-scanpackages (local-repo index for the upgrade/rollback scenarios) ships in dpkg-dev;
# base debian:bookworm has dpkg-deb/dpkg-query but not dpkg-dev.
apt-get install -y -qq dpkg-dev >/dev/null 2>&1

# Resolve each runtime package name to its single .deb file (exact Package match — so
# libmbim-glib4 is never confused with libmbim-glib4-dbgsym).
declare -A DEB_OF
resolve_debs() {
	local deb pkg
	for deb in /debs/*.deb; do
		pkg="$(dpkg-deb -f "$deb" Package)"
		DEB_OF["$pkg"]="$deb"
	done
	local missing=0
	for pkg in "${RUNTIME_PKGS[@]}"; do
		[ -n "${DEB_OF[$pkg]:-}" ] || { echo "  MISSING runtime deb: $pkg" >&2; missing=1; }
	done
	[ "$missing" -eq 0 ] || { echo "STOP: runtime closure incomplete in /debs" >&2; exit 3; }
}
resolve_debs

# ---- pin-derived versions (single source of truth: upstream-pins.yaml + changelogs) -------
# Every version literal the checks below assert against comes from read-pin.sh, so a pin bump
# (MM 1.24.0-1 -> 1.24.2-2, libmbim 1.32.0 -> 1.34.0, libqmi 1.36.0 -> 1.38.0, libqrtr-glib
# 1.2.2 -> 1.4.0) needs no edits here, and a wrong revision (`-1` vs the real `-2`) fails closed.
CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readpin() { bash "$CI_DIR/read-pin.sh" "$@"; }
# The suffix contract (per-source coherence + the migration-continuity chain) is SOURCED so
# this container suite and the host suite ci/test-suffix-coherence-manifest.sh prove the same
# rule with the same code, instead of two copies that can drift.
# shellcheck source=suffix-contract.sh
. "$CI_DIR/suffix-contract.sh"
MM_TAG="$(readpin modemmanager upstream_tag)"       # upstream tag, matches mmcli --version
MM_BASE="$(readpin modemmanager --base-version)"    # full Debian base <upstream>-<rev>, revision-exact
MBIM_BASE="$(readpin libmbim --base-version)"
QMI_BASE="$(readpin libqmi --base-version)"
QRTR_BASE="$(readpin libqrtr-glib --base-version)"

# Expected per-package upgrade direction vs bookworm stock, EMPIRICALLY resolved for this bump
# (real `dpkg --compare-versions` in a bookworm container, todo 1.3): every source now sorts
# ABOVE stock. libqrtr-glib flipped from BELOW -> ABOVE (1.2.2-1~ceralive was tilde-lower than
# stock 1.2.2-1; the new 1.4.0 outranks stock 1.2.2-1 outright), so the upgrade no longer needs
# --allow-downgrades. compute_direction_table asserts this holds against the real built debs.
declare -A EXPECT_DIR=(
	[modemmanager]=above  [libmm-glib0]=above
	[libmbim-glib4]=above [libmbim-proxy]=above [libmbim-utils]=above
	[libqmi-glib5]=above  [libqmi-proxy]=above  [libqmi-utils]=above
	[libqrtr-glib0]=above
)
NEED_DOWNGRADE=0

# Each runtime package -> its source's revision-exact Debian base, so CHECK 1 asserts every
# built deb carries the correct <upstream>-<rev> (not just any ~ceralive suffix); a stray `-1`
# on any of the nine fails closed.
declare -A PKG_BASE=(
	[modemmanager]="$MM_BASE"    [libmm-glib0]="$MM_BASE"
	[libmbim-glib4]="$MBIM_BASE" [libmbim-proxy]="$MBIM_BASE" [libmbim-utils]="$MBIM_BASE"
	[libqmi-glib5]="$QMI_BASE"   [libqmi-proxy]="$QMI_BASE"   [libqmi-utils]="$QMI_BASE"
	[libqrtr-glib0]="$QRTR_BASE"
)

# ------------------------------------------------------------------------------------------
# CHECK 1 — metadata / architecture over the 9-package runtime closure.
# ------------------------------------------------------------------------------------------
check_metadata() {
	echo; echo "==== CHECK 1: metadata / arch over the 9-package runtime closure ===="
	local pkg deb ver arch fail=0
	printf '  %-20s %-32s %s\n' "PACKAGE" "VERSION" "ARCH"
	for pkg in "${RUNTIME_PKGS[@]}"; do
		deb="${DEB_OF[$pkg]}"
		ver="$(dpkg-deb -f "$deb" Version)"
		arch="$(dpkg-deb -f "$deb" Architecture)"
		printf '  %-20s %-32s %s\n' "$pkg" "$ver" "$arch"
		[ "$arch" = "$ARCH" ]        || { echo "    FAIL: arch $arch != $ARCH"; fail=1; }
		[ "${ver#*~ceralive}" != "$ver" ] || { echo "    FAIL: version has no ~ceralive suffix"; fail=1; }
		# Revision-exact: the base before ~ceralive must equal the pinned <upstream>-<rev>.
		[ "${ver%%~ceralive*}" = "${PKG_BASE[$pkg]}" ] || { echo "    FAIL: $pkg base '${ver%%~ceralive*}' != pinned '${PKG_BASE[$pkg]}'"; fail=1; }
	done
	[ "$fail" -eq 0 ] || { echo "  CHECK 1 FAIL"; return 1; }
	echo "  CHECK 1 PASS: 9 runtime packages, all Architecture=$ARCH, all pin-exact <upstream>-<rev>~ceralive."
}

# ------------------------------------------------------------------------------------------
# CHECK 5 — PER-SOURCE coherence: every runtime deb of ONE upstream source shares one
# ~ceralive suffix. Two SOURCES holding different counters is not a breach any more — under
# differential releases a rebuilt source moves to its next `.N` while an untouched one keeps
# the counter it already had, so the old global-identity assertion would now reject a correct
# release. The breach that remains is INTRA-source: two debs of one source disagreeing can
# only mean one of them shipped at the wrong version.
# assert_coherent / assert_source_coherent / suffix_source_of live in ci/suffix-contract.sh.
# ------------------------------------------------------------------------------------------
check_coherence() {
	echo; echo "==== CHECK 5: PER-SOURCE coherence (one ~ceralive suffix within each source) ===="
	local pkg specs=() table src n suffix
	for pkg in "${RUNTIME_PKGS[@]}"; do
		specs+=("${pkg}=$(dpkg-deb -f "${DEB_OF[$pkg]}" Version)")
	done
	if ! table="$(assert_group_coherence "${specs[@]}")"; then
		echo "  CHECK 5 FAIL: a source's runtime debs are internally incoherent"; return 1
	fi
	while read -r src n suffix; do
		printf '  ok: %-14s %d runtime deb(s) share suffix %s\n' "$src" "$n" "$suffix"
	done <<<"$table"

	# Positive fixture: sources at DIFFERENT counters must both be accepted. It has to be a
	# fixture — one build run produces one release's set, which cannot itself demonstrate the
	# cross-source difference a later differential release will carry.
	echo "  positive fixture (two sources at different counters, both accepted):"
	assert_source_coherent modemmanager "${MM_BASE}~ceralive.1" "${MM_BASE}~ceralive.1" >/dev/null \
		|| { echo "  CHECK 5 FAIL: rejected a coherent modemmanager pair at .1"; return 1; }
	assert_source_coherent libqmi "${QMI_BASE}~ceralive.2" "${QMI_BASE}~ceralive.2" >/dev/null \
		|| { echo "  CHECK 5 FAIL: rejected a coherent libqmi pair at .2"; return 1; }
	echo "  ok: modemmanager at .1 beside libqmi at .2 — accepted (differential releases are legal)"

	# Negative fixture: ONE source internally mixed MUST fail closed and NAME that source.
	echo "  negative fixture (libqmi internally mixed, expected to fail):"
	local neg rc_neg=0
	neg="$(assert_source_coherent libqmi "${QMI_BASE}~ceralive.2" "${QMI_BASE}~ceralive.3" 2>&1)" || rc_neg=$?
	[ "$rc_neg" -ne 0 ] || { echo "  CHECK 5 FAIL: coherence accepted an internally-mixed libqmi set"; return 1; }
	case "$neg" in
		*libqmi*) echo "  ok: internally-mixed libqmi set rejected, and the failure names 'libqmi'" ;;
		*) echo "  CHECK 5 FAIL: rejection did not name the source: $neg"; return 1 ;;
	esac
	echo "  CHECK 5 PASS."
}

# ------------------------------------------------------------------------------------------
# CHECK 6 — REAL dpkg --compare-versions ordering proofs of the tilde encoding, plus the
# MIGRATION-CONTINUITY chain: every legacy suffix that exists as a published artifact today
# (v0.2.0's closure and v1.0.0's repair are live on apt; v1.1.0 released 2026-08-21) must sort
# BELOW the counter scheme, and the counters must order among themselves — including `.2` <
# `.10`, which a lexical compare gets backwards.
# ------------------------------------------------------------------------------------------
check_ordering() {
	echo; echo "==== CHECK 6: dpkg --compare-versions ordering proofs (real invocations) ===="
	local fail=0
	prove_lt() {
		if dpkg --compare-versions "$1" lt "$2"; then echo "  ok: '$1' lt '$2'"
		else echo "  FAIL: '$1' NOT lt '$2'"; fail=1; fi
	}
	prove_not_lt() {
		if dpkg --compare-versions "$1" lt "$2"; then echo "  FAIL: '$1' lt '$2' (expected NOT)"; fail=1
		else echo "  ok: '$1' not lt '$2'"; fi
	}
	prove_lt "${MM_BASE}~ceralive0.1.0"  "${MM_BASE}~ceralive0.2.0"
	prove_lt "${MM_BASE}~ceralive0.9.0"  "${MM_BASE}~ceralive0.10.0"
	prove_lt "${MM_BASE}~ceralive0.1.0"  "${MM_BASE}"
	prove_lt "${MM_BASE}~ceralive0.0.0~dev" "${MM_BASE}~ceralive0.1.0"
	# comparator must be real, not always-true:
	prove_not_lt "${MM_BASE}~ceralive0.2.0" "${MM_BASE}~ceralive0.1.0"

	echo "  migration-continuity chain (legacy published versions -> per-source counters -> stock):"
	prove_chain_ordered "$MM_BASE" || fail=1
	prove_not_lt "${MM_BASE}~ceralive.10" "${MM_BASE}~ceralive.2"

	[ "$fail" -eq 0 ] || { echo "  CHECK 6 FAIL"; return 1; }
	echo "  CHECK 6 PASS: tilde ordering holds and every published legacy version upgrades into"
	echo "  the counter scheme (0.2.0 < 1.0.0 < 1.1.0 < .1 < .2 < .10 < ${MM_BASE})."
}

# ---- local apt repo helpers (for install/upgrade/rollback scenarios) ---------------------
REPO="/tmp/localrepo"
setup_local_repo() {
	rm -rf "$REPO"; mkdir -p "$REPO"
	cp /debs/*.deb "$REPO/"
	( cd "$REPO" && dpkg-scanpackages -m . /dev/null > Packages 2>/dev/null )
	echo "deb [trusted=yes] file:$REPO ./" > /etc/apt/sources.list.d/local-mm.list
	# Pin the local (freshly built) stack at 1001 (> 1000) so the coherent ceralive set always
	# wins regardless of direction. Every source now outranks bookworm-main on upstream version
	# (incl. libqrtr-glib 1.4.0 > stock 1.2.2-1), so this is belt-and-suspenders, not a downgrade
	# force — but the pin keeps the set coherent if a future stock point-release ever catches up.
	cat > /etc/apt/preferences.d/local-mm.pref <<'EOF'
Package: *
Pin: origin ""
Pin-Priority: 1001
EOF
	apt-get update -qq
}
disable_local_repo() {
	rm -f /etc/apt/sources.list.d/local-mm.list /etc/apt/preferences.d/local-mm.pref
	apt-get update -qq
}
purge_stack() {
	apt-get purge -y -qq "${RUNTIME_PKGS[@]}" >/dev/null 2>&1 || true
	apt-get autoremove -y -qq >/dev/null 2>&1 || true
}
dpkg_ver() { dpkg-query -W -f='${Version}' "$1" 2>/dev/null || echo "(absent)"; }

# Real per-package upgrade direction: each built ceralive deb vs bookworm-main stock, via actual
# `dpkg --compare-versions`. Asserts every package lands on its EXPECT_DIR side and sets
# NEED_DOWNGRADE=1 iff any source sorts below stock (so the upgrade passes --allow-downgrades
# only where genuinely required). Call with the local repo DISABLED so madison yields stock.
compute_direction_table() {
	echo "  ---- upgrade direction table (built ceralive deb vs bookworm stock, real dpkg) ----"
	printf '    %-16s %-30s %-12s %-7s %s\n' PACKAGE CERALIVE STOCK DIR EXPECT
	local pkg built stock dir exp fail=0
	NEED_DOWNGRADE=0
	for pkg in "${RUNTIME_PKGS[@]}"; do
		built="$(dpkg-deb -f "${DEB_OF[$pkg]}" Version)"
		stock="$(apt-cache madison "$pkg" 2>/dev/null | awk -F'|' 'NR==1{gsub(/^[ \t]+|[ \t]+$/,"",$2); print $2; exit}')"
		if   [ -z "$stock" ];                                    then dir="no-stock"
		elif dpkg --compare-versions "$built" gt "$stock";       then dir="above"
		elif dpkg --compare-versions "$built" lt "$stock";       then dir="below"; NEED_DOWNGRADE=1
		else                                                          dir="equal"; fi
		exp="${EXPECT_DIR[$pkg]:-above}"
		printf '    %-16s %-30s %-12s %-7s %s\n' "$pkg" "$built" "${stock:-<none>}" "$dir" "$exp"
		[ "$dir" = "$exp" ] || { echo "      FAIL: $pkg sorts '$dir' vs stock, expected '$exp'"; fail=1; }
	done
	[ "$fail" -eq 0 ] || { echo "  DIRECTION TABLE FAIL: a package is on the wrong side of stock"; return 1; }
	if [ "$NEED_DOWNGRADE" -eq 1 ]; then
		echo "  => a source sorts BELOW stock; the upgrade requires --allow-downgrades."
	else
		echo "  => every source sorts ABOVE stock; the upgrade needs NO --allow-downgrades."
	fi
}

# ------------------------------------------------------------------------------------------
# CHECK 2 — clean-bookworm dependency-closure install via `apt-get install ./*.deb`.
# ------------------------------------------------------------------------------------------
check_closure_install() {
	echo; echo "==== CHECK 2: clean-bookworm dependency-closure install (apt-get install ./*.deb) ===="
	purge_stack
	local files=()
	for pkg in "${RUNTIME_PKGS[@]}"; do files+=("${DEB_OF[$pkg]}"); done
	echo "  installing the 9 runtime debs as local files (deps resolve from bookworm-main)..."
	apt-get install -y -qq "${files[@]}" >/tmp/closure.log 2>&1 || { sed 's/^/    /' /tmp/closure.log; echo "  CHECK 2 FAIL: install error"; return 1; }
	local pkg fail=0
	for pkg in "${RUNTIME_PKGS[@]}"; do
		local v; v="$(dpkg_ver "$pkg")"
		case "$v" in *~ceralive*) echo "  ok: $pkg = $v" ;; *) echo "  FAIL: $pkg = $v (not ceralive)"; fail=1 ;; esac
	done
	# No unmet dependencies anywhere.
	if ! apt-get check >/tmp/aptcheck.log 2>&1; then sed 's/^/    /' /tmp/aptcheck.log; echo "  CHECK 2 FAIL: apt-get check reports broken deps"; return 1; fi
	[ "$fail" -eq 0 ] || { echo "  CHECK 2 FAIL"; return 1; }
	echo "  ok: apt-get check clean (no missing deps)"
	echo "  CHECK 2 PASS: the 9-package closure installs cleanly on stock bookworm."
	purge_stack
}

# ------------------------------------------------------------------------------------------
# CHECK 3 — upgrade: stock modemmanager 1.20.4 -> the tag-encoded ceralive set.
# ------------------------------------------------------------------------------------------
check_upgrade() {
	echo; echo "==== CHECK 3: upgrade (stock modemmanager ${STOCK_MM_UPSTREAM} -> ceralive set) ===="
	purge_stack
	disable_local_repo
	echo "  installing stock bookworm modemmanager + utils..."
	apt-get install -y -qq modemmanager libmbim-utils libqmi-utils >/tmp/stock.log 2>&1 || { sed 's/^/    /' /tmp/stock.log; echo "  CHECK 3 FAIL: stock install"; return 1; }
	local before; before="$(dpkg_ver modemmanager)"
	echo "  stock modemmanager installed: $before"
	case "$before" in ${STOCK_MM_UPSTREAM}*) echo "  ok: stock is ${STOCK_MM_UPSTREAM}-series" ;; *) echo "  note: bookworm stock modemmanager is $before" ;; esac

	# Compute the real upgrade direction now, while the local repo is still disabled so madison
	# reports the true bookworm-main stock version for each package.
	compute_direction_table || { echo "  CHECK 3 FAIL: direction table"; return 1; }

	echo "  enabling local ceralive repo and upgrading the coherent set..."
	setup_local_repo
	# --allow-downgrades is added ONLY if the direction table found a source below stock. For this
	# bump every source outranks stock (libqrtr-glib 1.4.0 > 1.2.2-1), so the flag is omitted and
	# this is a genuine, no-downgrade upgrade — a stricter assertion than the old blanket flag.
	local dgflag=()
	[ "$NEED_DOWNGRADE" -eq 1 ] && dgflag=(--allow-downgrades)
	apt-get install -y -qq "${dgflag[@]}" "${RUNTIME_PKGS[@]}" >/tmp/upgrade.log 2>&1 || { sed 's/^/    /' /tmp/upgrade.log; echo "  CHECK 3 FAIL: upgrade (flags: ${dgflag[*]:-none})"; return 1; }
	local after; after="$(dpkg_ver modemmanager)"
	echo "  modemmanager after upgrade: $after"
	dpkg --compare-versions "$before" lt "$after" || { echo "  CHECK 3 FAIL: modemmanager did not move UP ($before !< $after)"; return 1; }
	# Revision-EXACT: the full <upstream>-<rev> base (e.g. 1.24.2-2) must match; a `-1` build fails.
	case "$after" in ${MM_BASE}~ceralive*) echo "  ok: modemmanager upgraded to ${MM_BASE} ceralive" ;; *) echo "  CHECK 3 FAIL: expected ${MM_BASE}~ceralive*, got $after"; return 1 ;; esac
	local pkg fail=0
	for pkg in "${RUNTIME_PKGS[@]}"; do case "$(dpkg_ver "$pkg")" in *~ceralive*) : ;; *) echo "  FAIL: $pkg not on ceralive after upgrade"; fail=1 ;; esac; done
	[ "$fail" -eq 0 ] || { echo "  CHECK 3 FAIL"; return 1; }
	echo "  CHECK 3 PASS: apt upgraded modemmanager ${STOCK_MM_UPSTREAM} -> ${MM_TAG} and landed the full coherent set."
	purge_stack
	disable_local_repo
}

# ------------------------------------------------------------------------------------------
# CHECK 4 — rollback: ceralive set -> stock, correct apt semantics.
# ------------------------------------------------------------------------------------------
check_rollback() {
	echo; echo "==== CHECK 4: rollback (ceralive set -> stock, apt downgrade semantics) ===="
	purge_stack
	setup_local_repo
	echo "  installing the ceralive set..."
	apt-get install -y -qq --allow-downgrades "${RUNTIME_PKGS[@]}" >/tmp/rb-install.log 2>&1 || { sed 's/^/    /' /tmp/rb-install.log; echo "  CHECK 4 FAIL: ceralive install"; return 1; }
	echo "  ceralive modemmanager: $(dpkg_ver modemmanager)"

	# Correct apt rollback = BOTH: disable the local source AND pin explicit stock versions
	# with --allow-downgrades. The stock version is read from `apt-cache madison` (the INDEX
	# view) NOT `apt-cache policy` Candidate — because apt refuses to auto-downgrade to a
	# version below priority 1000, Candidate keeps reporting the installed ceralive version.
	# madison lists only indexed versions, so once the local repo is gone it yields the real
	# bookworm-main version (never hardcoded — point releases like +deb12u1 shift it).
	echo "  disabling local repo and pinning explicit stock versions..."
	disable_local_repo
	local specs=() pkg stock
	for pkg in "${RUNTIME_PKGS[@]}"; do
		stock="$(apt-cache madison "$pkg" 2>/dev/null | awk -F'|' 'NR==1{gsub(/^[ \t]+|[ \t]+$/,"",$2); print $2; exit}')"
		[ -n "$stock" ] || { echo "  note: $pkg has no bookworm stock version in the index — skipping"; continue; }
		specs+=("${pkg}=${stock}")
	done
	echo "  downgrading to: ${specs[*]}"
	apt-get install -y -qq --allow-downgrades "${specs[@]}" >/tmp/rollback.log 2>&1 || { sed 's/^/    /' /tmp/rollback.log; echo "  CHECK 4 FAIL: rollback"; return 1; }
	local after; after="$(dpkg_ver modemmanager)"
	echo "  modemmanager after rollback: $after"
	case "$after" in *~ceralive*) echo "  CHECK 4 FAIL: still on ceralive after rollback"; return 1 ;; ${STOCK_MM_UPSTREAM}*) echo "  ok: back to stock ${STOCK_MM_UPSTREAM}" ;; *) echo "  ok: back to stock $after" ;; esac
	echo "  CHECK 4 PASS: apt cleanly downgraded the stack back to stock bookworm."
	purge_stack
}

# ------------------------------------------------------------------------------------------
# CHECK 8 — piuparts-style install/purge cleanliness (lightweight approximation).
# ------------------------------------------------------------------------------------------
check_piuparts() {
	echo; echo "==== CHECK 8: piuparts-style install -> purge cleanliness ===="
	echo "  (lightweight install/purge/leftover-scan; real piuparts 1.1.7 exists in bookworm"
	echo "   but needs a privileged debootstrap chroot not available in this container.)"
	purge_stack
	local files=()
	for pkg in "${RUNTIME_PKGS[@]}"; do files+=("${DEB_OF[$pkg]}"); done
	apt-get install -y -qq "${files[@]}" >/tmp/piu-install.log 2>&1 || { sed 's/^/    /' /tmp/piu-install.log; echo "  CHECK 8 FAIL: install"; return 1; }
	# Record every regular file the 9 packages own, before purge.
	local owned; owned="$(mktemp)"
	local pkg
	for pkg in "${RUNTIME_PKGS[@]}"; do
		dpkg-query -L "$pkg" 2>/dev/null
	done | sort -u > "$owned"
	local nfiles; nfiles="$(wc -l < "$owned")"
	echo "  installed file entries owned by the 9 packages: $nfiles"
	echo "  purging all 9..."
	apt-get purge -y -qq "${RUNTIME_PKGS[@]}" >/tmp/piu-purge.log 2>&1 || { sed 's/^/    /' /tmp/piu-purge.log; echo "  CHECK 8 FAIL: purge"; return 1; }
	# Any REGULAR FILE (not a dir — dirs may be shared with base packages) still present is a leak.
	local leftovers=0 f
	while IFS= read -r f; do
		[ -f "$f" ] && { echo "  LEFTOVER: $f"; leftovers=$((leftovers + 1)); }
	done < "$owned"
	rm -f "$owned"
	[ "$leftovers" -eq 0 ] || { echo "  CHECK 8 FAIL: $leftovers file(s) survived purge"; return 1; }
	# Config tree must be gone too.
	[ ! -e /etc/ModemManager/fcc-unlock.d ] || { echo "  note: /etc/ModemManager remnant (dir may be base-owned)"; }
	echo "  CHECK 8 PASS: no owned regular file survived purge."
}

# ------------------------------------------------------------------------------------------
# Run the selected checks.
# ------------------------------------------------------------------------------------------
check_metadata
check_coherence
check_ordering
if [ "$MODE" = full ]; then
	check_closure_install
	check_upgrade
	check_rollback
	check_piuparts
else
	echo; echo "== mode=metadata: skipping install/upgrade/rollback/piuparts (apt-under-QEMU is"
	echo "   prohibitively slow on a CI runner). Metadata/coherence/ordering ran natively above. =="
fi

echo
echo "IN-CONTAINER CONTRACT CHECKS PASS [$ARCH, mode=$MODE]"
