# Changelog

## 0.1.0

First release of Pi Maestro: an orchestrator and fresh-context executor workflow for pi, with independent review and a board that records everything.

### Compatibility

- Requires pi 1.5 or newer and Node.js 22.19 or newer. It is developed and tested against the pi `1.5.x` line.
- Key hints in Maestro's list pickers and text input come from the keybindings pi injects, so remapped keys work and show correctly. The plan, brief, workflow, and model-picker viewers scroll and close with pi's selection keybindings, and they skip PgUp/PgDn hints in pi's fullscreen mode, where pi's own viewport takes those keys.
- Inline pickers and the single-line editor pass pi's `blocked` status to `ctx.ui.custom`, so terminals that show pi's program status report Maestro as waiting for you.
- A task report or review verdict opened from the dashboard is a custom session entry with its own renderer, so it never enters the model's context. Orchestrator kickoff and decision messages still reach the model.
- In `pi --mode rpc`, `/maestro plan`, `/maestro workflows`, and the plan task editor use pi's stock select and editor dialogs, and the viewers and the task report and review cards send their text as a notification.
- In print (`-p`) and JSON mode, command output and notices go to stderr, so JSON stdout stays clean and `/maestro config show`, `costs`, `insights`, and `timeline` print their reports.
- The live agent pane marks a launch finished on `agent_settled` and applies `context_edit` entries as they arrive. The agent selector truncates every row to the terminal width.
- Executors launched from a standalone (Bun-compiled) pi binary re-run that binary directly, as pi's own subagent example does.
- Invalid boards, config files, recipes, plan exports, and discovery output report the field at fault as a JSON Pointer path, such as `/tasks/0/attempts/0/usage/cost: expected number, got string`, and the board quarantine notice includes that reason. Files are validated with `@earendil-works/pi-schema`, pi's own JSON Schema validator.

### Planning and driving

- The model has three tools: `maestro_plan`, `maestro_update`, and `maestro_drive`. Approval, pause, abort, simulation, and recovery are human commands.
- Tasks carry a self-contained brief, a tier, dependencies, 1 to 12 success criteria, bounded write paths, and an optional commit message, verification profile, review policy, and `reviewGuidance` hint. Explicit `kind: "investigation"` tasks use an empty scope. Plans warn when one task bundles six or more criteria or eight or more write paths, and overlapping `writePaths` are reported once per file with every claimant.
- Plan rejections explain that ids are assigned in array order. `maestro_plan`, `maestro_update`, and `maestro_drive` results show their notices under the task rows: the approval gate, supersession and shape warnings, invalidated in-flight cost, and recovery guidance.
- `planGate` holds the first plan until you approve it in `/maestro plan`, where each task can be edited. Changing the contract of a running or `ready_for_review` task through `maestro_update` needs `invalidateInFlight: true`.
- `maestro_drive start` runs the whole run, review, and retry loop in one tool call and returns when the board settles or a decision needs the orchestrator. Progress streams into the live tool result, so the orchestrator spends one turn per drive. `maxRoundsPerRun` (default 20) bounds the loop.
- `/maestro start` archives a non-empty board first, so each goal gets a fresh board. `/maestro handoff` continues in a fresh session from the board alone, and Maestro queues the same handoff once at `handoffContextRatio`.
- `/maestro pause`, `resume`, and `abort` control a drive. Mechanical stops (`budget_blocked`, `aborted`, launch and round limits, provider blocks, internal errors) can be resumed from any session once the cause is fixed. Judgment decisions keep an owner-session guard. A paused drive records why it stopped.
- A successor created with `supersedesTaskId` atomically cancels its predecessor, keeps it visible, takes over its dependents, and inherits its `dependsOn`. A paused drive's scope follows the successor.
- Escalation follows stagnation: after `reviewRejectionLimit` rejections the drive stops only if a reviewer repeated a finding an earlier attempt was told to fix. A rejection that fails four or more distinct criteria escalates at once. Editing a brief or its criteria clears recorded findings and rejection counters.
- A delivered decision that stays unresolved for `decisionNudgeMinutes` re-nudges the owner session up to three times. A scale-confirmation refusal marks the decision `awaitingHuman`, which stops reminders and tells the orchestrator nothing further is needed.
- `/maestro plan export`, `import`, and `diff`, `/maestro recipe` (with `preview`), `/maestro workflows`, `/maestro discover`, and `/maestro simulate` cover plans as files, reusable recipes, bounded discovery, and read-only previews. Recipe and discovery tasks inherit the project's `reviewPolicy`. Example recipes ship in `examples/recipes/`.
- Orchestrator and supervisor briefings tell the model to call `maestro_drive` `start` after correcting a brief or tier, and say that executors work in isolated checkouts only when they do.

### Executors

- Each executor is a separate `pi --mode rpc` process with a fresh context, so a running executor can be steered mid-run or aborted cleanly. Dependent tasks receive the reports of their approved dependencies.
- Tiers (`trivial`, `standard`, `complex`, and your own) set a model, thinking level (`off` to `max`), tools, and ordered `fallbacks`. A task that fails before any model turn, or reports quota exhaustion mid-run, advances to the next fallback without consuming `maxAttempts`.
- Provider failures are classified. Transient drops retry twice after 15 s and 60 s. An exhausted usage window is waited out for up to `providerQuotaWaitMinutes` (default 360); on Codex the wait ends at the window's published `reset_at` plus 45 seconds, and other providers are probed with 2/4/8/15-minute backoff. Credential, billing, and unknown-model failures stop the drive at once. A drive asleep for quota shows `waiting` with the resume time everywhere.
- An attempt the provider cut off after real work resumes its own session and checkout. A review-rejected attempt does the same by default (`retryContext: "resume"`), carrying only the reviewer's findings. Provider fallbacks, human retries, and discovery tasks start fresh.
- Zero-turn environment failures, such as a missing executable, back off for 2 seconds and do not consume `maxAttempts`.
- The watchdog steers once after silence or a run of no-progress turns and then classifies continued inactivity as `stalled`. Progress detection is aware of run kind: read-tool activity counts as progress for investigations and reviews, and long reports written across turns count as progress. Complete provider silence is a provider failure, not a stall. Any tier may override the thresholds.
- `detachedExecutors` (Unix, opt-in) runs executors behind a detached supervisor with persisted event and control files, so work can outlive pi and reattach on the next start.
- Parallel batches are isolated in per-task worktrees even with `useWorktrees` off. A drive that isolates tasks warns which uncommitted paths the executors cannot see.
- A task checkout exists only while an executor or reviewer uses it. Idle changes are checkpointed on the task branch and the checkout is removed; review or retry restores it.
- Attempts attribute changes by content against a pre-run Git baseline, so shell-side edits count, commits made inside the task checkout count, and pre-existing dirt never does.

### Review

- A reviewer with a fresh context and `read,grep,find,ls` checks every task against its criteria and ends with `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`. `reviewPolicy` is `single` (default), `confirm` (independent approvals), or `find-and-refute`, set per project or per task.
- Every reviewer launch records its model, provider, usage, the candidate tree it judged, and the task fingerprint. A `confirm` panel is cut to one reviewer for a mechanical re-review only when the candidate and contract are unchanged.
- Under `confirm` and `find-and-refute`, a `REQUEST_CHANGES` with every criterion marked PASS is a real rejection on grounds outside the criteria. Only approving while a criterion is FAIL is a contradiction. Criterion evidence parsing accepts the shapes reviewers write, including Markdown headings and bold list items.
- Approval is withheld when the executor's report declares its state as BLOCKED, INCOMPLETE, NOT DONE, or FAILED.
- Findings are distilled only from numbered list items, deduplicated, and cleared when the task contract changes. Approval marks a task's findings verified.
- `reviewCheapModel` runs the first reviewer of each attempt on a cheap model, and `reviewEscalation` decides when the review tier takes over. Preflight and the cost forecast count the extra launches and price the cheap model at its own rates.
- A stop caused by the artifact gate (no attributable changes, inputs changed, failed verification) says no reviewer ran, with the gate cause.
- Trusted verification profiles, defined only in user config, gate approval. Output is streamed to `.pi/maestro/verification/`.

### Git

- With `autoCommit`, each approved task becomes one conventional commit from its `commitMessage`. `pushOnIntegration` optionally pushes after each integration, and a push failure never blocks an approval.
- Maestro's own commits use `--no-gpg-sign`, and every Git call has a timeout and `GIT_TERMINAL_PROMPT=0`, so a missing signing key cannot freeze the editor.
- Promotion checks that `HEAD` still names the branch the candidate was prepared against. Parking a checkout refuses to remove it when its changes cannot be checkpointed.
- Approval provenance records the candidate tree, review, integration commit, and verification. Fingerprints exclude the tier's model, thinking level, tools, and fallbacks, so switching executor models does not make approved work stale. A change to the contract, verification profile, dependencies, or review policy does.

### Cost and limits

- `maxRunCost` bounds the board's lifetime spend, sunk cost included, and the drive shares one ledger across launches. Every launch is capped at a fair share of what is left, and none starts below one cent. Raising it with `/maestro config budget <usd>` resolves a pending `budget_blocked` decision, and a one-time notice fires at 80%.
- Reviewer spend reaches the board even when the budget stops a panel partway.
- `maxCostPerTask` and `maxCostPerReview` cap single launches. A capped attempt keeps its edits, and raising the cap above what it spent resumes it in place. A task stopped by a cap is not retried at the same cap.
- `maxAttempts` counts only launches that produced real work, so a launch cut at its share of the run budget is retried without using up an attempt, and its failure says so instead of asking you to raise the budget. `maxTotalLaunchesPerRun`, `maxPlanTasks`, and the scale confirmation thresholds bound a run.
- Plan approval and drive preflight show a labeled cost estimate and warn when projected reviewer spend is at least twice executor spend.
- Seven presets (`inherit`, `openai-balanced`, `openai-budget`, `openai-quality`, `anthropic-balanced`, `anthropic-budget`, `anthropic-quality`) set tier models, and the settings editor groups settings by how often they matter.

### Observability

- `/maestro board` is a phase-first dashboard (discovery, plan approval, execution, review, integration, verification, recovery, complete) that drills into tasks and launches, with steering templates, filters, and `?` for keys. `/maestro agents` is a session-style viewer for live and completed launches, and the agent selector labels every launch with its attempt number and outcome.
- The footer shows a progress bar, phase, running count, and spend. The drive heartbeat adds elapsed time, tasks left, the executor and review spend split, and a forward estimate. Toasts report each task as it settles.
- `/maestro costs` splits spend into landed, in flight, and sunk work, ranks tasks by cost, and warns when review spend meets executor spend. Drive summaries state cost per approved task. `/maestro insights` reports approval, cost, failure, and rejection rates per model and tier, including retry economics.
- `/maestro timeline`, `history`, and `reconcile` are model-free. `/maestro doctor` reports config, authenticated models, Git, managed worktrees, and stale approval proof.
- Run event logs are capped on whole lines and end with one `maestro_log_capped` marker.

### Reliability

- Claims record the owner's PID and start identity and stay held until the attempt, review, integration, and verification are saved. A claim whose owner is alive is never taken over, and startup fails any `running` task left without a claim. A second session on the same project leaves another live session's detached executors and drive alone. If the final write for an attempt fails, the task is still marked failed with its spend, and a claim that could not be released is retried. A zombie owner counts as gone, and the "task is dispatched" error names the owning process.
- Board locks use PID plus process start time, and two sessions reclaiming a dead lock cannot delete each other's. Board and config writes are atomic, and saving a symlinked config updates the file it points at. A corrupt board is moved aside as `board.json.corrupt-<timestamp>`, and a config file that is corrupt or invalid as `maestro.json.corrupt-<timestamp>` or `maestro.json.invalid-<timestamp>`, only if it is still the file that was read.
- Every launch uses its own event log and transport files, and a detached launch accepts only a terminal record carrying its launch id. An attached launch settles two seconds after pi exits and kills its process group. A launch pi settles with `aborted: true` without Maestro asking is recorded as a retryable failure, so an extension that cancels inside an executor can no longer finish the drive and archive the board. Malformed executor output is skipped with at most three diagnostics per launch.
- A reload or shutdown retires the drive: it launches nothing more, a running verification is cancelled, and promotion is refused. A task caught in verification or integration stays ready for review with no failure recorded. Startup cleanup never removes a checkout in use.
- A session is resumed only inside the checkout it recorded. An executor whose prompt pi reports as `handled` fails at once.
- Reading an agent transcript or run log with the model's read tools is blocked, because it can grow the orchestrator's own session on every read.
- Executor sessions live under pi's per-project session directory at `.maestro/<launch>/`, so usage tools count them while `/resume` stays short. `/maestro back` keeps its return target when a session switch is cancelled.
- Project-local `.pi/maestro.json` is honored only for projects pi trusts.
