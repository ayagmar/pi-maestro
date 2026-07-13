# Plan 010: Persist bounded drive decisions and deliver each wakeup exactly once

> **Executor instructions**: Follow this plan without adding model-facing tools. Use only normal repository tools. Update the plan index when complete.
>
> **Drift check**: `git diff --stat -- src/types.ts src/board.ts src/index.ts src/workflow.ts src/format.ts test/index.test.ts test/board.test.ts test/format.test.ts`
> Planned at `41b6057` with working-diff checksum `5d86f382a96852fbe76fffc44b0afff54e4e8f78e91fcbede7e0c850b8bb0275`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/009-restore-three-tool-regressions.md`
- **Category**: bug, architecture
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Drive completion and decisions currently live in an in-memory `_backgroundDrive` and are sent directly. Reload/session replacement can lose evidence or duplicate a wakeup, and inspect cannot reconstruct a settled decision. One small persisted decision record is enough; a general event-sourcing framework is not.

## Current state

- `src/index.ts:193,370-396` owns background drive memory and direct `pi.sendMessage()`.
- `Board` in `src/types.ts` has paused drive state but no decision record.
- `DriveStopReason` in `src/workflow.ts` already provides bounded kind/message/task IDs.
- Routine UI progress must remain out of model context.

## Scope

**In scope**: listed drift files and focused tests.

**Out of scope**: database/event sourcing, extra model tools, raw transcript persistence, analytics dashboard.

## Steps

### Step 1: Define one backward-compatible record

Add optional `activeDecision` to `Board` with stable ID, owner session, kind, task IDs, bounded evidence, allowed interventions, created time, delivered time, and optional resolution. Validate it in board loading. Permit only one unresolved decision.

**Verify**: legacy board tests pass; malformed decision fixtures are rejected without replacing the live board.

### Step 2: Persist before notification

When a drive reaches completion or a decision stop, atomically persist the record before calling `pi.sendMessage`. Mark delivery only after successful queueing. On reload, deliver only an undelivered decision owned by the current session.

**Verify**: focused tests cover crash/reload between persistence and delivery and after delivery.

### Step 3: Make inspect/intervene decision-aware

`maestro_drive inspect` returns bounded active decision evidence plus live activity. `intervene` requires the active decision ID for settled decisions, validates ownership/action, resolves exactly once, and rejects stale IDs. Handoff remains routed through `/maestro handoff`.

### Step 4: Define terminal cancellation semantics

Choose the minimal consistent rule: canceled tasks are terminal only when explicitly accepted/canceled by operator policy; document and encode whether a board containing cancellations completes. Align `driveBoard()` and `cleanupCompletedBoard()` so cleanup cannot claim a completion drive never emits.

### Step 5: Bound and verify

Cap evidence/message length and task count. Full diagnostics remain referenced by session/log paths. Run full checks twice.

## Test plan

Use the fake extension API in `test/index.test.ts`. Cover one delivery, reload idempotency, foreign owner, stale decision ID, completion, provider block, escalation, handoff routing, and canceled-task completion policy.

## Done criteria

- [ ] Decisions survive reload and are delivered at most once.
- [ ] Routine progress causes zero model messages.
- [ ] Inspect/intervene are bounded, owned, and ID-checked.
- [ ] Cancellation and cleanup semantics agree.
- [ ] Exactly three model tools remain.
- [ ] Full suite passes twice.

## STOP conditions

- Pi message APIs differ from installed extension documentation.
- Persistence requires raw transcripts or unbounded reports.
- Session replacement would be called from a tool context.

## Maintenance notes

Keep this a current decision record, not a general event log. Analytics can derive from attempts and settled summaries later.