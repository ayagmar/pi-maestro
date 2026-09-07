# Changelog

## Unreleased

### Robustness

- `maxRoundsPerRun` (default 20, 1–1000) replaces the fixed 20-round drive limit. One round is a loop pass that launched something; a clean sequential task costs one, every rejection retry, quota-interrupted launch or reviewer re-run costs another, so a long unattended drive could stop with `round_limit` while work was still runnable. The stop message now names the setting.

- A drive that sleeps for provider quota or a transient retry now says so everywhere. The active drive records `waiting {until, reason, taskIds}`; the status line shows `⚡ maestro waiting · ⏳ openai-codex 5h window exhausted · resumes 01:44 (in 1h 59m)`, the heartbeat pulse opens with `Drive waiting`, and the dashboard evidence names the deferred tasks. Previously a sleeping drive had no live executor and one provider-failed task, so every projection read `blocked · recovery` for hours while the drive was healthy — an operator watching a real board could not tell a wait from a stall.

- Provider failures are classified three ways. Transient drops (`WebSocket error`, connection reset, `socket hang up`, 5xx) retry twice with 15 s and 60 s delays. An exhausted quota or usage window (`usage limit has been reached`, `429`, `rate limit`) is waited out for up to `providerQuotaWaitMinutes` (default 360, 0 disables). Only credential, billing, and unknown-model failures stop at once. A real drive was stopped three times in one evening by a subscription window and each stop needed a human to type resume.
- Codex quota waits are exact, not guessed. On a Codex quota failure Maestro reads the account's usage endpoint (`chatgpt.com/backend-api/wham/usage`, the same source as the pi-sub-bar status line, authenticated with pi's stored OAuth token), finds the exhausted window's `reset_at`, and sleeps until that moment plus a 45-second grace — one wait, no probe launches. A weekly window exhausted beyond the wait budget stops the drive immediately with its reset time instead of burning probes. Providers without a published reset clock fall back to 2/4/8/15-minute probes.
- An attempt the provider cut off after real work resumes its own session and checkout with a continuation prompt instead of starting a fresh attempt; the interrupted attempt still never consumes `maxAttempts`. Two interrupted attempts on one task had thrown away $8.64 of context before a third began from scratch.
- Paused drives record why they stopped. Only a deliberate `/maestro pause` keeps its owner-session guard; `provider_blocked` and settled `escalation_required` stops can be resumed or released (`/maestro abort`) from any session. Previously a dead session's parked drive could only be cleared with `/maestro reset`, which archives the whole board.
- Handoff transfers the paused drive and the open decision to the fresh supervisor session. Before, the new session was told to "resume it from that session" — the one it had just left.

### Correctness

- Approval fingerprints no longer include the tier's model, thinking level, or reviewer tool set. The record keeps `version: 1` and marks the new hashing as `executionShape: 2`: a bumped version quarantined a real board 34 seconds after an upgrade, because a Maestro build still running in another pi session rejected the unknown version and moved the file aside. Which model produced or judged an artifact is provenance, not identity: the reviewed Git tree is unchanged by a configuration edit. Previously, switching executor models to dodge a provider quota marked every approved task on a real board `stale_completion` and offered re-executing $90 of integrated, reviewed work as the only remedy. Version-1 proofs remain valid as long as their contract, verification, dependency, and artifact identities still match; the next approval of a task captures a v2 proof. The task's tier name, review policy, and confirm count remain execution inputs.

- Executor commits made inside an isolated task checkout are now attributed to the attempt. Touched files, the candidate artifact tree, and the review diff include commits on the task branch since it forked from the main checkout, not only uncommitted files. A task whose brief legitimately required committing and pushing (a CI bootstrap that had to run remotely before it could be verified) previously left a Git-clean checkout, failed the "no attributable Git changes" gate twice, and had to be demoted to a read-only investigation to be approved. Artifact snapshots also tolerate committed deletions instead of aborting on an unmatched pathspec.
- Under `confirm` and `find-and-refute`, a `REQUEST_CHANGES` verdict with every criterion marked PASS is now a genuine rejection on grounds outside the enumerated criteria, not "malformed or inconsistent criterion evidence". Only approving while a criterion is FAIL is treated as a contradiction. Two confirm reviewers that had each found a real build-time misconfiguration were previously discarded as operational failures, billed, and the operator was pushed into downgrading the policy to `single`.
- Criterion evidence parsing accepts the shapes reviewers actually write — the requested `CRITERION 1: PASS — evidence`, Markdown headings such as `### Criterion 1 — title: **PASS**` with the evidence on the following lines, and bold list items — and lets a closing summary restate a criterion without being counted as a duplicate. The malformed-evidence message now says what was expected.
- A drive stopped by the pre-review artifact gate (no attributable changes, execution inputs changed, trusted verification failed) now says `artifact gate failed before any reviewer ran — T2: …` with the gate cause, and its recovery guidance no longer sends the operator to inspect reviewer evidence that does not exist.
- A successor created with `supersedesTaskId` inherits the predecessor's `dependsOn` in addition to taking over its dependents. A handoff task written as `dependsOn: []` previously became runnable before the work its predecessor had to wait for.
- Attempt and review launches record one model identity: the configured `provider/model` form wins when it names the reported bare id, so a task no longer shows `[openai-codex/gpt-5.6-sol]` while live and `[gpt-5.6-sol]` once settled, and per-model insight rows no longer split.
- Run event logs are capped on whole lines and end with a single `maestro_log_capped` marker instead of a truncated JSON fragment followed by silence. The live pane renders the marker as a notice and keeps judging the run's status from the last real event, so a capped log no longer looks like a hung run or a finished one.

### Added

- Cost-cap continuation: when an attempt is stopped by `maxCostPerTask`, raising the cap above what it spent (or disabling it) and driving the task again resumes that attempt in its own checkout and session with a continuation prompt, instead of requiring a hand-written successor. Driving under the unchanged cap is still refused without billing; the failure guidance names the checkpoint branch and the exact threshold to raise.
- The agent strip labels every launch with its attempt number and outcome (`T14 run #3 ●`, `T14 review #2 ✗`, `T14 review #1 ✓`), so retries of the same task are no longer three identical tabs.

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

- Cross-session recovery for mechanical stops: budget_blocked, aborted, launch/round limits, provider blocks, and internal errors can now be resumed by any session once the cause is addressed — only judgment decisions (escalation, review disagreement, stale completion, reviewer failure, attempt cap) keep their owner-session guard. Three real recoveries previously required hand-editing persisted board state.
- `/maestro config budget <usd>` now resolves a pending budget_blocked decision in the same step when the new budget clears current spend, and a running drive re-reads the budget at every boundary so mid-drive raises take effect without a restart. A one-time notice fires at 80% budget consumption so the wall is never a surprise.
- Outcome toasts: `✓ T18 approved · $19.01`, `↻ T17 changes requested: …`, and `✗ failed` notifications the moment a task settles, instead of silence until the drive summary.
- The agent selector shows each live run's lifecycle phase and a red `⚠` steered marker when the watchdog has warned it; settled reviewer rows show their verdict (`✓ approved` / `↻ changes requested`) instead of a generic "settled".
- The drive heartbeat adds the executor/review spend split and a forward cost estimate (`est. ~$45 to finish at current avg`); `/maestro costs` warns when review spend meets or exceeds executor spend.
- The dashboard task view shows the executor/review cost split and the full supersession lineage (`T12 → T14 → [T21]`), so a recovery-heavy board explains itself.
- `pushOnIntegration` setting: best-effort push of the main branch after every approved integration, backing landed work up off-machine as it lands. A push failure never blocks or reverts an approval.
- Per-task `reviewGuidance` on maestro_plan/maestro_update: an orchestrator hint injected into review prompts (which slices or properties to verify on a large artifact) — the alternative to hand-building validation-task pipelines around one oversized review. Included in the review identity contract and plan export/import.
- Zero-turn environment failures back off briefly (2s) before retrying so a transient PATH blip cannot burn drive rounds in seconds.
- Settings: the run-cost picker includes the current value plus $500/$1000 rungs and points at `/maestro config budget` for arbitrary amounts, and a custom config names its nearest preset and the exact fields that differ.

- Progress is visible at a glance everywhere a run is watched. The status bar shows a live progress bar over still-landable work with the current phase (`⚡ maestro running · execution · ▰▰▰▱▱▱▱▱▱▱ 5/16 (31%) · 2 running · $84.21`), the drive heartbeat pulse leads with elapsed time, the same bar, tasks left, and this drive's own spend beside the board total, round updates open with `5/16 approved`, and the working message carries the fraction.
- A "Watchdog & logging" settings section exposes the previously config-file-only knobs: idle seconds before steering, no-progress turns before steering, post-steer termination turns, the automatic-handoff context threshold, run event log detail, and the run log size cap. The run cost cap choices now extend to $300 and per-attempt to $20, matching what real multi-task boards need.

- A Claude-style agent selector renders under the editor while executors run: one row per launch with a selection marker, live/settled glyphs, and right-aligned kind, elapsed time, turns, cost, and last activity. `ctrl+alt+j`/`ctrl+alt+k` move the selection without opening anything, `ctrl+alt+w` opens the centered viewer on the selected agent, and the selection stays in sync with the viewer's own `←/→` session switching.
- Review-rejection retries resume the rejected attempt's own session by default (`retryContext: "resume"`): the follow-up prompt carries only the reviewer's findings, the model keeps everything it already read, and providers bill the replayed history at cached rates instead of the executor re-reading the repository. Provider fallbacks, human retries, and discovery tasks always start fresh, and fresh retries include the predecessor attempt's report so they start from knowledge instead of archaeology. Validated end to end against a real pi executor: the retry appends to the same transcript, the resumed request carries the conversation history plus only the findings, and usage counts only new messages.

- Upgraded to the Pi 0.82.x package line (from 0.80.10), with peer ranges moved to `^0.82.1`. The real-executor integration tests pass against a 0.82.1 subprocess.
- `max` is now selectable as a thinking level. Pi has accepted `off`…`max` for some time, but maestro stopped its ladder at `xhigh`, so the strongest reasoning setting was unreachable from a tier. Config validation had a second hardcoded copy of the ladder that would have rejected `max` outright; it now derives from `THINKING_LEVELS`, and an invalid level names the accepted values instead of saying only "invalid thinking".

- `reviewPolicy` is now a project setting under Review, so a repository picks `single`, `confirm`, or `find-and-refute` once and new tasks inherit it. It was previously per-task only, settable at plan time or one task at a time in `/maestro plan`, which is how a whole board silently ended up on the most expensive policy. An explicit policy on a task still wins.

### Fixed

- Zero-turn process failures (spawn ENOENT, immediate crash before any model turn) no longer consume maxAttempts. A transient PATH blip burned all four of a real task's attempts on "spawn pi ENOENT" at $0 each and forced a supersession to recover; environment failures now retry without touching the cap, still bounded by drive rounds and the launch limit.
- Programmatic handoff actually hands off now. `maestro_drive` intervene=handoff and the automatic context-pressure handoff both queued `/maestro handoff` through `sendUserMessage`, which dispatches extension commands only when `expandPromptTemplates` is true (its default is false) — so the literal text landed in the conversation, the model replied conversationally, and no session replacement ever happened. Both paths now request command dispatch explicitly.
- Novel tool activity now counts as watchdog progress for every run kind, not just investigations and reviews. The mutation-only progress rule killed five real doc/planning implementers at exactly warning+termination turns (~$37) while they read the input documents their briefs required; doom loops still stall because repeated actions and silence still leave the watchdog armed.
- A cost-cap failure now names the bound that actually cut the attempt off. When the run budget's remainder (not maxCostPerTask) was the binding launch cap, the failure blamed maxCostPerTask and told the operator to raise the wrong knob — a real board burned two more attempts against a $1.09 budget remainder labeled as the per-task cap.
- A drive no longer dispatches launches whose cost cap would be a near-exhausted run budget's dregs (below 25% of the per-attempt cap, or $0.50 when that cap is off); it stops with budget_blocked before spending, matching the exceeded-budget behavior.
- Editing a task's brief or success criteria now clears its recorded reviewer findings along with the rejection counters. Stale criterion-numbered findings from the old contract were re-injected into every retry executor prompt ("Address every point") and reviewer prompt ("Explicitly verify every prior finding"), wasting tokens on superseded feedback, and counted toward omnibus escalation — a single new rejection under the rewritten contract could falsely stop an unattended drive with escalation_required. Tier edits keep findings: the contract they describe is unchanged.
- An acknowledged in-flight invalidation (`invalidateInFlight: true`) now also clears `reviewStagnantRejections` alongside `reviewNotes` and `reviewRejections`, so a task re-executed under a new contract no longer inherits stale stagnation evidence that made it escalate one rejection early.
- Plan simulation no longer silently hides wave members beyond `maxParallel`; the overflow is shown as "+N more, throttled by maxParallel".
- Removed dead code: the unused `EXTENSION_NAME`, `STATE_ENTRY_TYPE`, and `REPORT_PREVIEW_LINES` constants, the unused `MAESTRO_COMMAND_ALIASES` duplicate of the dispatcher's alias handling, the unreferenced `inspectBoardStorage` and `reserveClaimedAttempt` board helpers, the unreferenced `reportPreview` summary helper, and a git-invocation env spread that was immediately overridden.
- Removed dead test-support code: two never-called underscore-prefixed helpers in the extension test suite and a write-only `_lastActivity` variable in the detached supervisor.
- A stale provider-failed review launch no longer masks a fresh pre-review gate settlement: after a config change staled an executed candidate, the drive reported "provider_blocked — configure a fallback" off the old launch record while the real cause was the fingerprint gate. Gate settlements now carry a structured cause and take precedence in diagnosis.
- Tier `fallbacks` are no longer part of the task fingerprint: a fallback list is dispatch resilience, not work identity, and including it invalidated every in-flight candidate the moment an operator added provider redundancy — exactly when re-executing everything is least affordable. Model, thinking, and tools changes still invalidate as before.
- A watchdog kill caused by complete provider silence (not one event, not one turn after steering) is classified as a provider failure instead of a stall, so an OpenAI outage no longer consumes one of the task's real attempts — the launch falls back or retries without burning the cap. The post-steer grace period also anchors to the last event instead of the steer time, so a model that is still streaming reasoning is never killed mid-thought. Turn-producing no-progress stalls still consume attempts.
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

- Cost reporting answers "what did the money buy?" directly: `/maestro costs` splits spend into landed (tasks that reached approval, their rejected attempts included), in flight, and sunk in cancelled work, and drive summaries state cost per approved task — or "no approvals yet" when the spend is all churn.
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
