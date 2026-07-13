# Plan 005: Replace serial reviewer rejection with deterministic gates and bounded cumulative findings

> **Executor instructions**: Execute normally. Build on transactional artifacts from Plan 002. Do not add a new review tool or a generalized issue tracker. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 41b6057..HEAD -- src/prompts.ts src/workflow.ts src/types.ts src/format.ts test/prompts.test.ts test/workflow.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-transactional-task-execution.md`
- **Category**: performance, correctness, tests
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

The latest board spent $20.22 on 16 reviewer-rejected attempts. The reviewer prompt currently stops after finding enough evidence to reject, and each new rejection overwrites `task.reviewNotes`. This encourages one-defect-per-attempt churn and loses previously discovered requirements.

## Current state

- `src/prompts.ts` says: “Stop verifying once you have either confirmed the acceptance criteria or found enough evidence to reject.”
- Executor and reviewer prompts inject only `task.reviewNotes` from the latest rejection.
- `src/workflow.ts` assigns `fresh.reviewNotes = notes`, replacing prior task-level feedback.
- Rejection escalation counts consecutive rejections but does not fingerprint or preserve individual open findings.
- Prompt context is bounded to 10,000 characters; keep new finding injection significantly below that.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Focused | `node --import=tsx --test test/prompts.test.ts test/workflow.test.ts` | all pass |
| Full | `pnpm run check` | exit 0 |

## Scope

**In scope**:
- `src/prompts.ts`
- `src/workflow.ts`
- `src/types.ts`
- `src/format.ts` if finding formatting belongs there
- `test/prompts.test.ts`
- `test/workflow.test.ts`

**Out of scope**:
- New model tools
- General-purpose issue database
- Cross-task code review
- Increasing maximum attempts
- Changing reviewer tool permissions

## Steps

### Step 1: Run deterministic gates before the reviewer

Use Plan 002’s artifact/scope gate before spawning the LLM reviewer. Persist deterministic findings in the same bounded format as reviewer findings, but do not charge review usage or increment genuine reviewer-rejection counters for a gate that never launched a reviewer.

Examples:

- missing expected diff
- out-of-scope changed path
- deleted protected tests
- failed required verification
- conflict marker
- invalid Git state

**Verify**: fake reviewer launch count remains zero for each deterministic failure.

### Step 2: Add a minimal bounded finding type

Add optional task findings with only needed fields:

```ts
{
  fingerprint: string,
  message: string,
  status: "open" | "verified",
  firstAttempt: number,
  lastAttempt: number
}
```

Rules:

- maximum 8 open findings injected into a prompt
- redact and truncate each message
- deduplicate by stable fingerprint
- preserve verified findings in attempt history or bounded task history, but do not inject them into every retry
- legacy `reviewNotes` remains readable during migration, then is derived from/open-finding summary rather than independently overwritten

**Verify**: board validation and legacy-board tests cover optional fields and bounds.

### Step 3: Require structured reviewer output

Change the reviewer contract to end with a machine-parseable verdict plus bounded findings. Reuse the existing verdict line for compatibility. A simple text format is sufficient; do not add JSON schema complexity unless parsing text proves unreliable.

The reviewer must:

1. verify every acceptance criterion
2. verify every open prior finding
3. report all blocking in-scope findings found, up to the bound
4. avoid unrelated style/audit findings
5. approve only when all criteria and prior findings pass

Remove the instruction to stop after the first defect. Allow early stop only when a blocker makes further verification impossible, and require the reason.

**Verify**: prompt tests assert all five requirements and no first-finding stop instruction.

### Step 4: Parse, fingerprint, and merge findings

Parse numbered findings from `REQUEST_CHANGES`. Normalize fingerprints from explicit reviewer ID when present, otherwise from affected file/behavior/message normalization. Merge with existing open findings:

- repeated finding updates `lastAttempt`
- missing prior finding is not automatically verified; reviewer must explicitly verify it
- verified prior finding becomes `verified`
- regressed finding reopens with same fingerprint

If output cannot be parsed, keep task reviewable with `reviewer_failure`; do not invent findings.

**Verify**: tests cover new, repeated, verified, regressed, malformed, and over-limit findings.

### Step 5: Inject only open findings into retries

Executor retry prompt should contain a concise checklist of all open findings. Reviewer prompt should contain the same checklist and demand explicit verification. Do not inject complete old review reports.

Keep total finding context bounded well below `MAX_INJECTED_CONTEXT_LENGTH`; include session references for manual inspection instead of raw history.

**Verify**: prompt-size tests cover 8 long findings and prove deterministic truncation.

### Step 6: Integrate same-cause policy

Expose finding fingerprints to Plan 004’s repeated-cause detector. Two attempts with the same still-open blocking fingerprint must stop at a drive decision rather than launch unchanged work again. A new distinct finding may use remaining attempt policy, still bounded by global rejection escalation.

**Verify**: same finding twice stops; two different findings are preserved together and presented once to the next executor.

### Step 7: Full verification

```bash
node --import=tsx --test test/prompts.test.ts test/workflow.test.ts
pnpm run check
git diff --check
```

## Test plan

Cover:

- deterministic gate avoids reviewer launch
- reviewer checks all criteria and prior findings
- multiple findings parsed in one rejection
- deduplication/fingerprint stability
- explicit verification closes a finding
- regression reopens it
- only open findings enter retry prompt
- 8-finding and character bounds
- malformed reviewer result remains reviewable
- same finding twice reaches decision instead of blind retry
- reviewer rejection accounting excludes deterministic gate failures

## Done criteria

- [ ] Mechanical failures do not launch reviewers.
- [ ] Reviewers perform a bounded complete in-scope pass.
- [ ] Open findings accumulate without unbounded prompt growth.
- [ ] Previous findings require explicit verification.
- [ ] Same-cause rejection stops unchanged retries.
- [ ] Existing legacy boards remain loadable.
- [ ] Focused/full checks pass.

## STOP conditions

- Finding parsing requires exposing raw chain-of-thought.
- The board migration would reject existing boards instead of treating fields as optional.
- A bounded complete review cannot fit within the existing 10,000-character injection guard.
- Deterministic gates duplicate or contradict Plan 002’s artifact gate rather than reuse it.

## Maintenance notes

The finding list is a retry aid, not a project issue tracker. Keep it task-local, bounded, redacted, and focused on acceptance blockers. Reviewer quality should be measured by approved integrated outcomes and reduced retries, not number of findings.
