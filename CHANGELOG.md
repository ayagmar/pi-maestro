# Changelog

## Unreleased

### Correctness

- Maestro's own git commits (attempt checkpoints, reviewed integrations, and worktree merges) are created with `--no-gpg-sign`, and every git invocation runs with a timeout and `GIT_TERMINAL_PROMPT=0`. Previously a user with `commit.gpgsign = true` working away from their signing key hit gpg waiting on a pinentry prompt that could never appear; because git runs synchronously on Pi's main thread with no timeout, that blocked the entire editor indefinitely and left the session unresumable.
- Parking a task checkout now refuses to remove it when its changes cannot be checkpointed onto the task branch, instead of force-removing the checkout and deleting the branch. A failed checkpoint previously discarded uncommitted executor work permanently.
- Reading an agent session transcript or run log is blocked before execution. Reading the orchestrator's own session appended a copy of the conversation to the file being read, so each read grew the next one; one real run reached ~178k tokens across four reads and could no longer be resumed.
- Isolated task checkouts are built from committed content, so uncommitted files a brief points at do not exist for the executor. A drive that isolates tasks now warns which uncommitted paths are invisible instead of letting every executor report itself blocked on a file the user can plainly see.
- Parallel non-worktree batches now auto-isolate in per-task worktrees (with a user notice) so concurrent executors can never cross-attribute each other's file changes; single-task dispatch keeps the shared checkout, and non-Git projects keep legacy behavior.
- Investigation runs that legitimately write a long report across turns without tool calls now count meaningful report growth as watchdog progress.
- Legacy investigation-phrased briefs (empty writePaths without `kind: "investigation"`) now produce an explicit deprecation notice at planning; the explicit kind is the supported path.
- Watchdog progress detection is now run-kind aware: investigation/discovery executors and reviewers progress through novel read-tool activity instead of being steered with implementation text and killed as stalled; only exact repeated actions count as no progress, and steering messages are phase-specific.
- Non-worktree executions now attribute file changes by content against a pre-run Git baseline, so bash-side mutations (sed -i, git apply, codegen) are included in touched files, candidate trees, and review scope; pre-existing user dirt is never attributed to the executor.
- Task contracts gained an explicit `kind: "investigation"` field replacing the brief-phrasing regex for no-file work; legacy investigation-phrased briefs remain accepted, and the kind flows through maestro_plan, maestro_update, recipes, plan export/import, and the contract fingerprint.
- Human-retry risk tokens no longer include `updatedAt`, so unrelated board touches between confirmation and dispatch cannot invalidate a confirmed retry; acceptance and integration evidence changes still do.
- Stale board locks now record the owner's kernel process start time on Linux, so a recycled PID can no longer keep a dead lock alive.
- Main-tree identity checks exclude `.pi/maestro.json` and `.pi/maestro-recipes/`, so editing maestro config or recipes mid-review no longer fails promotion with a spurious "main checkout changed".

### Added

- A Claude-style agent selector renders under the editor while executors run: one row per launch with a selection marker, live/settled glyphs, and right-aligned kind, elapsed time, turns, cost, and last activity. `ctrl+alt+j`/`ctrl+alt+k` move the selection without opening anything, `ctrl+alt+w` opens the centered viewer on the selected agent, and the selection stays in sync with the viewer's own `←/→` session switching.
- Review-rejection retries resume the rejected attempt's own session by default (`retryContext: "resume"`): the follow-up prompt carries only the reviewer's findings, the model keeps everything it already read, and providers bill the replayed history at cached rates instead of the executor re-reading the repository. Provider fallbacks, human retries, and discovery tasks always start fresh, and fresh retries include the predecessor attempt's report so they start from knowledge instead of archaeology. Validated end to end against a real pi executor: the retry appends to the same transcript, the resumed request carries the conversation history plus only the findings, and usage counts only new messages.

- Upgraded to the Pi 0.82.x package line (from 0.80.10), with peer ranges moved to `^0.82.1`. The real-executor integration tests pass against a 0.82.1 subprocess.
- `max` is now selectable as a thinking level. Pi has accepted `off`…`max` for some time, but maestro stopped its ladder at `xhigh`, so the strongest reasoning setting was unreachable from a tier. Config validation had a second hardcoded copy of the ladder that would have rejected `max` outright; it now derives from `THINKING_LEVELS`, and an invalid level names the accepted values instead of saying only "invalid thinking".

- `reviewPolicy` is now a project setting under Review, so a repository picks `single`, `confirm`, or `find-and-refute` once and new tasks inherit it. It was previously per-task only, settable at plan time or one task at a time in `/maestro plan`, which is how a whole board silently ended up on the most expensive policy. An explicit policy on a task still wins.

### Fixed

- Reviewer notes are distilled into findings from their numbered list items only; preamble lines ("Static review confirms:"), section headers, and the VERDICT line itself no longer become findings that get re-injected into retry prompts as if they were defects.
- Decision evidence injected into the owner conversation is character-bounded. The old bound counted lines, which a single enormous line (or a multi-task escalation with executor-report tails) never hit.
- A write-scope overlap caused by a broad glob now names the glob: "app/src/test/**" claims every file under that tree, and a real recovery plan burned a full model turn discovering that. The no_progress remedy for tasks blocked by an accidentally cancelled dependency (an aborted drive) now names the one-step fix: reactivate it with maestro_update cancelled: false.
- The auto-opened live agent pane can actually be dismissed now. Its footer promised "esc close" while escape only unfocused it, and the auto-open re-created it on the next update, so the pane read as unclosable. Escape now closes and suppresses it for the current drive, `ctrl+alt+w` cycles docked pane → centered focused viewer → closed instead of focusing the docked pane in place against the right edge, and the docked pane's footer shows the only hint that is actually reachable while it is unfocused.
- Typing a goal after `/maestro plan` on a new project no longer falls through to the empty review view with "Board is empty. Plan tasks with maestro_plan" — advice addressed to the model. The command now points at `/maestro start` with the typed goal intact, and the empty-board review warning names the human entry point.
- A terminal "completed" decision left unresolved by a closed session no longer blocks every other session from starting a drive; it is auto-resolved when a new drive reserves the board. Actionable decisions (escalations, blocks) keep their ownership guard, and the refusal now names the real blocker — which decision kind, which owning session, and the remedy — instead of the misleading "another session already owns an active or paused drive".
- The run budget bounds the board's lifetime spend — sunk cost of cancelled and superseded tasks included — so cancelling work never frees budget, and the warning reports the sunk share separately. Every executor and reviewer launch is additionally capped at the remaining run budget, so a launch dispatched just under the cap cannot overshoot it by a full attempt, and reviewer launches honor `maxCostPerReview`. `/maestro config budget <usd>` raises an exhausted budget in one deliberate step, and the budget_blocked guidance tells the model to ask the user instead of laundering spend through cancellations.
- Drive summaries count reviewer processes as launches, split executor from review spend, price the average billed launch over real launches, and report the per-drive delta beside board-lifetime totals — a no-op resume previously re-printed the whole board's historical spend as if it had just happened.
- Escalation decisions carry bounded executor evidence (report, touched files, per-task spend) beside the reviewer findings, one rejection failing four or more distinct criteria escalates immediately as an omnibus-task signal instead of re-billing a full retry cycle, and the recovery guidance distinguishes brief edits (resume) from supersession (drive the successor).
- Superseding a task rewires a paused drive's scope to the successor like dependencies, so `/maestro resume` no longer drives only the cancelled predecessor into a no-op completion; mid-run successor plans no longer re-enter the plan gate on workflow scale (drive preflight confirms scale once); write-overlap rejections against stopped work suggest `supersedesTaskId` in the same call; plans warn when one task bundles six or more criteria or eight or more write paths; a repeated identical inspect is labeled unchanged; single-task inspect includes the executor report, touched files, and structured findings; inspect evidence is character-bounded (the previous line-based bound never truncated single-line JSON); and prompts that inject only the first eight open findings disclose how many more remain.

- A reviewer can no longer approve work whose own report states it is unfinished. A real task was approved while the plan document it produced read `State: BLOCKED — the clean full non-device gate failed twice`, marking it done and unblocking six dependents on a foundation its author had disclaimed. Approval is now withheld when the executor report declares BLOCKED, INCOMPLETE, NOT DONE, or FAILED as its state, and the withheld verdict says so.

- A task stopped by `maxCostPerTask` is no longer retried at the same cap. The classifier marked cost-cap failures retryable, so a real board spent $12.14 on one task across three attempts, two of them killed at the identical $5 wall; the second was doomed the moment the first hit it. Recovery needs a larger cap or a smaller task, both human decisions.
- A cost-capped task now reports the cap and its spend instead of `no dispatch was attempted`, and points at `maxCostPerTask` rather than telling the user to write a successor brief for work that was cut off mid-flight with its edits intact.

- Plan rejections now explain how ids work. A real plan of seven tasks titled `Plan 012`..`Plan 018` set `dependsOn: ["T12"]`, because nothing said ids are assigned by maestro in array order rather than taken from plan or issue numbers. The `dependsOn` schema now states this, and a rejection names the ids that actually exist.
- Overlapping `writePaths` are reported once per file with all claimants, instead of once per task pair. One shared `README.md` across seven tasks produced twenty-one near-identical lines that buried every other problem in the same message.
- Superseding a task that is not replaceable now names the way out, which differs for `ready_for_review` and `running`.

- A drive whose remaining tasks all depend on a cancelled or failed task now names the unreachable root and how to clear it. It previously reported only `no dispatch was attempted` per task, leaving the user to trace the dependency chain by hand to discover the board could never progress.

### Changed

- Settings are grouped by how often they are worth revisiting. "Essentials" holds the preset, concurrency, spend cap, plan gate, auto-commit, and attempt limit; "How work runs" holds isolation and cleanup; runaway guards moved to "Safety limits", which most users never need to open. The previous layout put fifteen unrelated controls in one flat "Execution and safety" list.
- The subcommand menu offers one entry per action (25, down from 44). Nested leaves such as `plan export` are completed after their parent noun, and the `dash`/`dashboard` aliases still dispatch without competing with `board` in the list.
- `/maestro` help leads with the four commands most runs need, then groups the rest by situation instead of presenting one flat list.
- Presets now spread `DEFAULT_CONFIG` and state only what they change. Each previously restated all 24 settings, so adding one meant editing six presets; 132 lines of duplication removed with no behavior change.

### Testing

- Added `test/executor-integration.test.ts`: real `pi --mode rpc` executors driven end to end against a local scripted model server, covering the RPC transport, session writing, Git attribution, and integration commits with no provider account, no tokens, and no outbound network. It reproduces the mandatory-signing failure that froze the editor.
- Removed 24 structural assertions that only checked which file a function lives in. Gutting a function's body while keeping its name left every one of them passing, so they taxed refactors without protecting behavior; `test/boundaries.test.ts` now asserts capability boundaries only.
- Shared executor fakes moved to `test/helpers/executors.ts` instead of being re-declared per test.

### Security

- Project-local `.pi/maestro.json` is honored only for pi-trusted projects; untrusted repositories can no longer influence budgets, attempt caps, tier models, or tier tool lists.

### Configuration

- `maxCostPerReview` caps one reviewer launch separately from `maxCostPerTask` (0 inherits it), `reviewRejectionLimit` makes the escalation threshold configurable (integer 1–10, default 2), and `retryContext` chooses between resuming a review-rejected attempt's session and fresh-context retries. All three are validated, shown by `/maestro config`, and editable in the settings UI.

- Executor and review tiers may now override idle-seconds, warning-turn, and termination-turn watchdog thresholds while omitted values inherit the global settings.

### Observability

- Resumed rejection retries are marked on the attempt and `/maestro insights` compares retry economics per model/tier: average executor cost of retries that resumed the rejected session versus retries that started fresh, so the `retryContext` saving is measured instead of assumed.

- `/maestro insights` now renders a bounded, model-free aggregation over current and archived boards with per-model/tier attempts, first-review approval, approved-task cost, failure kinds, and reviewer rejection rates.
- Plan approval and drive scale preflight now show a clearly labeled projected-cost estimate, preferring archived per-model-and-tier launch averages before model pricing metadata and a documented static fallback.

### Performance

- Hot render paths (per-executor-event UI refresh) are throttled with a leading-edge coalescing scheduler; single refreshes stay synchronous, bursts collapse to one trailing render.
- The status bar and widgets read a zero-copy cached board view instead of cloning the board on every executor event.
- Interactive tool handlers (maestro_plan/maestro_update and drive decision recovery) wait for the board lock asynchronously, so cross-process contention can no longer stall the TUI event loop.
- macOS and BSD now also get PID-recycle-safe board locks via `ps` start-time identity (Linux keeps /proc).
- Board and config reads are cached by exact file identity (inode + size + mtime ns), and board lock contention now spins at fine granularity before backing off, reducing synchronous stalls on the interactive session.

### Reliability

- Delivered decisions get a watchdog. A decision wakes the orchestrator with exactly one model turn — and when that turn died mid-stream (one provider "overloaded" error was enough), nothing ever re-raised it: the board sat blocked for an hour while the orchestrator looked idly AFK, and the eventual wake-up re-billed the whole context as a cold cache. If a delivered decision stays unresolved with no board activity and no live launches for `decisionNudgeMinutes` (default 5), the owner session is re-nudged with the decision evidence, up to three times; any board write or launch resets the quiet interval, and a session reload re-arms the watchdog for a decision delivered by a dead process.

- Opt-in Unix detached executors now survive Pi exit through persisted JSONL control/event transport, PID+start-time recovery, long bounded dispatch leases, forced Git worktree isolation, and startup log-tail reattachment; reviewers and Windows retain attached RPC behavior.
- Verification logs are streamed to disk as output arrives, so a hard kill of pi retains partial verification evidence.
- Added a best-effort (non-blocking) Windows CI job for typecheck and tests.

## 0.1.0

### Orchestration

- Added plan, run, review, update, status, and drive tools for dependency-aware task workflows.
- Added optional plan approval and autonomous run/review/retry driving.

### Executors

- Nested fresh-context executor and reviewer transcripts under Pi's normal project session root so recursive usage accounting includes them without crowding `/resume`.
- Added fresh-context RPC child sessions with live steering and abort support.
- Added ordered model fallbacks, including quota-aware retries that do not consume the task attempt cap.
- Added per-attempt and whole-run cost caps.

### Git

- Added one automatic commit per approved task.
- Added optional worktree isolation for parallel tasks, with merge-then-delete cleanup after approval.
- Made physical task checkouts ephemeral: recoverable idle work is checkpointed on its task branch and restored only for retry, review, or inspection.

### Observability

- Added a phase-first live dashboard with steering templates, status filters, task and launch drill-down, and explicit current/attention/evidence phase states.
- Persisted review verdicts, task status history, and descriptive numbered attempt and review session names.
- Added board archiving and replay.

### Configuration

- Added built-in presets and an interactive settings UI.
- Added user and project configuration scopes, including primary and fallback model selection.

### Compatibility and release safety

- Added Node.js 22 and 24 CI coverage and bounded compatibility with the Pi `0.80.x` package line.
- Added packed-artifact content and extension-registration smoke testing.
- Added a security policy and automated dependency update configuration.
