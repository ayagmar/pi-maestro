# Plan 020: Separate the deterministic orchestration core from Pi adapters and UI

> **Executor instructions**: This is a behavior-preserving structural change protected by Plans 017–019. Use normal tools; do not invoke Maestro, add dependencies, commit/push/release, or modify versions/changelog. Move in small steps and run focused tests after each move.
>
> **Drift check (run first)**: `git rev-parse --short HEAD && git diff | sha256sum && git diff --stat -- src/index.ts src/workflow.ts src/drive-controller.ts src/tools.ts src/commands.ts src/handoff.ts src/session-control.ts test/index.test.ts test/boundaries.test.ts`
> Planned at `41b6057`, dirty checksum `af3a7b4605d23a5d25baa57deb3f9bf6e47f244b19344958b6a402dcf455d473`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/017-review-integration-transaction.md`, `plans/018-authoritative-artifact-provenance.md`, `plans/019-verification-sandbox-and-recovery.md`
- **Category**: tech-debt, architecture, tests
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

`src/index.ts` remains roughly 2,072 lines and owns tool registration, slash dispatch, drive state, decisions, handoff, dashboard integration, renderers, and event hooks. `workflow.ts` is also over 1,300 lines. This makes correctness changes conflict-prone and hides deterministic policy inside side-effectful closures. The target is explicit core/adapters/UI boundaries, not a framework or line-count stunt.

## Current state

- `src/index.ts` — extension factory and most mutable runtime closure state.
- `src/drive-controller.ts` — decision helpers only; despite its name it does not own active/background/paused drive control.
- `src/tools.ts` — drive input validation only; registration remains in `index.ts`.
- `src/commands.ts` — parser/completion constants only; dispatch remains in `index.ts`.
- `src/handoff.ts` — notification helper only; handoff/session replacement remains in `index.ts`.
- `src/workflow.ts` — scheduling, execute, review, integration, simulation, and formatting.
- Existing `test/boundaries.test.ts` enforces process and persistence ownership; extend this style.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Characterization | `node --import=tsx --test test/index.test.ts test/workflow.test.ts test/boundaries.test.ts` | all pass |
| Complete | `pnpm run check` | exit 0 |
| Cycles | `node -e "/* use a small repository-local import scan test, not a new dependency */"` | no forbidden cycle |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**: `src/index.ts`, `src/workflow.ts`, `src/drive-controller.ts`, `src/tools.ts`, `src/commands.ts`, `src/handoff.ts`, `src/session-control.ts`, new narrowly named core/adapter modules, affected tests.

**Out of scope**: behavior changes, state libraries, dependency injection containers, event buses, public package redesign, model tool changes.

## Steps

### Step 1: Freeze public behavior and ownership

Add/confirm characterization for exact three tools, command completion/dispatch, durable decisions, start/pause/resume/abort ownership, stale handoff contexts, cleanup, dashboard actions, simulation, and session events. Add a boundary matrix documenting which layer may import Pi, TUI, board persistence, child processes, and Git.

**Verify**: characterization suite passes before moves.

### Step 2: Extract pure scheduling and policy core

Move pure wave calculation, stop-reason calculation, retry/escalation policy, simulation, and artifact finding calculation into cohesive modules with no Pi/TUI/process imports. `driveBoard()` should orchestrate effects using these outputs rather than recomputing policy.

**Verify**: pure unit tests cover every stop code and scheduling wave; live workflow characterization remains unchanged.

### Step 3: Make drive controller own runtime state

Create one controller instance that owns active drive, background promise/summary/error, pause/abort controller, owner session, decision persistence/delivery, and completed-board cleanup. `index.ts` must not mirror these fields. Expose explicit methods such as start, inspect, pause, resume, abort, settle, and shutdown—only those with current callers.

**Verify**: `rg -n "activeDrive|_backgroundDrive" src/index.ts` has no mutable declarations; ownership tests pass.

### Step 4: Extract complete tool adapters

Move schemas, argument preparation, execution adapters, and renderers for exactly `maestro_plan`, `maestro_update`, and `maestro_drive` to `src/tools.ts` or a small `src/tools/` directory. Pass an explicit narrow runtime interface. Keep human commands out of this module.

**Verify**: exact registration test passes; no fourth model tool.

### Step 5: Extract command and handoff adapters

Move slash command registration/dispatch to `src/commands.ts`; move session replacement and fresh-context handoff to `src/handoff.ts`. Ensure `newSession()` remains reachable only from command-context code. Keep dashboard construction in a UI adapter rather than the core.

**Verify**: stale-context handoff tests pass unchanged in meaning; boundary grep rejects `newSession` in tools/core.

### Step 6: Leave a composition root

`index.ts` should construct dependencies, register tools/commands/events/renderers, and coordinate shutdown. Remove dead helpers and duplicate state. Prefer readable explicit parameter objects over generic service locators.

**Verify**: a reviewer can identify each registration category from top-level factory flow; automated boundary tests pass.

### Step 7: Full gate twice

**Verify**: `pnpm run check && pnpm run check && git diff --check` passes with stable test count.

## Test plan

- Pure policy tests for waves and stop reasons.
- Drive controller owner/decision/reload tests.
- Adapter tests for exact schemas and command routing.
- Boundary tests: core has no Pi/TUI/process/Git imports; only runner/worktree spawn; only command handoff calls `newSession`.
- Existing 240+ behavioral tests remain; do not replace them with registration assertions.

## Done criteria

- [x] `index.ts` is a wiring root, not runtime implementation.
- [x] One drive controller owns all mutable drive state.
- [x] Pure core has no Pi/TUI/process imports.
- [x] Exactly three model tools and all human controls remain.
- [x] No generic framework or dependency added.
- [x] Full suite passes twice and row is DONE.

## STOP conditions

- Extraction requires changing a public behavior not covered by characterization.
- Circular imports appear between core, adapters, and controller.
- A proposed abstraction has one caller and makes local logic less readable; keep that logic local and document the decision.

## Maintenance notes

Future policy belongs in pure core, runtime ownership in controller, Pi schemas in tool adapters, and human UX in command/UI adapters.
