# Plan 002: Make every executor attempt isolated, attributable, and transactionally integrated

> **Executor instructions**: Execute with normal repository tools, not pi-maestro. Read Plan 001’s completed changes first. Implement in small verified steps. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 41b6057..HEAD -- src/runner.ts src/workflow.ts src/worktree.ts src/board.ts src/types.ts src/index.ts test/runner.test.ts test/workflow.test.ts test/worktree.test.ts test/board.test.ts test/index.test.ts`
> If Plan 001 changed an in-scope file, reconcile this plan with the live symbols before editing. Stop if safety plumbing restored by Plan 001 is absent.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-recover-trustworthy-baseline.md`
- **Category**: correctness, architecture, tests
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Single runnable tasks currently execute in the main working tree because isolation is enabled only when `runnable.length > 1`. Changed-file attribution observes only `edit` and `write`, so Bash edits can be missed; an empty file list can then broaden diff/commit behavior. Failed and canceled main-tree attempts can leave residue that later tasks inherit. This plan makes each attempt an isolated transaction and makes Git, not tool telemetry, authoritative.

## Current state

- `src/workflow.ts` and `src/index.ts` both calculate `const isolateBatch = config.useWorktrees && runnable.length > 1`.
- `src/runner.ts:touchedFile()` accepts only `tool_execution_start` for `edit` and `write`.
- `src/workflow.ts` captures a main-tree diff using recorded touched paths.
- `reviewTask()` may call `commitAll()` with `undefined` when the touched list is empty, which means broad commit behavior.
- `src/worktree.ts` already provides create, capture, commit, serialized merge, cleanup, and recovery primitives. Extend these rather than building another Git layer.
- Tests use Node’s built-in test runner and temporary Git repositories; follow `test/worktree.test.ts` and `test/workflow.test.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Focused tests | `node --import=tsx --test test/runner.test.ts test/workflow.test.ts test/worktree.test.ts test/board.test.ts test/index.test.ts` | all pass |
| Full gate | `pnpm run check` | exit 0 |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**:
- `src/runner.ts`
- `src/workflow.ts`
- `src/worktree.ts`
- `src/board.ts`
- `src/types.ts`
- `src/index.ts`
- corresponding tests listed in the drift command

**Out of scope**:
- Tool consolidation and event-driven wakeups
- Stall watchdog
- Review finding ledger
- Run-level integration worktree
- New dependencies
- Automatic Git stash/reset of user work

## Git workflow

- Do not commit unless separately requested.
- Never run destructive cleanup against the user’s main working tree.
- Test Git behavior only in temporary repositories.

## Steps

### Step 1: Centralize worktree selection and always isolate when enabled

Remove the duplicated “only when batch size > 1” decision from `src/index.ts` and `src/workflow.ts`. Introduce one readable helper in the workflow/worktree boundary that:

- reuses the latest recoverable worktree for `changes_requested`
- creates a new worktree for every execution attempt when `useWorktrees` is true, including one task
- returns no worktree only when the user explicitly disabled worktrees
- cleans newly created worktrees if batch setup fails before launch

Do not add a generic abstraction beyond this proven duplication.

**Verify**: add tests showing one runnable task executes in a managed worktree in both manual targeted execution and autonomous drive paths.

### Step 2: Make Git authoritative for changed files

Add a focused function in `src/worktree.ts` that returns normalized changed paths from Git status/diff for an attempt checkout. It must include:

- tracked unstaged changes
- staged changes
- untracked files
- changes produced through Bash or scripts

Use the attempt checkout as the boundary. Keep `touchedFile()` only as live telemetry if useful; do not use it for approval, diff scope, or commit scope.

For worktree attempts, calculate changed paths after the executor settles. For explicitly non-isolated main-tree mode, capture a baseline status/HEAD and refuse attribution if pre-existing changes make the attempt’s ownership ambiguous.

**Verify**: tests create edits via direct filesystem/Bash-equivalent writes and assert they appear without `edit`/`write` events.

### Step 3: Eliminate empty-list broad commits

Change commit/integration APIs so callers must explicitly choose either:

- a non-empty list of owned files, or
- the isolated task worktree as the complete transaction boundary.

An empty owned-file list must mean “no task changes,” never “commit all repository changes.” If a code-changing task reports success with no diff, deterministic validation should reject it before LLM review unless its brief explicitly permits no-op completion.

**Verify**: regression test with unrelated dirty file plus empty attempt diff proves unrelated content is never committed.

### Step 4: Preserve failed artifacts without integrating them

On failed, canceled, cost-capped, or stalled outcomes:

- never merge the worktree
- persist worktree/branch metadata when recoverable work exists
- classify it as recoverable in diagnostics
- remove it only through existing confirmed cleanup or when it contains no recoverable work

A retry after reviewer changes may reuse the worktree; an unrelated successor must start clean from the integration baseline.

**Verify**: tests for failed and canceled attempts assert main HEAD and main working tree are unchanged while recoverable metadata remains.

### Step 5: Add approval provenance and integration state

Extend task/attempt metadata minimally with:

- `approvalKind`: `reviewed` or `manual`
- reviewed patch hash or executor commit
- integrated commit when review merge succeeds
- verification summary/reference

Do not mark a task `approved` from automated review until merge and post-merge targeted verification succeed. Manual dashboard approval remains possible but must store `approvalKind: "manual"` and render distinctly.

If a merge fails, retain `changes_requested`/integration-failed state and worktree metadata; do not record reviewer rejection.

**Verify**: tests distinguish reviewed approval, manual acceptance, merge failure, and missing artifact.

### Step 6: Add deterministic protected-test and scope gates

Before launching a reviewer, reject mechanically when:

- expected code task has no diff
- protected/existing tests are deleted without the brief explicitly naming deletion
- test discovery/config is narrowed
- conflict markers exist
- changed paths cannot be attributed
- required verification command failed

Keep rules simple and inspect actual Git changes. Return concise actionable notes through the existing changes-requested path without spending reviewer tokens.

**Verify**: a fixture that deletes a regression test and source behavior must fail even though the remaining test suite passes.

### Step 7: Verify integrated behavior

Run focused tests, full checks, and inspect the diff for accidental board/API changes.

**Verify**:

```bash
node --import=tsx --test test/runner.test.ts test/workflow.test.ts test/worktree.test.ts test/board.test.ts test/index.test.ts
pnpm run check
git diff --check
```

## Test plan

Add coverage for:

- one task with worktrees enabled is isolated
- multiple tasks remain isolated
- Bash/filesystem-created changes are attributed
- staged, unstaged, and untracked files are included
- pre-existing main-tree dirt blocks ambiguous non-isolated execution
- empty changed set never commits unrelated files
- failed/canceled/cost-capped attempts do not alter main
- recoverable failed work is preserved
- reviewed approval records artifact and integration commit
- manual approval is visibly distinct
- merge failure never becomes approved
- deleted safety test is rejected mechanically

## Done criteria

- [ ] Every task is isolated whenever `useWorktrees` is true.
- [ ] Git-derived paths drive diff, review scope, and integration.
- [ ] Empty changed paths cannot broaden commits.
- [ ] Failed/canceled work never enters main.
- [ ] Automated approval requires successful integration and verification.
- [ ] Manual acceptance records explicit provenance.
- [ ] Protected-test deletion gate exists and is tested.
- [ ] Focused and full checks pass.
- [ ] No out-of-scope files changed.

## STOP conditions

- Always-isolated worktrees cannot coexist with current recovery semantics without deleting recoverable user work.
- Git attribution requires a new dependency.
- Approval provenance requires a board format migration that cannot remain backward-compatible with existing optional fields.
- Post-merge verification would require running arbitrary untrusted commands not already present in a task brief/config.
- Any solution uses `git reset --hard`, automatic stash, or broad cleanup on the user’s tree.

## Maintenance notes

Tool telemetry remains useful for UI activity but is not an ownership boundary. Reviewers should scrutinize all paths where an empty array becomes `undefined`, because that caused broad behavior previously. Keep new board fields optional for legacy boards and validate them in `isBoard()`/tests.
