# Task 30c — B2/B5/B6 fix PR

- Branch: `fix/usb-mode-certify-b2-b5-b6`
- Base: current `origin/main` (`4b4b206`, PR #12 squash)
- PR: https://github.com/CERALIVE/modem-stack/pull/14
- Status: open; not merged
- CI: no checks reported for the branch at verification time

The branch contains the five post-consolidation commits fixing the hardware-confirmed B2/B5/B6 issues. The real-hardware findings and fix rationale are documented in:

- `.omo/evidence/task-30-real-hardware.md`
- `.omo/evidence/task-30b-b2-b5-b6-fix.md`

Local verification after cherry-picking onto `origin/main`:

- `bun test`: 1321 passed, 0 failed
- `bun run typecheck`: passed

The rebased tree matches the combined net changes from the five commits originally based on `90cb14a`; no AI trailers were present in the five resulting commits.
