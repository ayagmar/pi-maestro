# Plan 007: Finish context protection, board reconciliation, metrics, and migration documentation

> **Executor instructions**: Execute normally after Plans 001–006 are DONE. This is the integration and truthfulness plan, not an opportunity for unrelated UX work. Update `plans/README.md` when complete.
>
> **Drift check (run first)**: `git diff --stat 41b6057..HEAD -- src/index.ts src/prompts.ts src/format.ts src/diagnostics.ts src/config.ts src/settings-ui.ts src/board.ts src/types.ts test/index.test.ts test/prompts.test.ts test/format.test.ts test/diagnostics.test.ts test/config.test.ts test/board.test.ts README.md`
> Expect substantial intentional drift from earlier plans; compare their done criteria with live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 003, 004, 005, 006
- **Category**: performance, dx, docs
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

After execution, review, and conflict mechanics are safe, Maestro still needs automatic context relay, compact output, truthful reconciliation, and measurable efficiency. These close the loop without adding tools or speculative infrastructure.

## Current state

Before this program:

- context nudge appears at 65% only in UI
- orchestrator polls full-board status
- approval status can outlive or disagree with actual artifacts
- costs are reported, but failed/rejected/stalled/provider spend is not summarized by cause
- global config recently used `$10` per-task and `$50` run caps, high enough to permit another expensive stall
- `.pi/maestro/logs` contains legacy multi-gigabyte logs; retention must remain confirmed and safe

Plans 003–006 should have replaced polling, added artifact provenance, decision events, failure fingerprints, and write scopes. This plan verifies and documents that integrated contract.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Focused | `node --import=tsx --test test/index.test.ts test/prompts.test.ts test/format.test.ts test/diagnostics.test.ts test/config.test.ts test/board.test.ts` | all pass |
| Full | `pnpm run check` | exit 0 |
| Tool count | `rg -n 'name: "maestro_' src/index.ts` | exactly three model tool registrations |

## Scope

**In scope**:
- files listed in drift check

**Out of scope**:
- Automatic deletion of legacy logs without confirmation
- Dependency/Biome upgrade
- Release/version/tag/changelog work
- New model tools
- Run-level integration worktree

## Steps

### Step 1: Implement automatic safe supervisor handoff

Use the existing handoff command as the only session-replacement path. At configurable context usage threshold:

- if drive is mechanically running, mark handoff pending and wait for safe boundary
- if a decision/completion message is pending, persist it first
- queue the handoff command through the documented safe follow-up mechanism
- create fresh supervisor with only goal, unresolved tasks, dependencies, open findings, current costs, and active decision
- never include completed transcripts or full logs by default
- use only fresh replacement context after `newSession()`
- ensure one handoff per threshold crossing/session

Keep a user-visible disable option and retain manual `/maestro handoff`.

**Verify**: threshold, pending-live-run, fresh-context, stale-context, disabled, and repeated-handoff tests.

### Step 2: Bound every model-facing drive result

Decision/completion/inspect output must have explicit character/item limits. Use pi truncation utilities where appropriate and store full diagnostics as file/session references.

Routine TUI updates should use TUI-only entries/widgets and not enter model context. Verification output should return pass/fail, duration, failing command/test names, and a bounded tail; full output remains in an artifact.

**Verify**: synthetic large board/transcript/test output remains within defined limits and includes a reference.

### Step 3: Add board/artifact reconciliation

Add a human command and internal startup/drive check, not a model tool, that reports:

- reviewed approval missing integration commit
- manual acceptance
- integration commit no longer reachable
- required worktree/artifact missing
- task marked approved with no successful reviewed artifact
- unresolved decision whose owner session disappeared
- stale recoverable worktrees/logs using existing diagnostics

Do not automatically rewrite statuses except for narrowly safe stale runtime recovery already established. Provide confirmed repair actions.

**Verify**: fixtures reproduce the historical T22-shaped inconsistency and return an explicit warning rather than “approved.”

### Step 4: Add compact efficiency accounting

At drive completion, calculate:

- total spend
- integrated reviewed spend
- reviewer-rejection spend
- provider-failure spend
- stalled/cost-capped/aborted spend
- attempts and launches
- conflict repairs
- watchdog steers
- orchestrator decision wakeups
- handoffs

Keep output compact and avoid claiming exact “waste” where an unsuccessful attempt produced reusable work. Label categories neutrally.

**Verify**: format tests cover empty, mixed, legacy, and partial usage.

### Step 5: Tune safe defaults and settings

Based on implemented watchdog behavior, choose conservative defaults. Recommended starting values unless tests/data justify others:

- `maxCostPerTask`: 5
- `maxRunCost`: 25
- automatic handoff around 65–70%
- event-driven drive, no polling cadence required for model operation
- compact logs with existing per-run cap

Do not silently overwrite the user’s global config. Defaults/presets and migration docs should guide users; existing explicit values remain respected.

**Verify**: config merge tests show legacy files retain explicit settings and new defaults apply only when absent.

### Step 6: Update README to the final three-tool contract

Rewrite architecture/usage sections to match actual behavior:

- three LLM tools
- state-aware autonomous drive
- event-driven decisions
- deterministic gates
- worktree transaction boundary
- write-path overlap enforcement
- cumulative bounded findings
- watchdog and provider circuit
- automatic/manual handoff
- approval provenance and reconciliation
- human slash/dashboard controls

Remove stale polling instructions and claims not backed by tests. Keep docs concise; do not paste internal state-machine implementation details.

**Verify**: every named configuration key/tool/command is found in source or tests.

### Step 7: Run a program-level regression suite

Add one or two integration-style tests using the existing injected fake executor, covering:

1. plan with disjoint write paths
2. isolated execution
3. deterministic artifact check
4. review rejection with multiple findings
5. retry resolves findings
6. integration and reviewed approval provenance
7. completion wakeup exactly once

Add a second failure test for stall/provider/conflict decision without hot-looping. Keep tests deterministic and local.

**Verify**: full `pnpm run check` passes twice consecutively with identical test count.

### Step 8: Final scope and truth audit

Inspect:

```bash
rg -n 'name: "maestro_' src/index.ts
rg -n "poll maestro_status|narrate.*pulse" src README.md
rg -n "runnable.length > 1" src
rg -n "commitAll\(.*undefined|touchedFiles.*commit" src
pnpm run check
git diff --check
git status --short
```

Expected:

- exactly three model tools
- no orchestrator polling instruction
- no batch-size isolation condition
- no empty-list broad commit path
- checks pass
- only planned files changed

## Test plan

Cover:

- automatic handoff at safe boundary
- no repeated/stale handoff
- bounded decision and verification output
- T22-shaped approved-without-artifact reconciliation warning
- manual approval provenance
- category-based efficiency totals
- explicit config values preserved
- final end-to-end success and decision paths
- exactly three model tools

## Done criteria

- [ ] Automatic safe context handoff exists and is configurable.
- [ ] Model-facing output is bounded.
- [ ] Board/artifact inconsistencies are diagnosable.
- [ ] Completion reports cost/outcome categories compactly.
- [ ] Defaults are safe without overwriting user config.
- [ ] README matches tested behavior.
- [ ] Exactly three model tools remain.
- [ ] Full checks pass twice with stable test count.
- [ ] No release/dependency work occurred.

## STOP conditions

- Automatic handoff requires session replacement from a context where pi docs prohibit it.
- Reconciliation would need destructive automatic Git/state changes.
- Config migration would overwrite explicit user values.
- Full-suite stability requires deleting or weakening existing regression tests.
- Any documented feature lacks direct source/test evidence.

## Maintenance notes

Use the efficiency report to tune thresholds later. Do not add adaptive self-modifying policy yet. Legacy log cleanup remains a confirmed human operation; size caps prevent new growth, while retention safely handles approved/archived runs.
