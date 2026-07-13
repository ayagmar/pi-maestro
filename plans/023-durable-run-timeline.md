# Plan 023: Provide one durable, bounded run timeline and status model

> **Executor instructions**: Use normal tools only. Do not invoke Maestro, add a database/dependency, commit/push/release, or change versions/changelog. Derive from existing board, attempts, status history, decisions, and archives. Preserve owner scoping and bounded output.
>
> **Drift check (run first)**: `git rev-parse --short HEAD && git diff | sha256sum && git diff --stat -- src/types.ts src/board.ts src/drive-controller.ts src/format.ts src/commands.ts src/dashboard.ts src/diagnostics.ts test/board.test.ts test/index.test.ts test/dashboard.test.ts test/format.test.ts README.md`
> Planned at `41b6057`, dirty checksum `af3a7b4605d23a5d25baa57deb3f9bf6e47f244b19344958b6a402dcf455d473`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/020-pure-core-composition-boundaries.md`, `plans/021-plan-quality-and-execution-contracts.md`
- **Category**: direction, observability, dx
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Maestro persists rich evidence but users must reconstruct a run across board JSON, attempts, history JSONL, sessions, logs, decisions, and worktrees. A single derived timeline makes stalls, retries, review outcomes, verification, integration, costs, and recovery understandable without waking a model or adding analytics storage.

## Current state

- `src/board.ts` stores board and status history; archives retain completed boards.
- Attempts contain launches, usage, models/providers, findings, sessions, and artifact references.
- Board has one durable active decision with owner, delivery, and resolution.
- Dashboard shows current state and transcript, not a chronological run narrative.
- `/maestro costs`, `/maestro history`, `/maestro reconcile`, and doctor expose separate slices.
- Program decision: no second analytics database or chart framework.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import=tsx --test test/board.test.ts test/index.test.ts test/dashboard.test.ts test/format.test.ts test/diagnostics.test.ts` | all pass |
| Complete | `pnpm run check` | exit 0 |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**: pure timeline derivation/formatting, human command/dashboard status view, existing persisted metadata where a compact missing timestamp/reference is essential, tests/docs.

**Out of scope**: database, charts, raw transcript duplication, new model tool, external telemetry, predictive scoring.

## Steps

### Step 1: Define a normalized derived event shape

Create a pure `RunTimelineEvent` union with timestamp, task/run identity, kind, short summary, status/severity, cost/turns when applicable, and optional artifact/session/log reference. Derive events from existing sources; do not persist duplicates. Define stable tie-breaking for equal/missing timestamps and legacy data.

Event kinds should cover plan/gate, dispatch, execute settlement, provider fallback, watchdog steer/stall, review result, finding, candidate verification, merge/conflict, integrated verification, approval/manual acceptance, durable decision delivery/resolution, pause/resume/abort, and cleanup/archive.

**Verify**: pure fixture tests produce deterministic order and bounded summaries.

### Step 2: Add human timeline commands

Add `/maestro timeline [taskId]` and optional archive/run selector consistent with existing archive safety. Default output is compact and capped; provide exact session/log/archive references for omitted detail. Unknown IDs and corrupt history are actionable, not fatal.

**Verify**: command tests prove no board writes, no child launches, task filtering, archive filtering, and bounded output.

### Step 3: Unify current status language

Create one pure status projection used by footer, dashboard, inspect, doctor, and command summaries: phase, owner, runnable/reviewable/blocked counts, active executions, latest progress, unresolved decision, budget/cap state, and recovery action. Remove divergent labels that describe the same state differently.

**Verify**: cross-surface tests assert the same underlying status code and owner/recovery semantics.

### Step 4: Add dashboard timeline mode

Add a human keyboard action to switch the selected pane between transcript and timeline. Preserve existing controls and constrained-height behavior. Timeline reads persisted state; it must not poll a model or inject context.

**Verify**: dashboard rendering/input tests cover narrow and short terminals.

### Step 5: Add neutral efficiency accounting

Derive raw launches, consumed attempts, reviewed-integrated spend, provider-failure spend, reviewer-rejection spend, stalled/cost-capped/aborted spend, conflict repairs, decisions, and handoffs. Label categories neutrally and avoid calling all unsuccessful spend waste.

**Verify**: mixed legacy/current fixtures sum exactly once and match total cost.

### Step 6: Full gate

**Verify**: `pnpm run check && git diff --check` exits 0.

## Test plan

- Empty/current/archived/corrupt-history boards.
- Equal timestamps and legacy missing timestamps.
- Provider fallback, repeated review, stall, conflict, verification failure, manual approval.
- Owner decision delivery/resolution exactly once.
- Timeline bounds and references to omitted details.
- Dashboard mode and status consistency.

## Done criteria

- [x] One pure timeline derives all important run events without duplicate storage.
- [x] Human command and dashboard expose bounded history.
- [x] Status/recovery semantics agree across surfaces.
- [x] Accounting reconciles to total recorded cost.
- [x] No model wakeup or fourth tool is added.
- [x] Full checks pass and row is DONE.

## STOP conditions

- A useful timeline requires raw transcript persistence or a new database.
- Event derivation cannot avoid double-counting existing sources; STOP and document the ambiguous source before adding fields.
- Dashboard changes remove or conflict with existing recovery controls.

## Maintenance notes

New persisted lifecycle evidence should add one derivation case and fixture, not a second timeline store.
