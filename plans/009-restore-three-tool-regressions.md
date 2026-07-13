# Plan 009: Restore behavioral coverage for the three-tool control plane

> **Executor instructions**: Use normal tools. Do not reduce test count, skip tests, or replace behavioral tests with registration assertions. Update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat -- src/index.ts src/prompts.ts test/index.test.ts test/prompts.test.ts`
> Planned at `41b6057` with dirty-diff checksum `5d86f382a96852fbe76fffc44b0afff54e4e8f78e91fcbede7e0c850b8bb0275`. Stop if the public model tool count is no longer exactly three.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/008-dispatch-lifecycle-transaction.md`
- **Category**: tests
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Eleven tests named for cancellation, status ownership, provider decisions, retention, and wakeups now assert only that three tools are registered. The suite count stayed green while distinct safety contracts disappeared. This plan restores those contracts against `maestro_drive` without restoring removed tools.

## Current state

- `test/index.test.ts:503,1015-1213` contains repeated `three-tool migration` assertions.
- The model tools are `maestro_plan`, `maestro_update`, and `maestro_drive`.
- Human `/maestro run`, `/maestro review`, and `/maestro status` commands remain supported.
- `loadMaestro()` provides dependency injection and fake command/session contexts; reuse it.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import=tsx --test test/index.test.ts test/prompts.test.ts` | all pass |
| Duplicate check | `rg -n "three-tool migration" test/index.test.ts` | no matches |
| Full gate | `pnpm run check` | exit 0 |

## Scope

**In scope**: `test/index.test.ts`, `test/prompts.test.ts`; `src/index.ts` only for a confirmed testability seam that does not change behavior.

**Out of scope**: adding legacy model tools, changing workflow policy, snapshots, test skips.

## Steps

### Step 1: Keep one registration contract

Retain one test asserting the exact three registered names and absence of run/review/status model tools.

### Step 2: Rebuild each lost scenario

Replace the remaining repeated tests with behavior-specific tests using `maestro_drive` actions and human commands as appropriate:

1. start returns immediately and reserves owner control;
2. supplied AbortSignal reaches live executors;
3. pause/resume preserves selected scope and owner;
4. retention warning is bounded and approval still settles;
5. inspect is bounded and owner-safe;
6. routine progress emits no model wakeup;
7. completion emits one `triggerTurn` follow-up;
8. capped predecessor guidance excludes it from scoped successor drive;
9. provider block emits one decision and does not hot-loop;
10. repeated review rejection emits one escalation decision;
11. reload/foreign session cannot consume or duplicate an owner decision.

Capture `pi.sendMessage` and `pi.sendUserMessage` in the fake API rather than testing prose only.

**Verify**: focused tests pass and every test has a distinct assertion path.

### Step 3: Add schema combination tests

Test valid minimal start/inspect/intervene inputs and invalid combinations: intervention without action, steer without live task/instruction policy, task IDs on incompatible action, and handoff routing through the command.

### Step 4: Full verification

Run full gate twice and confirm stable test count.

## Done criteria

- [ ] Only one exact tool-count test exists.
- [ ] All eleven removed behavior contracts have meaningful replacements.
- [ ] No skipped/deleted safety tests.
- [ ] Full suite passes twice with stable count.

## STOP conditions

- A behavior cannot be observed without exposing a private implementation solely for tests.
- Restoring coverage requires re-registering removed model tools.
- The same verification failure occurs twice.

## Maintenance notes

Test names must describe the current three-tool contract, not migration history. Prefer state/output assertions over implementation call counts except for idempotent wakeups.