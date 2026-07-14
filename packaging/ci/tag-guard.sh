#!/usr/bin/env bash
# tag-guard.sh — the release-tag contract for modem-stack.
#
# A release tag MUST be exactly `vX.Y.Z` — SemVer core only, NO pre-release suffix and NO
# build metadata. Anything else FAILS CLOSED, before any publish job runs. Two reasons:
#   * a pre-release tag (e.g. `v1.0.0-rc.1`) inverts dpkg ordering — its tilde-encoded
#     `.deb` version (`~ceralive1.0.0-rc.1`) would outrank the final release
#     (`~ceralive1.0.0`), which is exactly backwards;
#   * build metadata (`v1.0.0+build5`) has no meaning in a `.deb` version.
# A missing `v` prefix (`1.0.0`) is rejected too.
#
# Canonical regex: ^v\d+\.\d+\.\d+$   (ERE: ^v[0-9]+\.[0-9]+\.[0-9]+$)
#
# Usage: tag-guard.sh <tag>
#   On match: exits 0 and echoes the stripped `X.Y.Z`.
#   On mismatch: exits 1 with a reason on stderr.
# Also sourceable: `source tag-guard.sh` exposes validate_tag without running anything.
set -euo pipefail

TAG_ERE='^v[0-9]+\.[0-9]+\.[0-9]+$'

validate_tag() {
	local tag="${1-}"
	if [ -z "$tag" ]; then
		echo "tag-guard: no tag provided" >&2
		return 1
	fi
	if [[ "$tag" =~ $TAG_ERE ]]; then
		printf '%s\n' "${tag#v}"
		return 0
	fi
	echo "tag-guard: '$tag' is not a canonical release tag (must match ${TAG_ERE})" >&2
	return 1
}

# Run validate_tag only when executed directly, not when sourced.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	validate_tag "${1-}"
fi
