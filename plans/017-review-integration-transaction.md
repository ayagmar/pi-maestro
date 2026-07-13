# Plan 017: Hold review ownership through integration, verification, and final persistence

> **Executor instructions**: Follow this plan step by step using normal coding tools. Preserve the existing dirty working tree and all user artifacts. Do not invoke Maestro, commit, push, release, add dependencies, or alter versions/changelog. Run every verification gate. Update this plan's row in `plans/README.md` when complete.
>
> **Drift check (run first)**: `git rev-parse --short HEAD && git diff | sha256sum && git diff --stat -- src/workflow.ts src/board.ts test/workflow.test.ts test/board.test.ts`
> Planned at commit `41b6057` against dirty-diff checksum `af3a7b4605d23a5d25baa57deb3f9bf6e47f244b19344958b6a402dcf455d473`. Reconcile harmless line drift; STOP if review claim semantics or integration ordering changed materially.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug, correctness, tests
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

`reviewTask()` currently releases its dispatch lease immediately after the reviewer process settles, before verdict parsing, merge/commit, trusted verification, and final `updateTask()`. The task is still `ready_for_review`, so another caller can claim and review/integrate the same artifact concurrently. Review ownership must cover the complete transaction through final persisted state.

## Current state

- `src/workflow.ts:120-142` — `claimDispatchLifecycle()` creates renewal and exposes `close()`.
- `src/workflow.ts:1060-1110` — reviewer launch loop ends, then `lifecycle.close()` runs before integration.
- `src/workflow.ts:1110-1250` — merge, verification, provenance, and status persistence happen after release.
- `src/board.ts:568-630` — claims are ownership-checked; reuse these primitives.
- Existing style: injected `StartExecutor`, temporary boards, and fake promises in `test/workflow.test.ts`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import=tsx --test test/board.test.ts test/workflow.test.ts` | all pass |
| Complete | `pnpm run check` | exit 0 |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**: `src/workflow.ts`, `src/board.ts` only if an ownership primitive requires correction, `test/workflow.test.ts`, `test/board.test.ts`.

**Out of scope**: artifact identity redesign, verification command trust, retry policy, statuses, dependencies, UI.

## Steps

### Step 1: Add failing concurrency characterization

Add tests that hold merge, commit, post-integration verification, and final persistence at controlled boundaries. While each boundary is blocked, invoke a second `reviewTask()` for the same task. Assert one reviewer/integration owner, one persisted review accounting update, one merge/commit, and a declined duplicate snapshot. Add synchronous merge/persistence throw cases and verify the lease/timer is still released.

**Verify**: focused tests fail against the current early-release implementation for at least one slow post-review boundary.

### Step 2: Make the lifecycle helper own an async operation

Replace manual `close()` placement with the smallest async helper that claims, renews, awaits the entire supplied operation, and closes in one outer `finally`. Keep board authority in `board.ts`; do not introduce a resource framework. Execute and review paths should both use the same invariant.

**Verify**: `rg -n "lifecycle\.close\(\)" src/workflow.ts` shows no early review close; focused tests pass.

### Step 3: Cover every terminal path

Verify release on approve, request changes, no verdict, provider fallback exhaustion, abort, merge conflict, candidate verification failure, integration verification failure, commit failure, and persistence throw. Ownership-checked release must not clear a newer claim.

**Verify**: focused tests pass twice.

### Step 4: Full gate

Run the complete gate and patch hygiene.

**Verify**: `pnpm run check && git diff --check` exits 0.

## Test plan

- Duplicate review during slow merge and slow verification.
- Final `updateTask()` throw releases lease and timer.
- Older owner cannot clear a replacement claim.
- Review fallback remains one review transaction and creates no execute attempt.
- Existing execute synchronous-spawn regression remains green.

## Done criteria

- [x] Review claim remains active through final board persistence.
- [x] Exactly one outer `finally` releases every claimed dispatch.
- [x] Duplicate review/integration is behaviorally prevented.
- [x] No timer survives any terminal path.
- [x] Focused and full checks pass.
- [x] Plan row marked DONE.

## STOP conditions

- Correctness requires deleting or rewriting recoverable worktrees/attempts.
- Board ownership checks cannot prevent duplicate integration without a schema migration.
- The same focused failure occurs twice after a reasonable fix.

## Maintenance notes

Any future review-side side effect must remain inside the claimed operation until its result is persisted. Keep retry policy outside this primitive.
