#!/usr/bin/env bash
# check-upstream-freshness.sh — is any pinned ModemManager-stack source behind a newer STABLE
# release?
#
# ISSUE-ONLY BY CONTRACT. This script reports. It never writes packaging/upstream-pins.yaml, it
# never invokes dch/inject-deb-version.sh, and it never dispatches a build. Bumping a pin is a
# separate, human-reviewed change that must re-run packaging/ci/verify-upstream-pins.sh (the
# four-link provenance chain). Nothing here is a substitute for that.
#
# WHAT IT COMPARES
#   For each source in upstream-pins.yaml it enumerates two remotes with `git ls-remote --tags`:
#     upstream — the freedesktop release tags (`1.24.2`)
#     salsa    — the Debian packaging tags (`debian/1.24.2-2`)
#   and compares the newest STABLE member of each against the pinned `upstream_tag` / `salsa_tag`.
#
# THE STABLE FILTER IS THE WHOLE POINT — the four sources ship a DEVELOPMENT series on the same
# tag namespace as their releases, so a naive "newest tag wins" is wrong roughly half the time.
# ModemManager `1.25.95` is the live example: it is the unstable train toward 1.26.0, was
# uploaded to Debian EXPERIMENTAL, and must never produce a "behind" verdict. Four explicit
# rejection rules, each with a named reason (see `stable_reason`):
#   prerelease-suffix            -rc / -dev / -alpha / -beta / -pre  (`1.26.0-rc1`)
#   not-a-plain-triple           anything but strict X.Y.Z with no prefix or suffix (`v1.26.0`)
#   odd-minor-development-series odd MINOR — the GNOME/freedesktop convention every one of these
#                                four projects follows: even minor = release, odd = development
#                                (`1.25.95`, `1.37.1`). All four current pins are even-minor.
#   snapshot-micro-series        MICRO >= 90 — the pre-release snapshot train (`1.24.90`)
# `1.25.95` is caught independently by BOTH the odd-minor and the snapshot-micro rule, so the
# trap stays closed if either is ever relaxed.
#
# A Debian packaging tag is stable when its upstream part passes the SAME filter and its revision
# is a plain Debian revision (no `~`, which is how experimental/backports uploads spell
# themselves: `1.24.2-1~exp1`, `1~bpo12+1`).
#
# THREE VERDICTS, and the third is deliberately NOT the second:
#   current                       nothing newer is both released upstream AND packaged in Debian.
#   behind (<v>)                  a newer stable upstream release EXISTS AND has a stable Debian
#                                 packaging tag — a bump is actionable. Also raised for a
#                                 packaging-only bump (same upstream, newer `debian/` revision),
#                                 because the rebuild consumes that revision too.
#   upstream-ahead-no-packaging   upstream released, Debian has not packaged it yet. This is NOT
#                                 `behind`: these rebuilds are `<upstream>-<rev>` pairs, so with
#                                 no packaging tag there is no revision to pin and no bump to
#                                 recommend. Reporting it as `behind` would file an issue nobody
#                                 can act on.
#
# OFFLINE SEAM (how the test suite runs with no network)
#   UPSTREAM_FRESHNESS_FIXTURE_DIR=<dir> (or --fixture-dir <dir>) replaces every `git ls-remote`
#   with a read of `<dir>/<source>.<upstream|salsa>.tags`. The fixture holds verbatim
#   `git ls-remote --tags --refs` output (`<sha>\trefs/tags/<tag>`), so the parse under test is
#   the same parse the network path uses — only the transport is stubbed. A missing fixture file
#   FAILS CLOSED rather than silently reaching the network.
#
# Usage:
#   check-upstream-freshness.sh [--dry-run] [--issue-body PATH] [--fixture-dir DIR] [--source NAME]
#     --dry-run           also print the would-be GitHub issue body to stdout. Makes NO GitHub
#                         API call — this script never makes one in any mode.
#     --issue-body PATH   write the issue body to PATH when at least one source is behind
#                         (the workflow feeds it to `gh issue create/edit --body-file`).
#                         Nothing is written when no source is behind.
#     --fixture-dir DIR   the offline seam above.
#     --source NAME       check only this source (default: every source in the manifest).
#
# Exit status:
#   0   no bump is recommended (every source `current` and/or `upstream-ahead-no-packaging`).
#   10  at least one source is `behind` — the workflow opens/updates its issue on this code.
#   1   a check could not be completed (unreachable remote, missing fixture, unreadable pin).
#   2   usage error.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
READ_PIN="$HERE/read-pin.sh"

DRY_RUN=0
ISSUE_BODY_PATH=""
FIXTURE_DIR="${UPSTREAM_FRESHNESS_FIXTURE_DIR:-}"
ONLY_SOURCE=""

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run)     DRY_RUN=1; shift ;;
		--issue-body)  ISSUE_BODY_PATH="${2-}"; shift 2 ;;
		--fixture-dir) FIXTURE_DIR="${2-}"; shift 2 ;;
		--source)      ONLY_SOURCE="${2-}"; shift 2 ;;
		-h|--help)     sed -n '2,60p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*)             echo "check-upstream-freshness: unknown argument '$1'" >&2; exit 2 ;;
	esac
done

[ -x "$READ_PIN" ] || [ -r "$READ_PIN" ] || {
	echo "check-upstream-freshness: shared pin reader not found at $READ_PIN" >&2; exit 2
}
for tool in awk sort git; do
	command -v "$tool" >/dev/null 2>&1 \
		|| { echo "check-upstream-freshness: missing required tool '$tool'" >&2; exit 2; }
done

die()  { echo "check-upstream-freshness: $*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }

# Every pin VALUE comes from the shared reader — this file parses no YAML of its own.
pin() { bash "$READ_PIN" "$@"; }

# ---- the stable filter ----------------------------------------------------------------------
# Prints `stable`, or the NAMED reason the version was rejected. Total: every input gets a word.
stable_reason() {
	local v="$1" minor micro
	case "${v,,}" in
		*-rc*|*-dev*|*-alpha*|*-beta*|*-pre*) echo prerelease-suffix; return 0 ;;
	esac
	[[ "$v" =~ ^[0-9]+\.([0-9]+)\.([0-9]+)$ ]] || { echo not-a-plain-triple; return 0; }
	minor="${BASH_REMATCH[1]}"
	micro="${BASH_REMATCH[2]}"
	if [ $(( 10#$minor % 2 )) -ne 0 ]; then echo odd-minor-development-series; return 0; fi
	if [ $(( 10#$micro )) -ge 90 ];   then echo snapshot-micro-series;        return 0; fi
	echo stable
}
is_stable() { [ "$(stable_reason "$1")" = stable ]; }

# `a` strictly newer than `b`, by version sort (handles `1.24.2-10` > `1.24.2-2`).
ver_gt() {
	[ "$1" != "$2" ] || return 1
	[ "$(printf '%s\n%s\n' "$1" "$2" | LC_ALL=C sort -V | tail -n1)" = "$1" ]
}
newest() { LC_ALL=C sort -V | tail -n1; }

# ---- tag enumeration (network, or the offline fixture seam) ----------------------------------
ls_remote_tags() {
	local src="$1" kind="$2" url="$3" raw
	if [ -n "$FIXTURE_DIR" ]; then
		local fixture="$FIXTURE_DIR/$src.$kind.tags"
		[ -r "$fixture" ] || die "[$src] missing $kind fixture '$fixture'"
		raw="$(cat "$fixture")"
	else
		[ -n "$url" ] || die "[$src] no $kind repo URL in the pin manifest"
		raw="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs "$url" 2>/dev/null || true)"
		[ -n "$raw" ] || die "[$src] git ls-remote returned no tags for $url"
	fi
	printf '%s\n' "$raw" | awk '
		$2 ~ /^refs\/tags\// { t=$2; sub(/^refs\/tags\//, "", t); sub(/\^\{\}$/, "", t); print t }
	' | LC_ALL=C sort -u
}

# ---- per-source result table -----------------------------------------------------------------
declare -a RESULT_SOURCES=()
declare -A R_STATE=() R_PIN_UP=() R_PIN_SALSA=() R_NEW_UP=() R_NEW_SALSA=()
BEHIND_COUNT=0
AHEAD_COUNT=0

check_source() {
	local src="$1"
	local pin_up pin_salsa up_repo salsa_repo
	pin_up="$(pin "$src" upstream_tag)"       || die "[$src] cannot read upstream_tag"
	pin_salsa="$(pin "$src" salsa_tag)"       || die "[$src] cannot read salsa_tag"
	up_repo="$(pin "$src" upstream_repo)"     || die "[$src] cannot read upstream_repo"
	salsa_repo="$(pin "$src" salsa_repo)"     || die "[$src] cannot read salsa_repo"

	local pin_base="${pin_salsa#debian/}"

	# Newest stable upstream release tag.
	local stable_up="" t reason
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		reason="$(stable_reason "$t")"
		if [ "$reason" = stable ]; then
			stable_up+="$t"$'\n'
		else
			note "     skip [$src] upstream tag '$t' — $reason"
		fi
	done < <(ls_remote_tags "$src" upstream "$up_repo")
	local newest_up
	newest_up="$(printf '%s' "$stable_up" | awk 'NF' | newest)"
	[ -n "$newest_up" ] || die "[$src] no STABLE upstream tag found — refusing to guess"

	# Newest stable Debian packaging tag, and the newest one for the newest upstream release.
	local stable_salsa="" salsa_for_new="" rest ver rev
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		case "$t" in debian/*) : ;; *) continue ;; esac
		rest="${t#debian/}"
		case "$rest" in *-*) : ;; *) note "     skip [$src] salsa tag '$t' — no-debian-revision"; continue ;; esac
		ver="${rest%-*}"
		rev="${rest##*-}"
		reason="$(stable_reason "$ver")"
		if [ "$reason" != stable ]; then
			note "     skip [$src] salsa tag '$t' — $reason"
			continue
		fi
		if ! [[ "$rev" =~ ^[0-9][A-Za-z0-9.+]*$ ]]; then
			note "     skip [$src] salsa tag '$t' — non-stable-debian-revision"
			continue
		fi
		stable_salsa+="$rest"$'\n'
		[ "$ver" = "$newest_up" ] && salsa_for_new+="$rest"$'\n'
	done < <(ls_remote_tags "$src" salsa "$salsa_repo")

	local newest_salsa_for_new newest_salsa_for_pin
	newest_salsa_for_new="$(printf '%s' "$salsa_for_new" | awk 'NF' | newest)"
	newest_salsa_for_pin="$(printf '%s' "$stable_salsa" | awk -v v="$pin_up" 'index($0, v "-")==1' | newest)"

	local state new_up_display new_salsa_display bump_display
	new_up_display="$newest_up"
	new_salsa_display="${newest_salsa_for_new:+debian/$newest_salsa_for_new}"
	bump_display="$newest_up"

	if ver_gt "$newest_up" "$pin_up"; then
		if [ -n "$newest_salsa_for_new" ]; then
			state="behind"
		else
			state="upstream-ahead-no-packaging"
			new_salsa_display="none"
		fi
	elif [ -n "$newest_salsa_for_pin" ] && ver_gt "$newest_salsa_for_pin" "$pin_base"; then
		# Same upstream release, newer Debian revision. The rebuild consumes `<upstream>-<rev>`,
		# so a packaging-only revision bump is a real, actionable bump — and naming the upstream
		# version alone would report a bump to the version already pinned.
		state="behind"
		new_up_display="$pin_up"
		new_salsa_display="debian/$newest_salsa_for_pin"
		bump_display="debian/$newest_salsa_for_pin"
	else
		state="current"
		[ -n "$new_salsa_display" ] || new_salsa_display="$pin_salsa"
	fi

	RESULT_SOURCES+=("$src")
	R_STATE["$src"]="$state"
	R_PIN_UP["$src"]="$pin_up"
	R_PIN_SALSA["$src"]="$pin_salsa"
	R_NEW_UP["$src"]="$new_up_display"
	R_NEW_SALSA["$src"]="$new_salsa_display"

	case "$state" in
		behind)                      BEHIND_COUNT=$((BEHIND_COUNT + 1)); printf '%s: behind (%s)\n' "$src" "$bump_display" ;;
		upstream-ahead-no-packaging) AHEAD_COUNT=$((AHEAD_COUNT + 1));   printf '%s: upstream-ahead-no-packaging (%s)\n' "$src" "$bump_display" ;;
		*)                                                               printf '%s: current\n' "$src" ;;
	esac
}

render_issue_body() {
	local src
	cat <<-'EOF'
		The scheduled upstream-freshness watch found a newer **stable** release for at least one
		pinned ModemManager-stack source.

		| Source | Pinned upstream | Pinned packaging | Newest stable upstream | Newest stable packaging | State |
		|---|---|---|---|---|---|
	EOF
	for src in "${RESULT_SOURCES[@]}"; do
		printf '| %s | %s | %s | %s | %s | %s |\n' \
			"$src" "${R_PIN_UP[$src]}" "${R_PIN_SALSA[$src]}" \
			"${R_NEW_UP[$src]}" "${R_NEW_SALSA[$src]}" "${R_STATE[$src]}"
	done

	printf '\n## Bumps available\n\n'
	for src in "${RESULT_SOURCES[@]}"; do
		[ "${R_STATE[$src]}" = behind ] || continue
		printf -- '- **%s**: `%s` (`%s`) -> `%s` (`%s`)\n' \
			"$src" "${R_PIN_UP[$src]}" "${R_PIN_SALSA[$src]}" \
			"${R_NEW_UP[$src]}" "${R_NEW_SALSA[$src]}"
	done

	if [ "$AHEAD_COUNT" -gt 0 ]; then
		printf '\n## Upstream ahead, Debian packaging not ready\n\n'
		for src in "${RESULT_SOURCES[@]}"; do
			[ "${R_STATE[$src]}" = upstream-ahead-no-packaging ] || continue
			printf -- '- **%s**: upstream released `%s`, but no stable `debian/` packaging tag exists for it yet.\n' \
				"$src" "${R_NEW_UP[$src]}"
		done
		printf -- '\nNo bump is recommended for these. The rebuilds are `<upstream>-<rev>` pairs, so\n'
		printf -- 'without a Debian packaging tag there is no revision to pin.\n'
	fi

	cat <<-'EOF'

		## What was deliberately ignored

		Pre-release and development-series tags are filtered out: `-rc`/`-dev`/`-alpha`/`-beta`/`-pre`
		suffixes, anything that is not a plain `X.Y.Z`, **odd-minor development series** (the
		GNOME/freedesktop convention these four projects follow — ModemManager `1.25.95` is the
		unstable train toward 1.26.0 and was uploaded to Debian *experimental*), and `.9x` snapshot
		micro versions. Debian packaging tags whose revision carries a `~` (experimental/backports
		uploads) are ignored for the same reason.

		## What this issue is NOT

		This watch is **issue-only**. It never edits `packaging/upstream-pins.yaml` and never
		dispatches a build. Bumping a pin is a separate, human-reviewed change that must re-run
		`packaging/ci/verify-upstream-pins.sh` — the four-link provenance chain (lineage, `.dsc`
		authority, `.orig.tar` artifact, `debian/` packaging tree) — and refresh the checked-in
		`debian/` recipes plus `packaging/SUITE-ADAPTATIONS.md`.

		<!-- upstream-freshness-watch -->
	EOF
}

# ---- main ------------------------------------------------------------------------------------
note "check-upstream-freshness: pins=$( [ -n "$FIXTURE_DIR" ] && echo "fixtures:$FIXTURE_DIR" || echo "live git ls-remote" )"

sources="$(pin --list-sources)" || die "cannot enumerate sources from the pin manifest"
[ -n "$sources" ] || die "the pin manifest lists no sources"

checked=0
for src in $sources; do
	[ -z "$ONLY_SOURCE" ] || [ "$src" = "$ONLY_SOURCE" ] || continue
	check_source "$src"
	checked=$((checked + 1))
done
[ "$checked" -gt 0 ] || die "no matching source '$ONLY_SOURCE'"

note "check-upstream-freshness: $checked source(s) checked — $BEHIND_COUNT behind, $AHEAD_COUNT upstream-ahead-no-packaging"

if [ "$BEHIND_COUNT" -eq 0 ]; then
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "--- no issue would be opened (no source is behind) ---"
	fi
	exit 0
fi

if [ -n "$ISSUE_BODY_PATH" ]; then
	render_issue_body > "$ISSUE_BODY_PATH"
	note "check-upstream-freshness: issue body written to $ISSUE_BODY_PATH"
fi
if [ "$DRY_RUN" -eq 1 ]; then
	echo "--- issue body (dry-run, not sent) ---"
	render_issue_body
	echo "--- end issue body ---"
fi
exit 10
