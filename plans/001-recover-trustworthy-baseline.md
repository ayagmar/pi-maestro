# Plan 001: Recover a trustworthy baseline without losing intended work

> **Executor instructions**: Follow this plan step by step using normal repository tools. Do not invoke pi-maestro. Preserve the current patch before changing it. Run every verification command. If a STOP condition occurs, stop and report instead of improvising. Update this plan’s row in `plans/README.md` when complete.
>
> **Drift check (run first)**: `git rev-parse --short HEAD && git status --short && git diff --stat -- README.md src/index.ts src/prompts.ts test/index.test.ts`
> Expected starting commit is `41b6057`. The four listed source/test files are expected to be dirty. Any additional dirty source file is a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug, tests
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

The current uncommitted patch combines intended attempt-cap successor guidance with removal of concurrency, dispatch recovery, retention wiring, log-cap wiring, and regression tests. The suite remains green partly because tests protecting removed behavior are also deleted. More work on this state risks committing a silent rollback and makes later plans impossible to verify.

## Current state

Expected dirty files:

- `README.md` — adds detailed capped-predecessor successor guidance.
- `src/prompts.ts` — adds the same guidance to orchestrator and supervisor briefings.
- `src/index.ts` — adds attempt-cap guidance but also removes `replaceBoard`, `sweepDispatchState`, retention callbacks, and log-cap review wiring.
- `test/index.test.ts` — adds capped-task recovery coverage but removes handoff and dispatch-lease regressions.

Known load-bearing committed behavior to retain:

- `src/index.ts` imports and invokes `replaceBoard()` for revision-checked whole-board replacement.
- `src/index.ts` invokes `sweepDispatchState()` during `session_start`.
- Drive/review options pass log retention and liveness callbacks into workflow code.
- `test/index.test.ts` contains handoff stale-context and startup dispatch recovery regressions from commits `1db176b` and `7f4067a`.
- `src/workflow.ts` at HEAD contains capped-predecessor snapshot guidance fixed by `41b6057`.

The board is not a source of truth for this recovery. T22 is marked approved although its recorded launches ended in rejection/provider failure/cost cap/user abort, and automatic tier escalation is absent from current source.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Preserve patch | `git diff -- README.md src/index.ts src/prompts.ts test/index.test.ts > /tmp/pi-maestro-pre-recovery.patch` | non-empty file outside repo |
| Inspect removals | `git diff --unified=20 -- src/index.ts test/index.test.ts` | shows intended and unintended hunks |
| Baseline tests | `pnpm run check` | exit 0 before and after recovery |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**:
- `README.md`
- `src/index.ts`
- `src/prompts.ts`
- `src/board.ts`
- `src/config.ts`
- `src/runner.ts`
- `src/settings-ui.ts` and `src/diagnostics.ts` only where needed to restore the existing log configuration surface
- `src/types.ts`
- `src/workflow.ts`
- focused tests for those modules, including `test/index.test.ts`, `test/board.test.ts`, `test/config.test.ts`, `test/runner.test.ts`, `test/settings-ui.test.ts`, `test/diagnostics.test.ts`, and `test/workflow.test.ts`
- `.pi/maestro/board.json` only through Maestro board operations; do not edit it directly

The expanded scope is intentional remediation after the first adversarial review proved that the baseline regressions cross the original four-file boundary. It does not authorize unrelated feature work.

**Out of scope**:
- Implementing automatic tier escalation
- New orchestration features beyond wiring the already-present dispatch lease functions into production execute/review paths
- Dependency or Biome migrations
- Release metadata
- Deleting stashes, archives, logs, branches, or worktrees

## Git workflow

- Work on the current branch unless the operator asks for a branch.
- Do not use a blanket `git checkout --` or `git reset --hard`; those would destroy intended hunks.
- Restore individual committed blocks by comparing `git show HEAD:<path>` with the working file.
- Do not commit unless the operator separately requests it.

## Steps

### Step 1: Preserve and classify every current hunk

Save the patch to `/tmp/pi-maestro-pre-recovery.patch`. Produce a short checklist mapping every hunk to either:

- intended capped-task successor guidance, or
- accidental safety/test rollback.

The intended behavior must say that a capped predecessor cannot run again, a successor must be created, downstream dependencies rewired, and drive scoped to successor/dependents.

**Verify**: `test -s /tmp/pi-maestro-pre-recovery.patch` → exit 0.

### Step 2: Restore safety plumbing while retaining capped-task guidance

In `src/index.ts`, restore the committed implementations for:

- `replaceBoard` import and revision-checked use in new-goal and clear flows
- `sweepDispatchState` import and startup invocation
- drive `isLive` and `onRetentionWarning` options
- review `logEvents`, `maxLogBytes`, `isLive`, and retention warning options

Retain the new attempt-cap decision text if it is consistent with `src/workflow.ts` at HEAD.

**Verify**:

```bash
rg -n "replaceBoard|sweepDispatchState|maxLogBytes|onRetentionWarning|isLive" src/index.ts
```

Expected: each safety concept has active call-site matches, not only imports.

### Step 3: Restore deleted regression tests without losing the new one

Compare `test/index.test.ts` against `git show HEAD:test/index.test.ts`. Restore all deleted handoff, stale-context, session replacement, and dispatch-lease tests. Keep the new capped-task successor/scoped-drive test if it tests real current behavior.

Do not preserve duplicate tests that assert the same path identically; preserve distinct failure-mode coverage.

**Verify**:

```bash
rg -n "active dispatch lease|handoff replaces|invalidated command context|capped-task recovery" test/index.test.ts
```

Expected: all four concepts are covered.

### Step 4: Reconcile docs and prompt guidance

Keep capped-task recovery wording concise and identical in semantics across `README.md`, `src/prompts.ts`, and `formatDrivePulse()`.

Do not claim automatic tier escalation or any feature absent from source. Do not add more workflow rules than needed for the capped successor behavior.

**Verify**:

```bash
rg -n "capped predecessor|scoped.*drive|successor" README.md src/prompts.ts src/index.ts
```

Expected: guidance exists in all three surfaces and does not recommend rerunning the capped predecessor.

### Step 5: Restore the complete log configuration path

Restore the existing log controls end to end rather than only at individual call sites:

- `DEFAULT_CONFIG` and every preset define `logEvents: "compact"` and the established per-run byte cap.
- `mergeConfig()`, `describeConfig()`, settings UI, and diagnostics preserve/report both values.
- executor and review workflow options pass both values to `startExecutor()`.
- `startExecutor()` filters compact/full events and applies the byte cap without affecting outcome parsing.
- zero byte cap retains the documented unlimited behavior.

Add focused regression assertions at configuration, workflow, and runner boundaries.

**Verify**:

```bash
rg -n "logEvents|maxLogBytesPerRun|maxLogBytes" src/config.ts src/settings-ui.ts src/diagnostics.ts src/workflow.ts src/runner.ts
node --import=tsx --test test/config.test.ts test/settings-ui.test.ts test/diagnostics.test.ts test/workflow.test.ts test/runner.test.ts
```

Expected: active production wiring exists at every layer and focused tests pass.

### Step 6: Wire dispatch leases into production execution and review

Use the existing `claimTaskDispatch()`, `renewTaskDispatch()`, and release/finalization primitives from `src/board.ts` in actual execute and review launch paths. Requirements:

- claim atomically before spawning
- reserve exactly one attempt for execute
- decline peer-owned duplicate dispatch without launching
- renew while the child run remains live
- release/finalize in `finally` on success, rejection, provider failure, abort, cost cap, and synchronous spawn failure
- never let a stale owner overwrite a newer claim
- startup sweep preserves unexpired live claims and recovers only expired/orphaned work

Do not create a second lease implementation in workflow code.

**Verify**:

```bash
rg -n "claimTaskDispatch|renewTaskDispatch" src/workflow.ts
node --import=tsx --test test/board.test.ts test/workflow.test.ts test/index.test.ts
```

Expected: both execute and review production paths are covered and duplicate dispatch tests prove only one child launch.

### Step 7: Verify restored behavior, not just a green aggregate suite

Run focused tests first, then the full gate. Record test count before and after; the recovered suite must not contain fewer tests than HEAD solely because tests were removed.

**Verify**:

```bash
node --import=tsx --test test/index.test.ts test/retention.test.ts test/workflow.test.ts test/runner.test.ts
pnpm run check
git diff --check
```

Expected: all exit 0.

## Test plan

Preserve or add focused regressions for:

- active dispatch lease survives startup recovery
- expired dispatch state is reclaimed
- handoff uses only fresh replacement context after teardown
- pre-replacement failure does not use stale UI/context
- run/review options receive configured log cap and retention callbacks
- capped predecessor is excluded from successor scoped drive
- downstream dependency rewiring preserves unrelated dependencies

Use the existing dependency-injected `loadMaestro()` harness in `test/index.test.ts`.

## Done criteria

- [ ] `/tmp/pi-maestro-pre-recovery.patch` exists and preserves the original dirty patch.
- [ ] Intended capped-task guidance remains.
- [ ] `replaceBoard()` is used for whole-board replacement.
- [ ] startup dispatch recovery is active.
- [ ] retention and log-cap options are wired through drive and review paths.
- [ ] deleted safety tests are restored.
- [ ] focused tests pass.
- [ ] `pnpm run check` passes.
- [ ] `git diff --check` passes.
- [ ] No out-of-scope files changed.

## STOP conditions

- HEAD is no longer `41b6057` and the expected dirty hunks cannot be mapped safely.
- Additional dirty source files exist beyond the four expected files and `plans/`.
- The intended capped-task behavior conflicts with committed `src/workflow.ts` tests.
- Fixing either reviewed regression requires behavior beyond restoring log controls or wiring the already-present dispatch lease API.
- A command would destroy stashes, logs, worktrees, or unpreserved user work.

## Maintenance notes

A green suite is not sufficient when the patch deletes the tests defining the safety contract. Review this recovery by inspecting the test diff and confirming no load-bearing scenarios disappeared. Board cleanup should happen only after the code baseline is reconciled.
