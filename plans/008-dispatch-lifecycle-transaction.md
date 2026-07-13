# Plan 008: Make dispatch ownership exception-safe from claim through final persistence

> **Executor instructions**: Follow this plan step by step using normal repository tools. Do not invoke Maestro recursively. Preserve the existing dirty working tree. Run every verification command. Update this plan's row in `plans/README.md` when complete.
>
> **Drift check (run first)**: `git rev-parse --short HEAD && git diff | sha256sum && git diff --stat -- src/board.ts src/workflow.ts src/runner.ts test/board.test.ts test/workflow.test.ts`
> Planned at commit `41b6057` with working-diff checksum `5d86f382a96852fbe76fffc44b0afff54e4e8f78e91fcbede7e0c850b8bb0275`. If in-scope code has changed, reconcile symbols before editing; stop if dispatch ownership semantics changed materially.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, tests
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Execution and review claim persisted dispatch leases before spawning children, but their cleanup `finally` blocks begin after `startExecutor()`. A synchronous spawn or bookkeeping exception can strand a running task, lease, and renewal timer. Dispatch ownership must be one exception-safe transaction.

## Current state

- `src/board.ts:510-620` owns claim, renew, release, and stale recovery.
- `src/workflow.ts:677` starts an executor before the execute `try/finally` at lines 706-716.
- `src/workflow.ts:894-972` starts review renewal and later releases it without an outer `finally`.
- Board mutation conventions use `updateTask()`; do not add a second persistence path.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `node --import=tsx --test test/board.test.ts test/workflow.test.ts` | all pass |
| Full gate | `pnpm run check` | exit 0 |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**: `src/board.ts`, `src/workflow.ts`, `src/runner.ts` only if the executor handle contract requires it, and focused tests.

**Out of scope**: retry policy, new statuses, model routing, board schema redesign, dependencies.

## Steps

### Step 1: Characterize every lease exit

Add tests for execute and review covering synchronous `startExecutor()` throw, rejected outcome promise, abort, provider fallback, post-outcome persistence throw where injectable, and stale-owner release after a newer claim. Assert timer cleanup, claim removal, one reserved attempt, and no child duplication.

**Verify**: focused tests fail for synchronous spawn before implementation.

### Step 2: Introduce one scoped dispatch lifecycle helper

Create the smallest workflow-local helper that claims, starts renewal only after successful claim, and always clears renewal/releases the matching claim in `finally`. Keep claim authority in `board.ts`. Do not widen it into a generic resource framework.

**Verify**: `rg -n "claimTaskDispatch|releaseTaskDispatch|renewTaskDispatch" src/workflow.ts` shows execute and review using the common lifecycle.

### Step 3: Make attempt reservation atomic and attributable

Ensure execute reserves exactly one attempt per consuming launch and provider fallback semantics remain explicit. A synchronous spawn failure must finalize the reserved attempt with a structured infrastructure/process failure rather than leaving `pending` metadata. Review claims must never create execute attempts.

**Verify**: `node --import=tsx --test test/board.test.ts test/workflow.test.ts` passes.

### Step 4: Verify startup recovery compatibility

Confirm active unexpired claims remain intact and only expired/orphaned claims recover. Release must be ownership-checked so an old finally cannot erase a newer claim.

**Verify**: full gate and hygiene commands pass.

## Test plan

Follow existing temporary-board and injected `StartExecutor` patterns in `test/workflow.test.ts`. Use fake handles; no real child processes. Include duplicate concurrent dispatch and synchronous throw regressions.

## Done criteria

- [ ] Every claimed execute/review dispatch has an outer `finally`.
- [ ] Renewal timers cannot survive settlement or exceptions.
- [ ] Synchronous spawn failure leaves a retryable, attributable task state.
- [ ] A stale owner cannot clear a newer claim.
- [ ] Focused/full checks and `git diff --check` pass.

## STOP conditions

- Fixing this requires deleting recoverable worktrees or attempts.
- Attempt accounting cannot preserve current provider-fallback behavior without a schema migration.
- The same focused failure occurs twice.

## Maintenance notes

Review every future launch path for the claim-renew-release invariant. Keep lease durations and retry policy separate.