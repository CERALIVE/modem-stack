#!/usr/bin/env bash
# test-suffix-coherence-manifest.sh — per-source suffix coherence + mixed-version manifests.
#
# HOST-RUNNABLE, OFFLINE, NO DOCKER. It drives production code only: the coherence rules come
# from ci/suffix-contract.sh (the same library test-package-contract.sh's CHECK 5/6 source), the
# ordering proofs are REAL `dpkg --compare-versions` invocations, and the manifests are produced
# by the real ci/generate-release-manifest.sh over a staged fixture tree. The generator is
# dpkg-free by design — it parses filenames and sha256sums files — so placeholder .deb-named
# files exercise its real parse, set-equality and row-emission paths.
#
# Package sets and version bases are DERIVED, never transcribed: sets come from
# ci/expected-packages.txt and bases from ci/read-pin.sh, and every expected row count is
# counted from the fixture that produced it.
#
# EXIT  0 all cases pass. 1 a contract breach. 2 environment (missing dpkg / unreadable input).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GENERATOR="$HERE/generate-release-manifest.sh"
EXPECTED="$HERE/expected-packages.txt"

for required in "$GENERATOR" "$EXPECTED" "$HERE/suffix-contract.sh" "$HERE/read-pin.sh"; do
	[ -r "$required" ] || { echo "missing: $required" >&2; exit 2; }
done
command -v dpkg >/dev/null 2>&1 || { echo "test-suffix-coherence-manifest: dpkg not found — the ordering chain cannot be PROVEN, only assumed" >&2; exit 2; }

# shellcheck source=suffix-contract.sh
. "$HERE/suffix-contract.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ceralive-suffix-coherence.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
ERR="$ROOT/stderr.txt"
OUT="$ROOT/stdout.txt"

UPSTREAM_SOURCES=(libqrtr-glib libmbim libqmi modemmanager)
COMPANION_SOURCE=ceralive-modem-support

declare -A BASE_CACHE=()
base_version() { # <source> -> the pinned <upstream>-<rev>, read from the real pins/changelogs
	local source_name="$1"
	if [ -z "${BASE_CACHE[$source_name]:-}" ]; then
		BASE_CACHE["$source_name"]="$(bash "$HERE/read-pin.sh" "$source_name" --base-version)" || return 1
	fi
	printf '%s\n' "${BASE_CACHE[$source_name]}"
}

expected_set() { # <source> -> its [<source> all-artifact] package list
	awk -v want="[$1 all-artifact]" '
		/^\[/ { h=$0; sub(/[ \t]*#.*$/, "", h); insec=(h==want)?1:0; next }
		insec { l=$0; sub(/#.*$/, "", l); gsub(/[ \t]+/, "", l); if (l!="") print l }
	' "$EXPECTED" | LC_ALL=C sort -u
}

write_upstream_arch() { # <build-root> <arch> <source> <suffix>
	local root="$1" arch="$2" source_name="$3" suffix="$4" package version
	version="$(base_version "$source_name")${suffix}"
	mkdir -p "$root/$arch"
	while IFS= read -r package; do
		[ -n "$package" ] || continue
		printf 'fixture deb: %s %s %s\n' "$package" "$version" "$arch" >"$root/$arch/${package}_${version}_${arch}.deb"
	done < <(expected_set "$source_name")
}

build_staged_tree() { # <build-root> <companion-version> <libqmi-suffix> <other-suffix>
	local root="$1" companion="$2" qmi_suffix="$3" other_suffix="$4" arch source_name suffix
	for arch in amd64 arm64; do
		for source_name in "${UPSTREAM_SOURCES[@]}"; do
			suffix="$other_suffix"
			[ "$source_name" = libqmi ] && suffix="$qmi_suffix"
			write_upstream_arch "$root" "$arch" "$source_name" "$suffix"
		done
	done
	mkdir -p "$root/all"
	printf 'fixture deb: %s %s all\n' "$COMPANION_SOURCE" "$companion" \
		>"$root/all/${COMPANION_SOURCE}_${companion}_all.deb"
}

staged_deb_count() { find "$1" -type f -name '*.deb' | wc -l | tr -d ' '; }
manifest_rows()    { awk '$1=="amd64" || $1=="arm64" || $1=="all"' "$1"; }

# Every expected count is COUNTED from the fixture that produced the manifest; no total is ever
# written down here, so a change to expected-packages.txt cannot make this test lie.
assert_row_count() { # <manifest> <build-root> <label>
	local manifest="$1" root="$2" label="$3" staged rows trailer
	staged="$(staged_deb_count "$root")"
	rows="$(manifest_rows "$manifest" | wc -l | tr -d ' ')"
	trailer="$(awk '/^# all_debs_total:/ {print $3; exit}' "$manifest")"
	if [ "$staged" -gt 0 ] && [ "$rows" = "$staged" ] && [ "$trailer" = "$staged" ]; then
		ok "$label — $rows rows == $staged staged debs == the generator's own total"
	else
		bad "$label — rows=$rows trailer=${trailer:-<none>} staged=$staged"
	fi
}

assert_header() { # <manifest> <label>
	local manifest="$1" label="$2"
	if grep -qx 'suffix_scheme: per-source-counter' "$manifest"; then
		ok "$label — header declares suffix_scheme: per-source-counter"
	else
		bad "$label — suffix_scheme header absent"
	fi
	if grep -q '^deb_version_suffix:' "$manifest"; then
		bad "$label — the global deb_version_suffix header survived"
	else
		ok "$label — no global deb_version_suffix header (no single suffix is truthful)"
	fi
}

assert_row_versions() { # <manifest> <companion-version> <libqmi-suffix> <other-suffix> <label>
	local manifest="$1" companion="$2" qmi_suffix="$3" other_suffix="$4" label="$5"
	local arch pkg src ver role fn sha expected bad_rows=0
	while read -r arch pkg src ver role fn sha; do
		case "$src" in
			"$COMPANION_SOURCE") expected="$companion" ;;
			libqmi)              expected="$(base_version libqmi)${qmi_suffix}" ;;
			*)                   expected="$(base_version "$src")${other_suffix}" ;;
		esac
		if [ "$ver" != "$expected" ]; then
			echo "       $pkg/$arch version '$ver' != expected '$expected'"
			bad_rows=$((bad_rows + 1))
		fi
		if [ "$fn" != "${pkg}_${ver}_${arch}.deb" ]; then
			echo "       $pkg/$arch filename '$fn' disagrees with its version column"
			bad_rows=$((bad_rows + 1))
		fi
		if [ -z "$role" ] || [ -z "$sha" ]; then
			echo "       $pkg/$arch has an empty role/sha column"
			bad_rows=$((bad_rows + 1))
		fi
	done < <(manifest_rows "$manifest")
	if [ "$bad_rows" -eq 0 ]; then ok "$label"; else bad "$label — $bad_rows bad row(s)"; fi
}

runtime_specs() { # <manifest> <arch> -> `<package>=<version>` for that arch's runtime rows
	awk -v want="$1" '$1==want && $5=="runtime" { printf "%s=%s\n", $2, $4 }' "$2"
}

# ================================================================================================
echo "== (a)/(b) per-source coherence: sources may differ, a source may not differ from itself =="
# ================================================================================================
MM_BASE="$(base_version modemmanager)"
QMI_BASE="$(base_version libqmi)"
MBIM_BASE="$(base_version libmbim)"
QRTR_BASE="$(base_version libqrtr-glib)"
if [ -n "$MM_BASE" ] && [ -n "$QMI_BASE" ] && [ -n "$MBIM_BASE" ] && [ -n "$QRTR_BASE" ]; then
	ok "pin-derived bases resolved (mm=$MM_BASE mbim=$MBIM_BASE qmi=$QMI_BASE qrtr=$QRTR_BASE)"
else
	bad "read-pin.sh did not resolve every source's base version"
fi

MIXED_SPECS=(
	"modemmanager=${MM_BASE}~ceralive.1"   "libmm-glib0=${MM_BASE}~ceralive.1"
	"libmbim-glib4=${MBIM_BASE}~ceralive.1" "libmbim-proxy=${MBIM_BASE}~ceralive.1"
	"libmbim-utils=${MBIM_BASE}~ceralive.1"
	"libqmi-glib5=${QMI_BASE}~ceralive.2"  "libqmi-proxy=${QMI_BASE}~ceralive.2"
	"libqmi-utils=${QMI_BASE}~ceralive.2"
	"libqrtr-glib0=${QRTR_BASE}~ceralive.1"
)
table="$(assert_group_coherence "${MIXED_SPECS[@]}" 2>"$ERR")"; rc=$?
if [ "$rc" -eq 0 ]; then
	ok "three sources at .1 beside libqmi at .2 — accepted (differing counters are legal)"
else
	bad "a legal differential set was rejected: $(tr '\n' ' ' <"$ERR")"
fi
if [ "$(printf '%s\n' "$table" | wc -l)" -eq "${#UPSTREAM_SOURCES[@]}" ]; then
	ok "coherence reports one verdict per upstream source"
else
	bad "coherence verdict count != source count: $(tr '\n' ' ' <<<"$table")"
fi
if grep -q '^libqmi 3 ~ceralive\.2$' <<<"$table" && grep -q '^modemmanager 2 ~ceralive\.1$' <<<"$table"; then
	ok "each source's own suffix is reported (libqmi .2, modemmanager .1)"
else
	bad "per-source suffix table is wrong: $(tr '\n' ' ' <<<"$table")"
fi

# The breach that remains: ONE source disagreeing with itself. Two libqmi debs at different
# counters can only mean one of them shipped at the wrong version.
INTERNALLY_MIXED=()
for spec in "${MIXED_SPECS[@]}"; do
	case "$spec" in
		libqmi-proxy=*) INTERNALLY_MIXED+=("libqmi-proxy=${QMI_BASE}~ceralive.3") ;;
		*)              INTERNALLY_MIXED+=("$spec") ;;
	esac
done
assert_group_coherence "${INTERNALLY_MIXED[@]}" >"$OUT" 2>"$ERR"; rc=$?
if [ "$rc" -ne 0 ]; then ok "an internally-mixed libqmi set fails closed"; else bad "an internally-mixed libqmi set was accepted"; fi
if grep -q "libqmi" "$ERR"; then ok "the failure NAMES the offending source"; else bad "the failure does not name libqmi: $(tr '\n' ' ' <"$ERR")"; fi
if grep -qE "modemmanager|libmbim|libqrtr-glib" "$ERR"; then
	bad "the failure blamed a source that was internally coherent: $(tr '\n' ' ' <"$ERR")"
else
	ok "no coherent source is blamed for the mixture"
fi

assert_group_coherence "libqmi-glib5=${QMI_BASE}" >/dev/null 2>"$ERR"; rc=$?
if [ "$rc" -ne 0 ]; then ok "a version with no ~ceralive suffix fails closed"; else bad "a suffix-less version was accepted"; fi

suffix_source_of "not-a-real-package" >/dev/null 2>"$ERR"; rc=$?
if [ "$rc" -ne 0 ]; then ok "a package owned by no source fails closed"; else bad "an unowned package resolved to a source"; fi

# ================================================================================================
echo
echo "== (c) migration continuity: REAL dpkg --compare-versions over the whole chain =="
# ================================================================================================
CHAIN_LOG="$ROOT/chain.txt"
prove_chain_ordered "$MM_BASE" >"$CHAIN_LOG" 2>&1; rc=$?
sed 's/^/    /' "$CHAIN_LOG"
if [ "$rc" -eq 0 ]; then ok "the migration-continuity chain holds under real dpkg"; else bad "the chain does not hold"; fi

chain_members="$(migration_continuity_chain "$MM_BASE")"
missing_member=0
for member in '~ceralive0.2.0' '~ceralive1.0.0' '~ceralive1.1.0' '~ceralive.1' '~ceralive.2' '~ceralive.10' ''; do
	grep -qxF -- "${MM_BASE}${member}" <<<"$chain_members" || { echo "       chain omits '${MM_BASE}${member}'"; missing_member=1; }
done
if [ "$missing_member" -eq 0 ]; then
	ok "the chain spans every published legacy version (0.2.0, 1.0.0, 1.1.0) through .1/.2/.10 to stock"
else
	bad "the chain dropped a required member"
fi
members="$(printf '%s\n' "$chain_members" | wc -l)"
proved="$(grep -c '^  ok: ' "$CHAIN_LOG")"
if [ "$proved" -eq $((members - 1)) ]; then
	ok "every consecutive pair was compared ($proved comparisons over $members members)"
else
	bad "a chain member was never compared ($proved comparisons over $members members)"
fi

# Non-vacuity: a lexical compare orders `.10` BELOW `.2`, so a string-sorted "proof" would have
# passed a chain dpkg calls inverted. This is what makes the chain above a real proof.
if [[ "${MM_BASE}~ceralive.10" < "${MM_BASE}~ceralive.2" ]] && dpkg --compare-versions "${MM_BASE}~ceralive.2" lt "${MM_BASE}~ceralive.10"; then
	ok "dpkg disagrees with a lexical compare on .2 vs .10 — the chain is not a string tautology"
else
	bad "the two-digit counter case did not distinguish dpkg from a lexical compare"
fi

# ================================================================================================
echo
echo "== (d) manifest generation over a MIXED staged set (libqmi rebuilt, the rest carried) =="
# ================================================================================================
MIXED_ROOT="$ROOT/build-mixed"
MIXED_MANIFEST="$ROOT/manifest-mixed.txt"
build_staged_tree "$MIXED_ROOT" "1.2.0" '~ceralive.2' '~ceralive.1'
bash "$GENERATOR" v1.2.0 "$MIXED_ROOT" "$MIXED_MANIFEST" >"$OUT" 2>"$ERR"; rc=$?
if [ "$rc" -eq 0 ]; then ok "the generator accepts a mixed-version staged set"; else bad "generator exit $rc: $(tail -3 "$ERR" | tr '\n' ' ')"; fi
assert_header "$MIXED_MANIFEST" "mixed set"
assert_row_count "$MIXED_MANIFEST" "$MIXED_ROOT" "mixed set"
assert_row_versions "$MIXED_MANIFEST" "1.2.0" '~ceralive.2' '~ceralive.1' "mixed set — every row carries its own source's version"
if grep -qx 'closure_version: 2' "$MIXED_MANIFEST"; then ok "mixed set — closure_version is unchanged at 2"; else bad "mixed set — closure_version drifted"; fi
if [ "$(awk '$1=="all" {n++} END {print n+0}' "$MIXED_MANIFEST")" -eq 1 ]; then
	ok "mixed set — the companion is ONE build_arch=all row"
else
	bad "mixed set — the companion is not a single arch-all row"
fi

# The manifest a differential release produces must itself satisfy the per-source coherence rule
# — this is the join between the generator and CHECK 5, over generated rather than fixed rows.
for arch in amd64 arm64; do
	mapfile -t specs < <(runtime_specs "$arch" "$MIXED_MANIFEST")
	assert_group_coherence "${specs[@]}" >/dev/null 2>"$ERR"; rc=$?
	if [ "$rc" -eq 0 ] && [ "${#specs[@]}" -gt 0 ]; then
		ok "mixed set — the generated $arch runtime rows are per-source coherent (${#specs[@]} rows)"
	else
		bad "mixed set — generated $arch runtime rows failed coherence: $(tr '\n' ' ' <"$ERR")"
	fi
done

# ================================================================================================
echo
echo "== (e) ZERO-UPSTREAM-BUILD: only the companion is new, all four sources keep their counter =="
# ================================================================================================
ZERO_ROOT="$ROOT/build-zero"
ZERO_MANIFEST="$ROOT/manifest-zero.txt"
build_staged_tree "$ZERO_ROOT" "1.3.0" '~ceralive.2' '~ceralive.2'
bash "$GENERATOR" v1.3.0 "$ZERO_ROOT" "$ZERO_MANIFEST" >"$OUT" 2>"$ERR"; rc=$?
if [ "$rc" -eq 0 ]; then ok "the generator accepts a carried-only upstream set"; else bad "generator exit $rc: $(tail -3 "$ERR" | tr '\n' ' ')"; fi
assert_header "$ZERO_MANIFEST" "zero-build set"
assert_row_count "$ZERO_MANIFEST" "$ZERO_ROOT" "zero-build set"
assert_row_versions "$ZERO_MANIFEST" "1.3.0" '~ceralive.2' '~ceralive.2' "zero-build set — every upstream row keeps its previous counter"

stale_tag_rows="$(manifest_rows "$ZERO_MANIFEST" | awk -v c="$COMPANION_SOURCE" '$3!=c && $4 ~ /~ceralive1\.3\.0$/ {print $2}')"
if [ -z "$stale_tag_rows" ]; then
	ok "zero-build set — no upstream row was restamped with the release tag"
else
	bad "zero-build set — upstream rows advertise the tag: $(tr '\n' ' ' <<<"$stale_tag_rows")"
fi
companion_ver="$(manifest_rows "$ZERO_MANIFEST" | awk -v c="$COMPANION_SOURCE" '$3==c {print $4; exit}')"
if [ "$companion_ver" = "1.3.0" ]; then
	ok "zero-build set — the companion alone carries the new bare tag version (1.3.0)"
else
	bad "zero-build set — companion version is '$companion_ver', expected the bare tag version"
fi
carried_rows="$(manifest_rows "$ZERO_MANIFEST" | awk -v c="$COMPANION_SOURCE" '$3!=c && $4 ~ /~ceralive\.2$/ {n++} END {print n+0}')"
upstream_rows="$(manifest_rows "$ZERO_MANIFEST" | awk -v c="$COMPANION_SOURCE" '$3!=c {n++} END {print n+0}')"
if [ "$upstream_rows" -gt 0 ] && [ "$carried_rows" -eq "$upstream_rows" ]; then
	ok "zero-build set — all $upstream_rows upstream rows (runtime and aux, both arches) are at ~ceralive.2"
else
	bad "zero-build set — $carried_rows of $upstream_rows upstream rows are at the carried counter"
fi

echo
echo "passed: $pass   failed: $fail"
if [ "$fail" -eq 0 ]; then
	echo "PASS: per-source coherence, migration continuity, and mixed-version manifest generation hold"
	exit 0
fi
echo "FAIL: per-source suffix / mixed-version manifest contract violated"
exit 1
