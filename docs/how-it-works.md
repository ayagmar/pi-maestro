# How it works

The expensive model stays in your session and makes the judgment calls. Routine implementation runs in fresh contexts that receive only the brief they need, and nothing is approved until a separate reviewer has checked it.

## Roles

| Role | What it does |
|---|---|
| You | Set the goal, approve a plan when `planGate` is on, and decide when a stop needs judgment |
| Orchestrator | The model in your session. Plans tasks, picks tiers, and receives one bounded settled outcome per drive |
| Executor | A separate `pi --mode rpc` process with a fresh context, an explicit write scope, and normal pi tools |
| Reviewer | A fresh read-only context that checks the candidate against every success criterion and ends with a strict verdict |

The orchestrator never reads raw executor output. It works from short reports and status pulses, so its context holds decisions, not implementation detail.

## The loop

```text
you ──▶ orchestrator (your session, your model)
              │ maestro_plan                ┌──────────────────────────────┐
              ▼                             │ .pi/maestro/board.json       │
        task board  ◀──────────────────────▶│ logs/  history.jsonl         │
              │ plan approval (optional)    └──────────────────────────────┘
              │ /maestro drive or maestro_drive
              ▼
   executors in parallel (fresh context each, cheap tiers)
              │
              ▼
   reviewers (fresh context, read-only tools by default)
              │ approve / request changes
              ▼
   approved tasks ──▶ one summary back to the orchestrator
```

1. **Plan.** The board receives task contracts: brief, 1 to 12 success criteria, bounded write paths, dependencies, tier, and optionally a commit message and a trusted verification profile. An investigation task (`kind: "investigation"`) has no write scope.
2. **Claim.** The drive claims a task before launching it. The claim records the owning pi process and stays held through attempt persistence, review, integration, and verification.
3. **Execute.** Tasks whose dependencies are all `approved` run in parallel up to `maxParallel`. Each prompt carries the brief, the success criteria and open blockers, and the reports of approved dependencies.
4. **Review.** A reviewer receives the candidate and bounded evidence and must end with `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`. Anything else leaves the task in `ready_for_review`.
5. **Integrate.** Artifact checks, Git provenance, the optional commit or merge, and trusted verification finish the approval. A rejection sends the reviewer's findings into the next attempt.
6. **Settle.** The drive stops when work is complete or a stop condition needs intervention, then reports once.

A task moves through these states:

```text
todo ──run──▶ running ──▶ ready_for_review ──review──▶ approved
                 │                              │
                 ▼                              ▼
               failed                  changes_requested ──run──▶ running (retry with notes)
```

Approved and cancelled tasks are settled. A board of only cancelled tasks, or a mix of approved and cancelled ones, completes normally and is eligible for archival. Cancelling never counts as an approval and never creates review evidence.

## Review

A task's `reviewPolicy` is `single` (one reviewer, the default), `confirm` (`reviewRequiredApprovals` fresh independent approvals), or `find-and-refute` (one finder, then one independent confirmer that tests the finder's claims). A task that states no policy inherits the project's `reviewPolicy`. Disagreement and operational failure stop the drive once with an actionable decision instead of retrying indefinitely.

Reviewers get read-only tools by default (`read,grep,find,ls`). Two things bypass that: a custom `review.tools` list that adds `bash` or another writing tool, and manual approval from the dashboard or task picker, which skips the reviewer entirely and is recorded as `approvalKind: "manual"`.

Every reviewer launch records its model, provider, usage, the candidate tree it judged, and the task fingerprint. A `confirm` panel that has already approved a candidate is cut to a single reviewer for a mechanical re-review (a merge conflict, changed artifact, or verification retry) only when the candidate and the task contract are unchanged. Any genuine rejection restores the full panel.

## Attempts, launches, and failures

Maestro counts two things per task. A **launch** is every raw executor process start, including provider failures and model fallbacks. An **attempt** is a launch that produced real work and counts toward `maxAttempts`. A provider failure before any model turn (authentication, rate limit, quota) is a launch but not an attempt.

Provider failures are classified:

- Transient drops (`WebSocket error`, connection reset, 5xx) retry twice, after 15 s and 60 s.
- An exhausted usage window is waited out, up to `providerQuotaWaitMinutes`. For Codex the wait ends at the window's published `reset_at`; providers that publish nothing are probed with 2/4/8/15-minute backoff.
- Credential, billing, and unknown-model failures stop the drive at once.

An attempt the provider cut off after real work resumes its own session and checkout instead of paying to rebuild the context. A rejected attempt does the same by default (`retryContext: "resume"`): the follow-up carries only the reviewer's findings.

## What stops a drive

A drive runs until the board settles or one of these needs a decision: a pause, the plan gate, the run budget, the attempt cap, a provider block, repeated-rejection escalation, an abort, a blocked state, an error, or `maxRoundsPerRun` (default 20). [Operations and recovery](operations.md) lists each stop with the safe next action.

Escalation follows stagnation, not rejection count. Once a task reaches `reviewRejectionLimit`, the drive stops only if a reviewer repeated a finding an earlier attempt had already been told to fix. A task whose reviewer keeps raising new findings is still converging and keeps its attempts. The escalation notice names the repeated findings, the current tier, and a recommended next step.

At a decision the orchestrator chooses among the configured fallback, `maestro_update` (brief, tier, or dependencies), a `maestro_plan` split, cancellation, or asking you when scope or cost needs your call. It does not retry a blocked provider blindly, and it never raises `maxAttempts` to force another attempt.

At an attempt cap, editing the task cannot make it runnable, because its consumed attempts remain. The recovery is a narrowly scoped successor: set the new task's `supersedesTaskId` to the capped one, and Maestro cancels the predecessor, keeps it visible, and rewires its dependents to the successor.

## One turn per drive

When the model calls `maestro_drive` with `action: "start"`, that single call spans the whole loop. Round-by-round progress streams into the live tool result, and the call returns only when the board settles or a decision needs the orchestrator. The orchestrator spends one turn on a whole drive instead of polling it, because every polling turn re-sends the conversation and evicts the prompt cache.

A drive you start with `/maestro drive` reports through one bounded wakeup message instead, as do unexpected background failures, so a supervisor is never left waiting on a drive that already stopped. `maestro_drive` with `action: "inspect"` returns bounded evidence for a board this session is not driving and accepts a task scope.

`/maestro pause` is a safe stop: active executors finish and no new batch starts. `/maestro resume` continues the same task scope from the board's fresh persisted state. `/maestro abort` aborts active executors. Session switches are blocked while a drive or executor is active.

## Isolation

With `useWorktrees` off, parallel batches (more than one runnable task and `maxParallel > 1`) are still isolated automatically in per-task worktrees under `.pi/maestro/worktrees/`, because a shared checkout cannot attribute concurrent changes. A task that runs alone works in your checkout, and non-Git projects keep the shared-directory behavior. With `useWorktrees` on, every attempt gets its own checkout.

A worktree exists only while an executor or reviewer uses it. When none is, Maestro checkpoints recoverable edits on the task branch and removes the checkout; review or retry restores it from that branch.

Isolated checkouts are built from committed content, so a file a brief points at must be committed. A drive that isolates tasks warns which uncommitted paths the executors cannot see.

Write paths are scheduling guidance. They keep independent plans from overlapping and make unpredicted changes visible to the reviewer, but they are not an automatic rejection boundary: the reviewer decides whether a deviation was necessary and safe.
