# Plan 015: Add a deterministic plan simulator and compact efficiency report

> **Executor instructions**: This is a human command/internal report, not a new model tool. Reuse scheduler/config/format logic; do not duplicate execution policy.
>
> **Drift check**: `git diff --stat -- src/board.ts src/workflow.ts src/config.ts src/format.ts src/index.ts src/diagnostics.ts test/board.test.ts test/workflow.test.ts test/format.test.ts test/index.test.ts README.md`
> Planned at `41b6057`; dirty-diff checksum `5d86f382a96852fbe76fffc44b0afff54e4e8f78e91fcbede7e0c850b8bb0275`.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/010-durable-drive-decisions.md`, `plans/011-artifact-contract-gates.md`, `plans/013-config-validation-doc-truth.md`
- **Category**: direction, dx, performance
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Users currently discover dependency waves, write conflicts, unavailable tiers, and cost policy only after starting a drive. The board and scheduler already contain nearly all necessary pure logic. A simulation plus neutral outcome accounting improves plans and model/cost tuning without spawning agents.

## Current state

- `validatePlan()` checks dependencies, cycles, tiers, and declared overlap.
- `driveBoard()` computes runnable waves but mixes calculation and side effects.
- Attempts already record usage, provider/model, failures, reviews, and conflicts.
- Exactly three model tools must remain.

## Scope

**In scope**: listed files and tests.

**Out of scope**: predictive AI estimates, external telemetry, databases, dashboards with charts, new model tool.

## Steps

### Step 1: Extract a pure next-wave calculation

Create a pure scheduler function used by both `driveBoard()` and simulation. Given board/config/scope, return runnable IDs, reviewable IDs, blockers, overlap errors, caps, and terminal reason. Preserve current execution behavior with characterization tests.

### Step 2: Simulate dependency waves

Add human `/maestro simulate [taskIds]`. Repeatedly apply hypothetical successful execute/review transitions to report wave order, maximum concurrency, unresolved blockers, declared conflicts, selected tiers/models, and cap warnings. It must perform no board writes, Git operations, or child launches.

### Step 3: Add compact neutral accounting

At completion and in `/maestro costs`, summarize total spend, reviewed-integrated spend, reviewer-rejection spend, provider-failure spend, stalled/cost-capped/aborted spend, attempts, raw launches, conflict repairs, watchdog steers, decision wakeups, and handoffs. Label categories neutrally; do not call all unsuccessful spend waste.

### Step 4: Bound output and test

Cap tasks/waves/categories and provide an archive/log reference for omitted detail. Test empty, legacy, mixed outcomes, scoped simulation, invalid plans, overlap, budget cap, and no mutation.

## Done criteria

- [ ] Simulation and live drive share scheduler logic.
- [ ] Simulation starts zero children and writes no board/Git state.
- [ ] Reports are bounded and deterministic.
- [ ] No fourth model tool exists.
- [ ] Full checks pass.

## STOP conditions

- Accurate simulation would require guessing executor success or token cost.
- Extraction changes live scheduling behavior without characterization coverage.
- Output requires storing a second analytics database.

## Maintenance notes

Simulation predicts mechanics, not success or exact cost. Keep that disclaimer in output and docs.