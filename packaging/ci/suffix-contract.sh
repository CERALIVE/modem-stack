#!/usr/bin/env bash
# suffix-contract.sh — SOURCED library: the `~ceralive` version-suffix contract.
#
# Releases are DIFFERENTIAL, so there is no longer one suffix across the whole set: each
# upstream source carries its own rebuild counter `<upstream>-<rev>~ceralive.N`, and a source
# that was not rebuilt keeps the counter it already had. Coherence is therefore a PER-SOURCE
# property — every deb of ONE source shares one suffix, while two sources legitimately differ.
# The companion `ceralive-modem-support` is outside this contract entirely (bare SemVer).
#
# It lives here rather than inside test-package-contract.sh because that suite only runs
# inside a docker container against a built .deb set, and both halves of the contract — the
# per-source grouping AND the migration-continuity ordering — must also be provable on a bare
# host. A second copy in the host test would only ever test itself; one sourced library means
# the container suite and the host suite exercise the same code.
#
# USAGE   . "$(dirname "$0")/suffix-contract.sh"
# ENV     EXPECTED_PACKAGES — override the package→source map (default: alongside this file).

SUFFIX_CONTRACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUFFIX_CONTRACT_EXPECTED="${EXPECTED_PACKAGES:-$SUFFIX_CONTRACT_DIR/expected-packages.txt}"

# ---- package -> owning source ------------------------------------------------------------
# Derived from expected-packages.txt's `[<source> all-artifact]` blocks, never a second frozen
# list: the grouping a coherence check needs is exactly the ownership the manifest generator
# and check-package-sets.sh already read from that file, and two copies would drift.
suffix_source_of() { # <package> -> its owning source, or non-zero
	local pkg="$1" src
	src="$(awk -v want="$pkg" '
		/^\[/ { h=$0; sub(/[ \t]*#.*$/, "", h)
			insec = (h ~ /^\[[^]]+ all-artifact\]$/) ? 1 : 0
			if (insec) { split(h, a, /[][ ]+/); src=a[2] }
			next }
		insec { l=$0; sub(/#.*$/, "", l); gsub(/[ \t]+/, "", l)
			if (l == want) { print src; exit } }
	' "$SUFFIX_CONTRACT_EXPECTED")"
	[ -n "$src" ] || { echo "suffix-contract: package '$pkg' belongs to no [<source> all-artifact] set" >&2; return 1; }
	printf '%s\n' "$src"
}

# ---- coherence ----------------------------------------------------------------------------
# assert_coherent <version...> — prints the shared ~ceralive suffix; non-zero iff the versions
# do not all share one. UNCHANGED core logic: "does this set of versions share one suffix" is
# the same question per-source as it used to be globally; only the grouping of the inputs moved.
assert_coherent() {
	local v suf first=""
	for v in "$@"; do
		suf="~ceralive${v##*~ceralive}"
		[ "$suf" != "~ceralive$v" ] || { echo "    no ~ceralive suffix in '$v'"; return 1; }
		if [ -z "$first" ]; then first="$suf"
		elif [ "$suf" != "$first" ]; then
			echo "    incoherent: '$suf' != '$first'"; return 1
		fi
	done
	echo "$first"
}

# assert_source_coherent <source> <version...> — the per-source wrapper. On failure it NAMES
# the source on stderr, because "something is incoherent" is unactionable in a differential
# release where a cross-source difference is normal and only an intra-source one is a bug.
assert_source_coherent() {
	local source_name="$1"; shift
	local detail
	if ! detail="$(assert_coherent "$@")"; then
		echo "suffix-contract: INCOHERENT source '$source_name' — ${detail#    } (versions: $*)" >&2
		return 1
	fi
	printf '%s\n' "$detail"
}

# assert_group_coherence <package>=<version>... — the whole per-source rule in one call: group
# the given packages by owning source, then assert each group's OWN internal coherence. Prints
# `<source> <count> <suffix>` per source (sorted); non-zero iff some source is internally
# incoherent, with that source named on stderr. Cross-source differences are accepted by
# construction — they are what a differential release produces.
assert_group_coherence() {
	local spec pkg ver src suffix fail=0 vers=()
	declare -A COHERENCE_GROUP=()
	for spec in "$@"; do
		pkg="${spec%%=*}"; ver="${spec#*=}"
		src="$(suffix_source_of "$pkg")" || return 1
		COHERENCE_GROUP["$src"]+="$ver "
	done
	while IFS= read -r src; do
		read -r -a vers <<<"${COHERENCE_GROUP[$src]}"
		if suffix="$(assert_source_coherent "$src" "${vers[@]}")"; then
			printf '%s %d %s\n' "$src" "${#vers[@]}" "$suffix"
		else
			fail=1
		fi
	done < <(printf '%s\n' "${!COHERENCE_GROUP[@]}" | LC_ALL=C sort)
	return "$fail"
}

# ---- migration continuity -----------------------------------------------------------------
# Every legacy suffix below EXISTS as a published artifact today (v0.2.0's closure and v1.0.0's
# repair are live on apt; v1.1.0 released 2026-08-21), so this chain is the proof that every
# fleet device upgrades cleanly into the per-source counter scheme — and that counters keep
# ordering among themselves once there. It is ONE definition so the container suite and the
# host suite cannot prove different chains.
migration_continuity_chain() { # <base> -> the ordered chain, one version per line
	local base="$1"
	printf '%s\n' \
		"${base}~ceralive0.2.0" \
		"${base}~ceralive1.0.0" \
		"${base}~ceralive1.1.0" \
		"${base}~ceralive.1" \
		"${base}~ceralive.2" \
		"${base}~ceralive.10" \
		"${base}"
}

# prove_chain_ordered <base> — REAL `dpkg --compare-versions` over every consecutive pair.
# Never a string compare: a lexical sort puts `~ceralive.10` BELOW `~ceralive.2`, which is the
# exact inversion this proof exists to rule out.
prove_chain_ordered() {
	local base="$1" prev="" v fail=0
	command -v dpkg >/dev/null 2>&1 || { echo "suffix-contract: dpkg not found — cannot prove ordering" >&2; return 2; }
	while IFS= read -r v; do
		if [ -n "$prev" ]; then
			if dpkg --compare-versions "$prev" lt "$v"; then
				echo "  ok: '$prev' lt '$v'"
			else
				echo "  FAIL: '$prev' NOT lt '$v'"; fail=1
			fi
		fi
		prev="$v"
	done < <(migration_continuity_chain "$base")
	return "$fail"
}
