#!/usr/bin/env bash
# test-release-workflow-wiring.sh — the differential build-deb wiring contract, proven STATICALLY
# over .github/workflows/release.yml.
#
# HOST-RUNNABLE, OFFLINE, NO DOCKER, AND IT NEVER DISPATCHES A WORKFLOW. Everything asserted here
# is a property of the YAML TEXT, because the properties that matter are ones a real run cannot
# show you cheaply: a release costs two QEMU container builds, and the two failure modes this
# guards against (staging after the build, and a `${{ }}` reaching a shell body) are both SILENT.
#
#   * ORDER — `stage-carryforward-debs.sh` must precede EVERY `build-bookworm.sh` invocation.
#     Carried debs are a build INPUT: build-bookworm.sh seeds its Pin-Priority-1001 local apt repo
#     from packaging/build/<arch>/. Staged late, a changed source silently resolves its build-deps
#     against stock bookworm and the release still goes green.
#   * ENV-ROUTING — no `${{ … }}` may be interpolated into a `run:` body (the file's own security
#     model, release.yml header). An interpolated tag is a shell-injection surface.
#   * ONE FETCH — the previous manifest is resolved once and reused by all three consumers.
#   * NO WORKFLOW-LEVEL `if:` — conditional/zero-build selection lives INSIDE build-bookworm.sh.
#     A step-level `if:` would skip the companion build or the merged-closure assertion with it.
#
# Both non-trivial detectors carry a non-vacuity control, so a green run cannot come from a
# check that can never fail.
#
# RESIDUAL RISK (accepted by the plan): the zero-build path reaching manifest generation with
# staged-only debs is NOT proven end-to-end here or anywhere else — it is proven in pieces by
# test-build-bookworm-differential.sh and test-suffix-coherence-manifest.sh, and the full proof
# lands at the FIRST REAL RELEASE RUN.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# RELEASE_WORKFLOW_FILE points the whole contract at another copy of the workflow. It exists so a
# deliberately-broken copy can be driven through THIS script rather than a re-implementation of it
# — the only way a failure demonstration proves anything about the checks that actually run.
WORKFLOW="${RELEASE_WORKFLOW_FILE:-$REPO_ROOT/.github/workflows/release.yml}"

[ -r "$WORKFLOW" ] || { echo "missing: $WORKFLOW" >&2; exit 1; }

pass=0
fail=0
ok() { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

echo "release.yml differential wiring contract"
echo "  workflow: ${WORKFLOW#"$REPO_ROOT"/}"

# ---- helpers ----------------------------------------------------------------------------------

# First 1-based line number matching a fixed string; empty when absent.
line_of() { grep -n -m1 -F -- "$1" "$WORKFLOW" | cut -d: -f1; }

# Same, for a command INVOCATION. The end-of-line anchor — not a `run:` prefix, which a step
# that guards its invocation inside `run: |` no longer carries — is what skips an earlier
# mention of the same path inside an `echo "::error::…"` string.
line_of_invocation() { grep -nE -m1 -- "$1"'[[:space:]]*$' "$WORKFLOW" | cut -d: -f1; }

# The comparator every ordering assertion goes through, so ONE non-vacuity control covers them all.
assert_before() { # <label-a> <line-a> <label-b> <line-b>
	local a_label="$1" a="$2" b_label="$3" b="$4"
	if [ -z "$a" ] || [ -z "$b" ]; then
		bad "ordering '$a_label' < '$b_label' — step not found (a=${a:-missing}, b=${b:-missing})"
		return 1
	fi
	if [ "$a" -lt "$b" ]; then
		ok "'$a_label' (line $a) is ordered strictly BEFORE '$b_label' (line $b)"
		return 0
	fi
	bad "'$a_label' (line $a) is NOT before '$b_label' (line $b)"
	return 1
}

# Every line that sits inside a `run:` scalar and interpolates a GitHub expression.
# The block is delimited by INDENTATION: content of a `run:` key is strictly more indented than
# the key itself, so a sibling `env:`/`with:`/`- name:` ends the block.
run_body_expressions() { # <workflow-file>
	awk '
		function indent_of(s,   i) { i = match(s, /[^ ]/); return (i == 0) ? -1 : i - 1 }
		{
			line = $0
			if (in_run) {
				if (line ~ /^[ ]*$/) { next }
				if (indent_of(line) > key_indent) {
					if (line ~ /\$\{\{/) { printf "%d:%s\n", NR, line }
					next
				}
				in_run = 0
			}
			if (match(line, /^[ ]*(- )?run:/)) {
				key_indent = RLENGTH - 4        # chars before `run:` == its column
				rest = substr(line, RLENGTH + 1)
				if (rest ~ /\$\{\{/) { printf "%d:%s\n", NR, line }
				in_run = 1
			}
		}
	' "$1"
}

# ---- 1. the new steps exist, with the exact names todo 7 will document -------------------------

CHECKOUT_LINE="$(line_of '- name: Checkout the resolved commit')"
RESOLVE_LINE="$(line_of '- name: Resolve previous release + fetch its manifest (once)')"
DETECT_LINE="$(line_of '- name: Detect changed sources (per-source verdicts)')"
STAGE_LINE="$(line_of '- name: Stage carry-forward debs (unchanged sources, sha256-verified)')"
BUILD_STEP_LINE="$(line_of '- name: Build the MM 1.24 stack (.deb)')"
BUILD_CALL_LINE="$(line_of 'packaging/ci/build-bookworm.sh amd64')"
COMPANION_LINE="$(line_of_invocation 'packaging/ci/build-companion\.sh')"
MANIFEST_LINE="$(line_of 'run: bash packaging/ci/generate-release-manifest.sh')"
UPLOAD_LINE="$(line_of '- name: Upload .deb artifacts + release manifest')"

for pair in \
	"resolve-previous-release:$RESOLVE_LINE" \
	"detect-changed-sources:$DETECT_LINE" \
	"stage-carryforward-debs:$STAGE_LINE" \
	"build-bookworm-invocation:$BUILD_CALL_LINE" \
	"build-companion:$COMPANION_LINE" \
	"generate-release-manifest:$MANIFEST_LINE" \
	"upload-artifacts:$UPLOAD_LINE"; do
	if [ -n "${pair#*:}" ]; then
		ok "step present: ${pair%%:*}"
	else
		bad "step MISSING: ${pair%%:*}"
	fi
done

# ---- 2. the ordering contract -----------------------------------------------------------------

assert_before "Checkout the resolved commit" "$CHECKOUT_LINE" "Resolve previous release" "$RESOLVE_LINE"
assert_before "Resolve previous release" "$RESOLVE_LINE" "Detect changed sources" "$DETECT_LINE"
assert_before "Detect changed sources" "$DETECT_LINE" "Stage carry-forward debs" "$STAGE_LINE"
assert_before "Stage carry-forward debs" "$STAGE_LINE" "Build the MM 1.24 stack" "$BUILD_STEP_LINE"
assert_before "Stage carry-forward debs" "$STAGE_LINE" "build-bookworm.sh invocation" "$BUILD_CALL_LINE"
assert_before "build-bookworm.sh invocation" "$BUILD_CALL_LINE" "companion build" "$COMPANION_LINE"
assert_before "companion build" "$COMPANION_LINE" "generate-release-manifest.sh" "$MANIFEST_LINE"
assert_before "generate-release-manifest.sh" "$MANIFEST_LINE" "artifact upload" "$UPLOAD_LINE"

# The headline invariant, stated over EVERY invocation rather than the first. Comment lines are
# excluded because release.yml discusses build-bookworm.sh in prose above the job's first step;
# only an executable mention is an invocation.
earliest_build=""
while IFS=: read -r n _; do
	[ -n "$n" ] || continue
	if [ -z "$earliest_build" ] || [ "$n" -lt "$earliest_build" ]; then earliest_build="$n"; fi
done < <(grep -n -F 'build-bookworm.sh' "$WORKFLOW" | grep -vE '^[0-9]+:[[:space:]]*#')
assert_before "Stage carry-forward debs" "$STAGE_LINE" "EARLIEST executable build-bookworm.sh mention" "$earliest_build"

# Non-vacuity: the comparator must reject an inverted pair. The operands are SYNTHETIC constants,
# not line numbers read from the file, so this control keeps its meaning even when it is run
# against a deliberately-broken copy in which the real pair is already inverted.
if assert_before "control-later" 2 "control-earlier" 1 >/dev/null 2>&1; then
	bad "NON-VACUITY: assert_before accepted an inverted pair — the ordering proofs are meaningless"
else
	ok "NON-VACUITY: assert_before rejects an inverted pair"
	pass=$((pass - 1))
	fail=$((fail - 1))
fi

# ---- 3. fetch-depth: 0 on build-deb's checkout -------------------------------------------------
# Shallow history would make `git diff <prev-tag>..HEAD` and `git rev-parse <tag>^{commit}`
# unresolvable, and the detector would force-all on every release — SAFE, and silent.

build_deb_start="$(line_of 'build-deb:')"
publish_npm_start="$(line_of 'publish-npm:')"
if [ -n "$build_deb_start" ] && [ -n "$publish_npm_start" ]; then
	if sed -n "${build_deb_start},${publish_npm_start}p" "$WORKFLOW" | grep -qE '^ +fetch-depth: 0$'; then
		ok "build-deb's checkout carries fetch-depth: 0 (full history + tags reachable)"
	else
		bad "build-deb's checkout has NO fetch-depth: 0 — detection would force-all every release"
	fi
else
	bad "could not locate the build-deb job block"
fi

# ---- 4. the force_rebuild input ---------------------------------------------------------------

if awk '/^      force_rebuild:$/{f=1} f && /type: boolean/{t=1} f && /default: false/{d=1} END{exit !(f && t && d)}' "$WORKFLOW"; then
	ok "workflow_dispatch input force_rebuild present, type: boolean, default: false"
else
	bad "workflow_dispatch input force_rebuild is missing, or is not 'type: boolean' + 'default: false'"
fi

if grep -qF "FORCE_REBUILD: \${{ github.event.inputs.force_rebuild == 'true' && 'all' || '' }}" "$WORKFLOW"; then
	ok "force_rebuild maps to FORCE_REBUILD=all (empty otherwise — the detector's not-forced default)"
else
	bad "force_rebuild is not mapped to FORCE_REBUILD=all through an env: block"
fi

# ---- 5. env-routing: no ${{ }} inside any run: body --------------------------------------------

offenders="$(run_body_expressions "$WORKFLOW")"
if [ -z "$offenders" ]; then
	ok "no \${{ }} expression is interpolated into any run: body"
else
	bad "\${{ }} found inside run: body/bodies:"
	printf '       %s\n' "$offenders"
fi

# Non-vacuity: the detector must trip on a deliberately injected expression in a scratch COPY.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ceralive-release-wiring.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
POISONED="$SCRATCH/release.yml"
awk '
	{ print }
	/^          bash packaging\/ci\/detect-changed-sources.sh --out verdicts.txt$/ && !done {
		print "          echo \"poisoned ${{ github.event.inputs.tag }}\""
		done = 1
	}
' "$WORKFLOW" >"$POISONED"
# shellcheck disable=SC2016  # the literal `${{ … }}` text is the search term; expansion would defeat it
if ! grep -qF 'poisoned ${{ github.event.inputs.tag }}' "$POISONED"; then
	bad "NON-VACUITY setup failed: the scratch copy was not poisoned"
elif [ -n "$(run_body_expressions "$POISONED")" ]; then
	ok "NON-VACUITY: the run-body expression detector flags a deliberately injected \${{ }}"
else
	bad "NON-VACUITY: the run-body expression detector MISSED an injected \${{ }} — it proves nothing"
fi

# ---- 6. the previous manifest is fetched ONCE and reused ---------------------------------------

# shellcheck disable=SC2016  # the literal `${{ … }}` text is the search term; expansion would defeat it
reuse_count="$(grep -cF 'PREV_MANIFEST_FILE: ${{ steps.prev-release.outputs.prev_manifest }}' "$WORKFLOW")"
if [ "$reuse_count" -eq 3 ]; then
	ok "the resolved manifest path is reused by all 3 consumers (detect / stage / build), never re-fetched"
else
	bad "expected 3 PREV_MANIFEST_FILE consumers wired to steps.prev-release.outputs.prev_manifest, found $reuse_count"
fi

download_count="$(grep -cF 'gh release download' "$WORKFLOW")"
if [ "$download_count" -eq 1 ]; then
	ok "release.yml performs exactly ONE 'gh release download' (the resolve step)"
else
	bad "expected exactly 1 'gh release download' in release.yml, found $download_count"
fi

if grep -qE '^\s+run: bash packaging/ci/stage-carryforward-debs\.sh --verdicts verdicts\.txt --build-root packaging/build$' "$WORKFLOW"; then
	ok "the stager is invoked with --verdicts verdicts.txt --build-root packaging/build"
else
	bad "the stage-carryforward-debs.sh invocation does not match its documented CLI contract"
fi

if grep -qE '^\s+VERDICTS_FILE: verdicts\.txt$' "$WORKFLOW"; then
	ok "the builder receives an EXPLICIT build set (VERDICTS_FILE) — never the build-all local-dev default"
else
	bad "the build step does not supply VERDICTS_FILE; CI would fall back to build-bookworm.sh's build-all default"
fi

# ---- 7. no workflow-level `if:` in build-deb ---------------------------------------------------
# Zero-build selection is build-bookworm.sh's job. A step-level `if:` here would also skip the
# always-rebuilt companion and the merged-closure assertion, which must run on every release.

if [ -n "$build_deb_start" ] && [ -n "$publish_npm_start" ]; then
	if sed -n "${build_deb_start},${publish_npm_start}p" "$WORKFLOW" | grep -qE '^\s+if:'; then
		bad "build-deb carries a step/job-level 'if:' — conditionality belongs inside build-bookworm.sh"
	else
		ok "build-deb has no workflow-level 'if:' (the companion build stays unconditional)"
	fi
fi

# ---- 8. dry parse -----------------------------------------------------------------------------

if python3 -c 'import yaml' >/dev/null 2>&1; then
	if python3 -c 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))' "$WORKFLOW" >/dev/null 2>&1; then
		ok "dry parse: release.yml is well-formed YAML"
	else
		bad "dry parse: release.yml is NOT well-formed YAML"
	fi
else
	echo "  note: PyYAML not present; dry parse skipped (actionlint covers it in CI)"
fi

# actionlint is compared against a NAMED baseline rather than required to be silent. release.yml
# carries exactly one long-standing finding, in the create-release job this change is fenced out
# of: shellcheck flags `printf '  %s\n' $dupes` as SC2086, where the word splitting is deliberate
# (each duplicate basename must become its own %s argument). Requiring silence would mean editing
# a job outside this change's scope; ignoring shellcheck wholesale would mask real findings. So the
# finding set must EQUAL the baseline — a new finding anywhere still fails. The `SC2086:info:5:19`
# coordinates are the offset WITHIN that step's script, so the fingerprint survives line shifts.
ACTIONLINT_BASELINE='shellcheck reported issue in this script: SC2086:info:5:19: Double quote to prevent globbing and word splitting [shellcheck]'

if command -v actionlint >/dev/null 2>&1; then
	al_raw="$(actionlint "$WORKFLOW" 2>&1)"
	al_findings="$(printf '%s\n' "$al_raw" | sed -nE 's|^.*release\.yml:[0-9]+:[0-9]+: ||p')"
	if [ "$al_findings" = "$ACTIONLINT_BASELINE" ]; then
		ok "actionlint: no new findings (only the documented pre-existing create-release SC2086)"
	elif [ -z "$al_findings" ]; then
		ok "actionlint is entirely clean on release.yml (baseline finding is gone — better than required)"
	else
		bad "actionlint reported findings beyond the documented baseline:"
		printf '       %s\n' "$al_findings"
	fi
else
	echo "  note: actionlint not on PATH; run it separately (it is the authoritative workflow lint)"
fi

echo "  $pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then
	echo "PASS: carry-forward is ordered before every build, inputs are env-routed, the manifest is fetched once"
	exit 0
fi
echo "FAIL: release.yml differential wiring contract"
exit 1
