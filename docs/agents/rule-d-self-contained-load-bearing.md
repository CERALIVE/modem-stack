<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## RULE D — SELF-CONTAINED (load-bearing)

**This repo builds, tests, and releases standalone in CI. The CeraLive workspace parent
does not exist there.** Therefore:

- **No tracked file may reference a path above this checkout root** — no relative
  parent-directory escape, no reference to the workspace parent directory, no sibling-repo
  `link:` / `file:` / relative-path dependency. Cross-repo CeraLive packages
  (`@ceralive/biome-config`, and in future `@ceralive/modem-control` consumers) are used
  **registry-only**, resolved through npm identically whether or not any sibling repo is
  checked out.
- Test artifacts and QA evidence go to the repo-local, gitignored `test-results/`.
- The local orchestration scratch dir (`.omo/`) is gitignored and must appear in no other
  tracked file.
- Config that a child package needs is resolved by package name (Biome via
  `@ceralive/biome-config`) or from a single repo-root `tsconfig.json` that covers both
  workspace members — never by climbing out of the repo.

If a build step needs something from outside the repo, that is a design error: surface it,
do not reach up the tree.

