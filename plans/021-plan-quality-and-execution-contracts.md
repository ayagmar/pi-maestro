# Plan 021: Make plans mechanically complete before any task can run

> **Executor instructions**: Use normal tools only. Preserve user work. Do not invoke Maestro, add dependencies, commit/push/release, or change versions/changelog. Plan 020 must be DONE so policy lands in the pure core.
>
> **Drift check (run first)**: `git rev-parse --short HEAD && git diff | sha256sum && git diff --stat -- src/board.ts src/tools.ts src/commands.ts src/prompts.ts src/workflow.ts src/types.ts test/board.test.ts test/index.test.ts test/prompts.test.ts test/workflow.test.ts README.md`
> Planned at `41b6057`, dirty checksum `af3a7b4605d23a5d25baa57deb3f9bf6e47f244b19344958b6a402dcf455d473`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/020-pure-core-composition-boundaries.md`
- **Category**: direction, correctness, dx
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Maestro's quality ceiling is set before execution: tasks need enough context, explicit success criteria, safe write scope, dependency closure, and trusted verification selection. Today most of that lives in prose briefs and optional conventions. Strengthen the existing task contract without adding broad planning metadata or new model tools.

## Current state

- `maestro_plan` requires title, brief, tier, and `writePaths`; dependency and verification profile are optional.
- `validatePlan()` checks references, cycles, tiers, and write overlaps.
- Executor prompt expects success criteria and verification instructions embedded in free-form brief.
- `/maestro simulate` predicts mechanical waves but not all reasons a scoped drive will stall.
- Program decision: do not add `readPaths`, risk matrices, or a policy DSL.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import=tsx --test test/board.test.ts test/index.test.ts test/prompts.test.ts test/workflow.test.ts` | all pass |
| Complete | `pnpm run check` | exit 0 |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**: task/plan validation, three-tool plan/update adapters, simulation, planning/executor prompts, plan editor/README, tests.

**Out of scope**: more model tools, arbitrary commands, `readPaths`, risk DSL, AI quality prediction, auto-generating implementation code.

## Steps

### Step 1: Define a minimal executable task contract

Keep the task schema compact. Add explicit bounded `successCriteria: string[]` (1–12 items) rather than requiring criteria to be parsed from prose. Preserve legacy tasks without it, but new `maestro_plan` tasks require it unless explicitly read-only investigation. Keep `brief` self-contained and `writePaths` required.

**Verify**: schema and runtime validation reject missing/empty/oversized criteria without mutating the board; legacy boards load.

### Step 2: Validate dependency closure and scoped execution

Add a pure check that a requested scoped drive contains every selected task's unresolved dependency path or clearly reports which dependencies are intentionally outside scope and why execution will block. Do not silently expand scope. Surface this in `maestro_drive start`, `/maestro simulate`, and plan approval.

**Verify**: scoped simulations for complete/incomplete dependency closure are deterministic and board-read-only.

### Step 3: Strengthen write scheduling diagnostics

Report exact overlap pairs, dependency direction that serializes them, and unscoped legacy tasks. Require users/models to migrate legacy missing scopes before autonomous dispatch, while preserving manual inspection/reconciliation.

**Verify**: overlap and legacy fixtures launch zero executors and produce bounded actionable diagnostics.

### Step 4: Bind criteria to review and verification

Render criteria as stable numbered items in executor and reviewer prompts. Reviewer must report criterion-level pass/fail evidence in bounded form; mechanical verification results remain authoritative where configured. Do not ask the orchestrator to reread raw transcripts.

**Verify**: prompt tests prove every criterion appears once, bounded; behavioral review tests persist failed criterion findings.

### Step 5: Improve plan editing and import/export preparation

Update human plan editor/list output to show criteria, write scope, dependency closure, and verification profile. Add a versioned pure JSON serialization format for the board's plan portion only, with validation before import; expose as human commands, not tools. Import must archive or ask before replacing non-empty work and never execute.

**Verify**: round-trip, malformed, cycle, unknown profile, and non-empty-board tests pass; no child starts.

### Step 6: Full gate

**Verify**: `pnpm run check && git diff --check` exits 0.

## Test plan

- Minimal valid task, missing criteria, bounded limits, investigation exception.
- Legacy board compatibility and autonomous-dispatch refusal until migrated.
- Scoped dependency closure, overlaps, invalid profile.
- Criterion propagation to executor/reviewer and structured findings.
- Plan export/import round trip and safe non-empty handling.

## Done criteria

- [ ] Every new executable task has explicit success criteria and write scope.
- [ ] Scoped drives explain incomplete dependency closure before launch.
- [ ] Reviewer evidence maps to criteria without raw transcript injection.
- [ ] Plan import/export is versioned, validated, human-only, and non-destructive.
- [ ] Exactly three model tools remain.
- [ ] Full checks pass and row is DONE.

## STOP conditions

- The contract requires adding broad metadata beyond criteria, scope, dependencies, tier, and verification profile.
- Import would overwrite a non-empty board without explicit human approval/archive.
- Review evidence cannot remain bounded without dropping criterion failures.

## Maintenance notes

Task contract additions must update schema, runtime validation, editor, serialization, prompts, simulation, README, and tests together.
