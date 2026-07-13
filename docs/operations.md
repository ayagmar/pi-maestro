# Operations and recovery

Maestro preserves board state, attempts, logs, sessions, Git branches, and dirty recovery worktrees. Prefer `/maestro timeline`, `/maestro board`, `/maestro doctor`, and `/maestro reconcile` before changing state.

| State or failure | Safe action | Preserved evidence |
|---|---|---|
| `plan_gate` | Open `/maestro plan`, edit, then approve or reject. | Rejection archives the plan. |
| `provider_blocked` / `provider_failure` | Configure an authenticated fallback, then `/maestro resume`. | Failed launches, usage, and provider reason. |
| `executor_failure` / `reviewer_failure` | Inspect the referenced session/log, correct the task or environment, then retry deliberately. | Process outcome, redacted reason, and usage. |
| `attempt_cap` | Create a narrow successor, rewire dependents, drive the successor scope. Do not raise the cap to force a retry. | Capped predecessor and every attempt. |
| `escalation_required` / `reviewer_rejection` | Refine criteria/brief/tier, split, cancel, or hand off; then resume. | Findings and review launches. |
| `stalled` | Inspect the session/log; steer, abort, or refine before retrying. | Watchdog failure reason and log. |
| `cost_cap` / `budget_blocked` | Inspect `/maestro costs`; explicitly change scope or operator config. | Usage and prompt accounting. |
| `user_abort` / `aborted` | Resume or explicitly retry only after checking partial work. | Attempt and worktree. |
| Merge conflict | Resolve in the reported recovery worktree/branch, or create a focused successor. | Branch, checkout, and conflict notes. |
| Candidate verification failure | Fix in the task checkout and retry review. | Verification log and immutable pre-check identity. |
| Integrated verification failure | Inspect the recorded commit and retained checkout; no automatic rollback is claimed. | Integrated commit, branch, checkout, and verification log. |
| `paused` | The owning session uses `/maestro resume`; another session must not take ownership. | Paused scope and owner. |
| Stale dispatch claim | Run `/maestro doctor`; startup recovery clears only expired safe claims. | Orphan attempts are finalized, not deleted. |
| Orphan worktree | `/maestro doctor cleanup`, inspect, then `/maestro doctor cleanup confirm`. | Dirty or branch-ahead worktrees are classified recoverable and preserved. |
| Manual acceptance | Use dashboard acceptance only when intentionally bypassing review. | `approvalKind: manual` remains visible to reconciliation. |
| `completed` | Review the completion message or `/maestro timeline`; completed-board cleanup archives before clearing. | Archived board and logs under retention policy. |
| `round_limit`, `blocked`, or `error` | Inspect the decision evidence and blockers, correct one owner-scoped issue, then resume. | Durable decision delivery and resolution. |

## Routine controls

- `/maestro pause` waits for active work to settle and persists resumable ownership.
- `/maestro abort` signals active work and retains its evidence.
- `/maestro timeline [taskId]` derives bounded chronology without model calls.
- `/maestro reconcile` reports missing review, artifact, integration, verification, or recovery proof without rewriting state.
- `/maestro back` and dashboard session controls remain available for transcript inspection.

Never reset, clean, or force-remove a recovery checkout merely to make status green. An empty changed-path list never means “stage everything.”
