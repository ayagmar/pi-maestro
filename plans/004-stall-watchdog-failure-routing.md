# Plan 004: Detect stalled executors and route failures without blind retries

> **Executor instructions**: Execute normally, not through pi-maestro. Build on the event-driven decision mechanism from Plan 003. Keep detection deterministic and bounded; do not introduce another model-facing tool. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 41b6057..HEAD -- src/runner.ts src/workflow.ts src/types.ts src/config.ts src/settings-ui.ts src/diagnostics.ts src/index.ts test/runner.test.ts test/workflow.test.ts test/config.test.ts test/index.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/003-consolidate-event-driven-drive.md`
- **Category**: correctness, performance
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Historical executors spent many turns and minutes repeatedly reading/searching without editing. Maestro currently reports only the latest tool name and relies on cost caps or manual intervention. A staged watchdog should steer once, terminate persistent stalls, and wake the orchestrator with evidence rather than retrying unchanged.

## Current state

- `src/runner.ts` updates `lastActivity` to only `event.toolName`.
- `RunUpdate` contains turns, cost, and a string activity label.
- There is no last-event time, last-progress time, phase, changed-file signal, repeat signature, turn cap, or idle/stall classification.
- RPC executors already support `steer()` and `abort()`.
- Provider and cost-cap failures already have structured kinds; extend this pattern instead of adding parallel error channels.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Focused | `node --import=tsx --test test/runner.test.ts test/workflow.test.ts test/config.test.ts test/index.test.ts` | all pass |
| Full | `pnpm run check` | exit 0 |

## Scope

**In scope**:
- runner/workflow/types/config/settings/diagnostics/index files listed above
- corresponding focused tests

**Out of scope**:
- New LLM tools
- Semantic analysis of model reasoning text
- Automatic arbitrary model escalation
- Permanent provider health service across projects
- New dependencies

## Steps

### Step 1: Track bounded progress signals

Extend live-run updates with:

- `lastEventAt`
- `lastProgressAt`
- phase: `starting | exploring | editing | verifying | reporting`
- changed-file count from Plan 002 Git telemetry
- recent bounded action signatures
- consecutive turns without meaningful progress

Meaningful progress is a file change, verification transition/result, explicit blocker/final report, or phase advance. A plain assistant text message or another read is not automatically progress.

Keep at most a small ring buffer (for example 8 actions); never inject full transcript text into status automatically.

**Verify**: deterministic event-sequence unit tests classify phases and progress timestamps.

### Step 2: Add conservative watchdog configuration

Add a small config group with defaults that avoid false positives, such as:

- warning turns without progress
- warning idle duration
- termination turns after warning
- optional cost-fraction warning

Prefer 2–4 clear numeric fields over a policy framework. Include settings/doctor output. Preserve backward compatibility for existing config files.

**Verify**: config merge, persistence, description, and diagnostics tests cover defaults and overrides.

### Step 3: Implement one automatic steer

When warning criteria are met, send exactly one standardized steer to the executor:

> Stop broad investigation. Either make the smallest in-scope implementation and run targeted verification, or report one concrete blocker within the next few turns.

Record the steer timestamp and reason. Do not trigger a supervisor LLM turn yet. Do not send repeated automatic steering messages in one attempt.

**Verify**: fake executor receives one steer despite repeated warning ticks.

### Step 4: Terminate persistent stalls as a distinct failure

If no meaningful progress occurs after the configured post-warning allowance:

- abort the executor
- classify outcome as `stalled`, not `user_abort`
- preserve isolated recoverable work
- create one compact drive decision with evidence
- prohibit unchanged automatic retry

Evidence should include elapsed time, turns, cost, changed-file count, phase, and recent action summaries.

**Verify**: test that warning → progress avoids termination; warning → no progress yields `stalled` and one decision.

### Step 5: Add root-cause fingerprints and failure routing

Generate stable fingerprints for:

- provider quota/auth/rate limit
- same verification command/error
- same reviewer finding (Plan 005 will reuse)
- merge-conflict path set
- scope violation
- no-progress stall
- infrastructure/process failure

Route mechanically:

- provider → run-scoped provider circuit
- infrastructure before useful work → no consumed attempt; decision if no fallback
- stall → decision, no automatic retry
- cost cap → preserve artifact and decision
- repeated same fingerprint twice → decision, no unchanged retry
- ordinary first implementation failure → existing bounded retry policy

**Verify**: table-driven tests assert each kind’s attempt consumption, retryability, and stop decision.

### Step 6: Add a run-scoped provider circuit

After a provider failure, skip other configured models from the same provider for the active drive. Try only a configured different-provider fallback. Persist enough state to avoid losing the circuit on extension reload during the same paused drive; clear it for a new run or explicit operator resolution.

Do not implement background probes or global health daemons.

**Verify**: several tasks sharing one blocked provider cause one failure decision, not N dead launches.

### Step 7: Surface evidence through existing drive inspect/intervene actions

`maestro_drive({action:"inspect"})` should return the bounded watchdog evidence. `intervene: "steer"` may send an operator/model-authored correction after the automatic steer, while `abort` ends the task. No new tools.

**Verify**: decision ownership and task liveness are validated before steering/aborting.

### Step 8: Full verification

```bash
node --import=tsx --test test/runner.test.ts test/workflow.test.ts test/config.test.ts test/index.test.ts
pnpm run check
git diff --check
```

## Test plan

Cover:

- exploring/editing/verifying/reporting transitions
- repeated reads do not count as progress
- Git change counts as progress
- one automatic steer maximum
- progress after steer prevents abort
- no progress becomes `stalled`
- stalled attempt never hot-loops
- repeated fingerprint stops at two
- blocked provider skips same-provider fallbacks across tasks
- different-provider fallback remains eligible
- circuit survives paused-drive reload and clears for new run
- bounded inspect output

## Done criteria

- [ ] Live runs expose meaningful progress, not only tool name.
- [ ] One automatic steer occurs before termination.
- [ ] Persistent stall has a distinct structured failure.
- [ ] Same-cause retries stop deterministically.
- [ ] Provider failures open a run-scoped circuit.
- [ ] No new model-facing tools exist.
- [ ] Focused/full checks pass.

## STOP conditions

- Progress detection depends on parsing private chain-of-thought/reasoning content.
- Watchdog timers cannot be canceled reliably on shutdown/attempt completion.
- Provider identity cannot be determined from the resolved model.
- A proposed default terminates an existing long-running verification test or valid tool operation without evidence.

## Maintenance notes

Tune thresholds from recorded metrics after release; do not optimize them from one run. The critical invariant is staged intervention: warn once, allow recovery, then stop. Cost caps remain a final safety net, not stall detection.
