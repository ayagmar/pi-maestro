# Operations and recovery

Maestro preserves board state, attempts, logs, sessions, and checkpoint branches. Physical task checkouts exist only during active execution, review, or inspection. Prefer `/maestro timeline`, `/maestro board`, `/maestro doctor`, and `/maestro reconcile` before changing state.

| State or failure | Safe action | Preserved evidence |
|---|---|---|
| `plan_gate` | Open `/maestro plan`, edit, then approve or reject. | Rejection archives the plan. |
| `provider_blocked` / `provider_failure` | Configure an authenticated fallback, then `/maestro resume`. | Failed launches, usage, and provider reason. |
| `executor_failure` / `reviewer_failure` | Inspect the referenced session/log, correct the task or environment, then retry deliberately. | Process outcome, redacted reason, and usage. |
| `review_disagreement` | Inspect both reports and deliberately change the task review policy before resuming. | Both roles, verdicts, criterion evidence, model/provider, usage, and sessions. |
| `attempt_cap` | Create a narrow successor with `supersedesTaskId`; Maestro atomically cancels the predecessor and rewires dependents, then drive the successor scope. Do not raise the cap. | Capped predecessor and every attempt. |
| `escalation_required` / `reviewer_rejection` | Refine criteria/brief/tier (resets the rejection counters, then `/maestro resume`), or split with `supersedesTaskId` and drive the successor scope — a paused drive scope rewires to the successor automatically. The decision carries reviewer findings plus bounded executor evidence (report, touched files, spend). | Findings, executor report, and review launches. |
| `stalled` | Inspect the session/log; steer, abort, or refine before retrying. | Watchdog failure reason and log. |
| `cost_cap` / `budget_blocked` | Inspect `/maestro costs`, then raise the budget deliberately with `/maestro config budget <usd>` or archive with `/maestro reset`. The budget counts the board's lifetime spend — sunk cost of cancelled and superseded tasks included — so cancelling work never frees budget; the warning reports the sunk share separately. | Usage and prompt accounting. |
| `launch_limit` | Inspect retained launches, narrow the scope, or explicitly start another bounded drive. | Every executor and reviewer launch attempted by the drive. |
| `stale_completion` | Inspect the component reason, then `/maestro retry <taskId>` or create a successor. | Legacy approval, prior artifact, provenance, attempts, and dependency identities. |
| `user_abort` / `aborted` | Resume or explicitly retry only after checking partial work. | Attempt metadata and a checkpoint branch; the idle checkout is removed. |
| Merge conflict | Retry or inspect the reported recovery branch; Maestro restores its checkout only while work resumes. | Checkpoint branch and conflict notes. |
| Candidate verification failure | Fix in the task checkout and retry review. | Verification log and immutable pre-check identity. |
| Integrated verification failure | Inspect the recorded commit and retained checkout; no automatic rollback is claimed. | Integrated commit, branch, checkout, and verification log. |
| `paused` | The owning session uses `/maestro resume`; another session must not take ownership. | Paused scope and owner. |
| Stale dispatch claim | Run `/maestro doctor`; startup recovery clears only expired safe claims. | Orphan attempts are finalized, not deleted. |
| Orphan worktree | `/maestro doctor cleanup`, inspect, then `/maestro doctor cleanup confirm`. | Dirty or branch-ahead worktrees are classified recoverable and preserved. |
| Manual acceptance | Use dashboard acceptance only when intentionally bypassing review. | `approvalKind: manual` remains visible to reconciliation. |
| `completed` | Review the completion message or `/maestro timeline`; completed-board cleanup archives before clearing. | Archived board and logs under retention policy. |
| `no_progress` | Inspect each pending task's dispatch-decline note, correct the named condition, then resume. | The decision and `maestro_drive` inspect output preserve per-task decline notes; no-op iterations consume no round budget. |
| `round_limit`, `blocked`, or `error` | Inspect the decision evidence and blockers, correct one owner-scoped issue, then resume. | Durable decision delivery and resolution. |

## Routine controls

- `/maestro pause` waits for active work to settle and persists resumable ownership.
- `/maestro abort` signals active work and retains its evidence.
- `/maestro reset` confirms before archiving or changing state. In non-interactive mode it refuses
  unless invoked as `/maestro reset confirm`. Replacement uses the exact confirmed board revision
  and refuses if concurrent work changed it.
- `/maestro retry <taskId>` uses the same eligibility function as picker/dashboard retry. It refuses
  live or capped work, confirms accepted/integrated work, preserves history, and isolates execution
  retry from the dirty integration checkout.
- `/maestro timeline [taskId]` derives bounded chronology without model calls.
- `/maestro insights` reads the current and archived boards without mutation or model calls and renders a bounded per-executor-model/task-tier report of attempts, first-review approval, average end-to-end cost per approved task, failure kinds, and reviewer rejection.
- `/maestro reconcile` reports missing review, artifact, integration, verification, or recovery proof without rewriting state.
- `/maestro simulate` reports deterministic dependency waves; plan approval and drive preflight additionally report concurrency, raw launch upper bounds, verification-profile usage, an explicitly labeled projected-cost estimate, and whether explicit scale confirmation is required. Cost forecasting prefers archived per-model-and-tier launch averages, otherwise applies model pricing metadata to a rough 20,000-input/4,000-output-token launch, and finally uses a static $0.10 fallback for unresolved models.
- `/maestro agents` and `ctrl+alt+w` open the rich executor/reviewer session browser. Live sessions
  can be steered without switching; opening a completed session in Pi is offered only after the
  drive and active executors settle. `/maestro back` returns to the previous owner session.
- `/maestro plan diff <file> [taskId]` and `/maestro recipe preview <name> [JSON]` are
  validated read-only inspections. Their deterministic references identify bounded omitted detail.

## Context reuse

A model's context window cannot be persisted across processes with hosted providers, so "saving
context" means reusing conversations and reports, not raw KV state. Maestro reuses context in
three places. Review-rejection retries continue the rejected attempt's own session by default
(`retryContext: "resume"`): the follow-up prompt carries only the reviewer's findings, the model
keeps everything it already read, and providers bill the replayed history at cached input rates
instead of the executor re-reading the repository. Dependency reports flow into dependent
executors' prompts, so shared investigation belongs in one explicit investigation task that
dependents consume as a report. Escalation decisions and single-task `maestro_drive` inspect carry
the executor report, touched files, and structured findings, so the orchestrator can replan
without re-reading source files. Reviewers, provider fallbacks, human retries, and discovery tasks
deliberately keep fresh contexts: adversarial review is only worth its cost while the reviewer
re-derives the evidence independently.

## Agent-session storage

Every raw executor and reviewer launch gets a unique directory beneath Pi's normal per-project
session directory:

```text
~/.pi/agent/sessions/<encoded-project>/.maestro/<launch>/<session>.jsonl
```

Pi's ordinary `/resume` picker reads only top-level session files, so these child transcripts do not
crowd or slow the human session list. `/maestro agents` and `/maestro open <taskId>` use the exact
session path recorded on the board, and `/maestro back` returns to the owner session. After opening
a child in Pi, use `/maestro back` rather than `/resume`: the child treats its launch directory as
the active session directory.

The transcript remains inside Pi's normal root. Usage tools that recursively discover Pi JSONL files
continue to include every child request; tools that only inspect top-level files must opt into the
`.maestro` namespace. Older Maestro sessions are not moved automatically and remain in their prior
location until migrated or removed separately.

The dashboard’s run view always exposes discovery, plan approval, execution, review, integration,
verification, recovery, and complete. Drill into a phase, task, then launch for prompt accounting,
recent tool activity, final reports, model/provider, usage, findings, artifact/integration identity,
verification, and recovery references. Narrow and short terminals keep the selection visible.

An active drive is durable before “Drive started” is reported. On reload or shutdown, an owner with
no live controller/executor is reconciled into one bounded internal-error decision. Delivery claims
are owner-scoped: failed notification remains pending, a foreign session cannot consume it, and an
already appended owner message is acknowledged without duplication.

Idle Maestro checkouts are checkpointed on their task branch and removed automatically. They are restored at the recorded path only while execution, review, or manual inspection resumes. Never delete a recovery branch merely to make status green. An empty changed-path list never means “stage everything.”

Multi-review policies require one bounded `CRITERION N: PASS|FAIL — evidence` line per success criterion. A task that states no criteria (an explicit investigation, or a legacy task) has nothing to enumerate, so its verdict line alone is authoritative. Findings are identified by criterion reference, or by the finding text with Markdown emphasis and punctuation normalized away, so the same defect reworded between attempts is still recognized as unresolved and can escalate. Provider, process, artifact, merge, commit, and verification failures are operational failures: they do not count as reviewer disagreement or increment rejection escalation. Raw fallback launches remain attached to the same logical reviewer index, and launch caps prevent indefinite review retries.
