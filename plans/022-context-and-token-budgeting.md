# Plan 022: Budget every model-facing context and eliminate repeated orchestration prose

> **Executor instructions**: Use normal tools only. Do not invoke Maestro, add dependencies, commit/push/release, or change versions/changelog. Preserve behavior and quality: never save tokens by omitting blockers, success criteria, open findings, or verification failures.
>
> **Drift check (run first)**: `git rev-parse --short HEAD && git diff | sha256sum && git diff --stat -- src/prompts.ts src/workflow.ts src/format.ts src/runner.ts src/types.ts test/prompts.test.ts test/workflow.test.ts test/format.test.ts README.md`
> Planned at `41b6057`, dirty checksum `af3a7b4605d23a5d25baa57deb3f9bf6e47f244b19344958b6a402dcf455d473`.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/020-pure-core-composition-boundaries.md`, `plans/021-plan-quality-and-execution-contracts.md`
- **Category**: perf, cost, tests
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Maestro's product promise is that the expensive orchestrator spends tokens on judgment, while fresh executors receive only sufficient task context. Prompt fragments, dependency reports, findings, diffs, drive decisions, and repeated retries currently have independent caps rather than one observable budget. Introduce deterministic context accounting and deduplication without weakening execution or review quality.

## Current state

- `src/prompts.ts` bounds injected context globally and formats executor/reviewer/supervisor briefings.
- Dependency reports may include final reports and session references.
- Review retries carry notes/findings; repeated instructions are rendered in multiple briefings.
- Routine progress stays out of model context and decisions are bounded to 4,000 characters.
- Attempt usage records tokens/cost, but prompt-section sizes are not observable.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import=tsx --test test/prompts.test.ts test/workflow.test.ts test/format.test.ts` | all pass |
| Complete | `pnpm run check` | exit 0 |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**: prompt composition, deterministic context accounting, dependency/report compaction, bounded status/decision formatting, tests and README.

**Out of scope**: semantic compression by another model, hidden chain-of-thought parsing, prompt caching APIs, telemetry databases, reducing verification/review coverage.

## Steps

### Step 1: Inventory model-facing payloads

Add pure section builders that return named sections before joining: contract, task brief, criteria, dependencies, prior findings, artifact summary/diff, verification, stop rules, and output contract. Measure characters and approximate tokens deterministically for diagnostics only.

**Verify**: tests snapshot section names/order and prove the final prompt remains under its configured hard cap.

### Step 2: Allocate priority-based budgets

Define stable priority: task contract/criteria and open blockers first; verification failures next; dependency conclusions next; artifact diff excerpts next; historical clean detail last. Truncate within sections, never by slicing the final prompt across structural boundaries. Emit explicit omission markers with session/log references.

**Verify**: oversized fixtures retain every criterion and blocker while truncating low-priority history/diff.

### Step 3: Deduplicate retries and dependency context

On retries, include only unresolved findings plus the latest relevant failure evidence; do not repeat verified findings or unchanged dependency prose. Dependency reports should carry a bounded outcome summary and authoritative artifact/session reference, not entire repeated reports.

**Verify**: second/third retry prompt size remains approximately stable and contains no duplicate finding fingerprints.

### Step 4: Minimize orchestrator wakeups

Audit every `sendMessage`/`triggerTurn` path. Routine progress must cause zero wakeups; one unresolved decision or completion causes one owner-scoped wakeup. Inspect remains on-demand and mechanical. Consolidate repeated recovery prose into structured decision fields rendered once.

**Verify**: behavioral tests capture message APIs and assert zero routine, one decision, one completion, no reload duplicate.

### Step 5: Expose context diagnostics

Add human-only `/maestro costs` or `/maestro doctor` lines for last prompt section sizes, omitted sections, turns, and model cost when available. Store only compact counters/references in attempts; no raw duplicate prompt database.

**Verify**: bounded output tests and legacy attempts pass.

### Step 6: Full gate and measured comparison

Create fixed large fixtures and record before/after prompt lengths in tests. Require meaningful reduction for repeated retries/dependency-heavy tasks while preserving mandatory content.

**Verify**: `pnpm run check && git diff --check` exits 0; fixture assertions pass.

## Test plan

- Maximum-size brief, 12 criteria, eight dependencies, 16 findings, large diff.
- Retry 1–3 size stability and deduplication.
- Mandatory blocker/criterion retention under cap.
- Routine progress versus decision/completion message counts.
- Legacy attempts without context accounting.

## Done criteria

- [x] Every model-facing payload has named bounded sections.
- [x] Mandatory quality evidence survives truncation.
- [x] Repeated retries do not grow context linearly.
- [x] Routine progress consumes no orchestrator turn.
- [x] Human diagnostics expose compact context/cost accounting.
- [x] Full checks pass and row is DONE.

## STOP conditions

- Token reduction would omit an acceptance criterion, open blocker, or failed verification.
- Accurate accounting would require provider-specific tokenizers or a dependency.
- A message reduction delays a required human/orchestrator decision.

## Maintenance notes

Every new prompt section must declare priority, hard cap, omission marker, and test coverage.
