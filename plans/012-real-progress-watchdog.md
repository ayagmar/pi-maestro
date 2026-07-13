# Plan 012: Detect silent and investigative stalls with real progress signals

> **Executor instructions**: Keep watchdog behavior deterministic and conservative. Never parse chain-of-thought or add a model tool.
>
> **Drift check**: `git diff --stat -- src/runner.ts src/workflow.ts src/types.ts src/config.ts src/settings-ui.ts src/diagnostics.ts test/runner.test.ts test/workflow.test.ts test/config.test.ts`
> Planned at `41b6057`; dirty-diff checksum `5d86f382a96852fbe76fffc44b0afff54e4e8f78e91fcbede7e0c850b8bb0275`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/008-dispatch-lifecycle-transaction.md`, `plans/010-durable-drive-decisions.md`
- **Category**: bug, performance
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

The current watchdog runs only when an event arrives, so a hung tool never triggers it. Any Bash call resets progress, including repeated searches, which defeats investigative-stall detection. A cancellable wall-clock watchdog with a few explicit signals is sufficient.

## Current state

- `src/runner.ts:282-395` tracks turns and treats `edit|write|bash` as progress.
- Warning/termination checks execute inside `processLine()`.
- RPC handles already expose `steer()` and `abort()`.
- `stalled` already exists as a structured failure kind.

## Scope

**In scope**: listed files and focused tests.

**Out of scope**: reasoning-text parsing, adaptive ML policy, global provider health, automatic tier escalation.

## Steps

### Step 1: Define explicit progress state

Track last event time, last meaningful progress time, phase, changed-file count, verification transition/result, final report, and a ring buffer of at most eight normalized action signatures. Reads/searches and arbitrary Bash do not count by themselves. A Git file-state delta does.

### Step 2: Add a cancellable timer

Run watchdog evaluation from one timer per attempt so silence is observable. Start after child launch; clear in every outcome/error/abort path. Use configurable idle duration plus turn thresholds; maintain backward-compatible defaults.

### Step 3: Preserve staged response

Send exactly one standardized automatic steer. If progress occurs, reset termination eligibility without allowing steer spam. If no progress follows within allowance, abort as `stalled`, preserve recoverable work, persist a durable decision from Plan 010, and prohibit unchanged auto-retry.

### Step 4: Improve evidence and routing

Decision evidence includes elapsed/idle time, turns, cost, phase, changed-file count, and bounded signatures. Stable fingerprints stop the same stall twice. Inspect returns this evidence without transcript content.

### Step 5: Test deterministic sequences

Use fake clocks or injected time/timer seams matching repository style. Cover repeated reads, repeated Bash searches, file change, long verification, silent hung tool, progress after steer, one steer maximum, timer cleanup, and stalled decision reload.

## Done criteria

- [ ] Silent hangs trigger without new child events.
- [ ] Investigation commands do not falsely reset progress.
- [ ] Valid file/verification/report progress prevents termination.
- [ ] Timers are cleared on every exit.
- [ ] One steer maximum per stall episode.
- [ ] Focused/full checks pass.

## STOP conditions

- Reliable tests require real multi-second sleeps.
- Progress detection requires private reasoning content.
- Default thresholds terminate an existing valid long-running verification fixture.

## Maintenance notes

Tune defaults only from aggregated metrics. Keep the staged warn-then-stop invariant more stable than individual thresholds.