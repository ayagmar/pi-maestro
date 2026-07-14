# Operations and recovery

Maestro preserves board state, attempts, logs, sessions, Git branches, and dirty recovery worktrees. Prefer `/maestro timeline`, `/maestro board`, `/maestro doctor`, and `/maestro reconcile` before changing state.

| State or failure | Safe action | Preserved evidence |
|---|---|---|
| `plan_gate` | Open `/maestro plan`, edit, then approve or reject. | Rejection archives the plan. |
| `provider_blocked` / `provider_failure` | Configure an authenticated fallback, then `/maestro resume`. | Failed launches, usage, and provider reason. |
| `executor_failure` / `reviewer_failure` | Inspect the referenced session/log, correct the task or environment, then retry deliberately. | Process outcome, redacted reason, and usage. |
| `review_disagreement` | Inspect both reports and deliberately change the task review policy before resuming. | Both roles, verdicts, criterion evidence, model/provider, usage, and sessions. |
| `attempt_cap` | Create a narrow successor with `supersedesTaskId`; Maestro atomically cancels the predecessor and rewires dependents, then drive the successor scope. Do not raise the cap. | Capped predecessor and every attempt. |
| `escalation_required` / `reviewer_rejection` | Refine criteria/brief/tier, split, cancel, or hand off; then resume. | Findings and review launches. |
| `stalled` | Inspect the session/log; steer, abort, or refine before retrying. | Watchdog failure reason and log. |
| `cost_cap` / `budget_blocked` | Inspect `/maestro costs`; explicitly change scope or operator config. | Usage and prompt accounting. |
| `launch_limit` | Inspect retained launches, narrow the scope, or explicitly start another bounded drive. | Every executor and reviewer launch attempted by the drive. |
| `stale_completion` | Inspect the component reason, then `/maestro retry <taskId>` or create a successor. | Legacy approval, prior artifact, provenance, attempts, and dependency identities. |
| `user_abort` / `aborted` | Resume or explicitly retry only after checking partial work. | Attempt and worktree. |
| Merge conflict | Resolve in the reported recovery worktree/branch, or create a focused successor. | Branch, checkout, and conflict notes. |
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
- `/maestro retry <taskId>` uses the same eligibility function as picker/dashboard retry. It refuses
  live or capped work, confirms accepted/integrated work, preserves history, and isolates execution
  retry from the dirty integration checkout.
- `/maestro timeline [taskId]` derives bounded chronology without model calls.
- `/maestro reconcile` reports missing review, artifact, integration, verification, or recovery proof without rewriting state.
- `/maestro simulate` reports deterministic dependency waves; plan approval and drive preflight additionally report concurrency, raw launch upper bounds, verification-profile usage, and whether explicit scale confirmation is required. These reports never invent price estimates.
- `/maestro back` and dashboard session controls remain available for transcript inspection.
- `/maestro plan diff|compare <file> [taskId]` and `/maestro recipe preview <name> [JSON]` are
  validated read-only inspections. Their deterministic references identify bounded omitted detail.

The dashboard’s run view always exposes discovery, plan approval, execution, review, integration,
verification, recovery, and complete. Drill into a phase, task, then launch for prompt accounting,
recent tool activity, final reports, model/provider, usage, findings, artifact/integration identity,
verification, and recovery references. Narrow and short terminals keep the selection visible.

An active drive is durable before “Drive started” is reported. On reload or shutdown, an owner with
no live controller/executor is reconciled into one bounded internal-error decision. Delivery claims
are owner-scoped: failed notification remains pending, a foreign session cannot consume it, and an
already appended owner message is acknowledged without duplication.

Never reset, clean, or force-remove a recovery checkout merely to make status green. An empty changed-path list never means “stage everything.”

Multi-review policies require one bounded `CRITERION N: PASS|FAIL — evidence` line per success criterion. Provider, process, artifact, merge, commit, and verification failures are operational failures: they do not count as reviewer disagreement or increment rejection escalation. Raw fallback launches remain attached to the same logical reviewer index, and launch caps prevent indefinite review retries.
