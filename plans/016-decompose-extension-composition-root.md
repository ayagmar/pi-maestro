# Plan 016: Decompose the extension composition root without changing behavior

> **Executor instructions**: This is a behavior-preserving cleanup after the safety plans. Move code only after characterization tests pass. Do not redesign APIs or add framework abstractions.
>
> **Drift check**: `git diff --stat -- src/index.ts src/types.ts test/index.test.ts src/*.ts test/*.test.ts`
> Planned at `41b6057`; dirty-diff checksum `5d86f382a96852fbe76fffc44b0afff54e4e8f78e91fcbede7e0c850b8bb0275`.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/009-restore-three-tool-regressions.md`, `plans/010-durable-drive-decisions.md`, `plans/015-plan-simulator-efficiency-report.md`
- **Category**: tech-debt, architecture
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

`src/index.ts` is 2,082 lines and the highest-churn file in recent history. It combines tool schemas, runtime drive state, slash commands, handoff/session safety, UI glue, and renderers. Small changes have broad conflict and regression risk; four concrete modules can reduce it without a framework.

## Current state

- `src/index.ts` is the extension factory and shared closure owner.
- `src/workflow.ts`, `board.ts`, and `runner.ts` already provide domain boundaries.
- Session replacement must remain command-context-only and use fresh contexts.
- Tests depend on `loadMaestro()` injection and exact three-tool registration.

## Scope

**In scope**: `src/index.ts`; new focused modules under `src/`; affected tests and boundary tests.

**Out of scope**: changing tool/command behavior, state library, dependency injection container, event bus framework, public package API redesign.

## Steps

### Step 1: Freeze behavior

Ensure Plan 009 tests cover tools, drive ownership, commands, decision delivery, handoff stale-context safety, dashboard actions, and cleanup. Record exact registered tools/commands.

### Step 2: Extract pure model tool registration

Move schemas/renderers/execution adapters for plan/update/drive to `src/tools.ts` (or equally clear name). Pass a small explicit runtime interface; do not expose all extension internals.

### Step 3: Extract drive controller

Move background/active/paused drive ownership, durable decision coordination, and cleanup completion into `src/drive-controller.ts`. It may own mutable drive state; `index.ts` should not mirror it.

### Step 4: Extract command and handoff registration

Move human slash command dispatch to `src/commands.ts` and session replacement to `src/handoff.ts`. Keep `newSession()` reachable only through `ExtensionCommandContext`. Capture only serializable data before replacement.

### Step 5: Leave a readable composition root

`index.ts` should construct dependencies, register tools/commands/events/renderers, and coordinate shutdown. Target readability, not a line-count contest. Remove dead helpers/exports uncovered by extraction.

### Step 6: Verify boundaries

Update `test/boundaries.test.ts` so board persistence remains in board, child processes remain runner/worktree, and command contexts own session replacement. Run full suite twice.

## Done criteria

- [ ] `index.ts` is a skimmable composition root with no duplicated runtime state.
- [ ] Exactly three tools and existing human commands remain.
- [ ] Handoff stale-context tests pass unchanged in meaning.
- [ ] No new dependency or generic framework.
- [ ] Full checks pass twice with stable count.

## STOP conditions

- Extraction requires behavior changes not covered by prior plans.
- Circular imports appear between tools, commands, and controller.
- A proposed abstraction has only one caller and makes local logic harder to read.

## Maintenance notes

Prefer explicit parameter objects over service locators. Future features should land in the narrow owning module, with `index.ts` only wiring them.