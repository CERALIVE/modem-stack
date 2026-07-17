#!/usr/bin/env bash
# resolve-tag.sh <repo-url> <tag> — resolve a release tag to its immutable peeled commit SHA.
#
# The release workflow pins EVERY checkout to the commit a tag points at, never to the mutable
# tag ref itself. This is the single source of that resolution: given a repository URL and a
# tag name, it asks the remote (`git ls-remote`, no clone) for BOTH the tag ref and its peeled
# form `<tag>^{}`, PREFERS the peeled COMMIT sha (an annotated tag otherwise resolves to its
# tag OBJECT, not the commit), and FAILS CLOSED when the tag is absent or resolves ambiguously.
#
# It has FOUR call sites — the workflow's tag-guard resolve step, publish-npm's pre-publish
# TOCTOU re-check, create-release's pre-create re-check, and the QA drills — so the resolution
# logic lives HERE ONCE, never as a divergent copy inlined in the YAML.
#
# The caller detects a MOVED tag by comparing this script's output against a previously-resolved
# sha (e.g. `[ "$(resolve-tag.sh "$url" "$tag")" = "$PINNED" ]`); the script itself only ever
# reports what the tag currently peels to.
#
# Usage: resolve-tag.sh <repo-url> <tag>
#   stdout : the resolved 40-hex commit sha (exit 0).
#   stderr : a reason, on failure.
# Exit:
#   0  resolved sha printed.
#   1  tag absent / ambiguous / malformed remote output / ls-remote failed.
#   2  usage.
set -euo pipefail

REPO_URL="${1:-}"
TAG="${2:-}"

if [ -z "$REPO_URL" ] || [ -z "$TAG" ]; then
	echo "resolve-tag: usage: resolve-tag.sh <repo-url> <tag>" >&2
	exit 2
fi

# One network round-trip: ask for the tag ref AND its peeled form together. Exact refspecs
# (no globbing) so the remote can only answer with these two ref names.
if ! refs="$(git ls-remote "$REPO_URL" "refs/tags/$TAG" "refs/tags/$TAG^{}")"; then
	echo "resolve-tag: git ls-remote failed for '$REPO_URL'" >&2
	exit 1
fi

if [ -z "$refs" ]; then
	echo "resolve-tag: tag '$TAG' not found on '$REPO_URL'" >&2
	exit 1
fi

plain_sha=""
peeled_sha=""
while IFS=$'\t' read -r sha ref; do
	[ -n "$sha" ] || continue
	case "$ref" in
	"refs/tags/$TAG^{}") peeled_sha="$sha" ;;
	"refs/tags/$TAG") plain_sha="$sha" ;;
	*)
		# Exact refspecs were requested; anything else is an ambiguous/hostile remote answer.
		echo "resolve-tag: unexpected ref '$ref' in ls-remote output for tag '$TAG'" >&2
		exit 1
		;;
	esac
done <<<"$refs"

# Prefer the peeled commit (annotated tag); fall back to the plain ref (lightweight tag, which
# already points straight at a commit).
resolved="${peeled_sha:-$plain_sha}"

if [ -z "$resolved" ]; then
	echo "resolve-tag: tag '$TAG' resolved to no sha on '$REPO_URL'" >&2
	exit 1
fi

# Defensive: ls-remote always emits 40-hex object names; anything else is corrupt output.
if ! [[ "$resolved" =~ ^[0-9a-f]{40}$ ]]; then
	echo "resolve-tag: tag '$TAG' resolved to a non-sha value '$resolved'" >&2
	exit 1
fi

printf '%s\n' "$resolved"
