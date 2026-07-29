# pi-maestro

[![MIT licensed](https://img.shields.io/badge/license-MIT-d9a520.svg)](LICENSE)
[![Node.js 22 or 24](https://img.shields.io/badge/node-22%20%7C%2024-2f6f44.svg)](package.json)
[![Pi 0.82.x](https://img.shields.io/badge/pi-0.82.x-243746.svg)](https://github.com/badlogic/pi-mono)

Orchestrator/executor workflows for [pi](https://github.com/badlogic/pi-mono).

The model in your interactive session becomes the **orchestrator**: it plans a goal into small
tasks, delegates each task to a cheap **fresh-context executor** (a separate `pi` process), and an
**adversarial reviewer** independently verifies each result before automated approval. Adversarial
review and read-only reviewer tools are the defaults; manual status overrides and a custom reviewer
`tools` allowlist can bypass those guarantees. The orchestrator never reads raw executor output —
it works off short reports and status pulses, so its context stays clean and your expensive model
spends tokens on judgment, not typing.

```
you ──▶ orchestrator (SOTA model, your session)
              │ maestro_plan          ┌────────────────────────────┐
              ▼                         │ .pi/maestro/board.json   │
        task board  ◀──────────────────▶│ logs/  history.jsonl       │
              │ plan approval (optional) └────────────────────────────┘
              │ /maestro drive or maestro_drive
              ▼
   executors in parallel (cheap models, fresh context each)
              │ adversarial review (drive continues automatically)
              ▼
   adversarial reviewers (default config: read-only tools, fresh context)
              │ approve / request changes
              ▼
        approved tasks ──▶ orchestrator summarizes for you
```

## Why

- **Lower cost per run.** The orchestrator (expensive model) only plans, dispatches, and reads
  short reports. Executors run on cheaper models with per-tier thinking levels.
- **No context rot.** Every executor and reviewer starts with a fresh context containing only its
  self-contained brief (plus approved dependency reports). Routine progress streams into the live tool result and the dashboard; the orchestrator's context only ever receives one bounded settled outcome per drive.
- **Independent review by default.** The automated path sends every task through an adversarial
  review with read-only tools before approval. Rejected work is retried with the reviewer's notes
  injected into the next attempt. Manual approval skips that review, and configuring writable
  reviewer tools removes the read-only guarantee.
- **Bounded review convergence.** Tasks default to one reviewer and may opt into independent
  confirmations or a finder/refuter pair. Every launch, verdict, criterion evidence, model,
  provider, and usage record is retained; disagreement and operational failure stop once with an
  actionable decision instead of retrying indefinitely.
- **Deterministic and observable.** Task state lives in `.pi/maestro/board.json`; audit history
  and raw event logs live beside it. Executor sessions are nested under pi's normal project
  session directory: recursive usage accounting still sees them, while the ordinary `/resume`
  picker stays focused on human sessions. You can switch the TUI into any completed agent session.

## Install

```bash
pi install git:github.com/ayagmar/pi-maestro
# or from a local checkout
pi install /path/to/pi-maestro
```

## Compatibility and support

Pi Maestro requires Node.js 22 or 24 and is tested against the `0.82.x` Pi package line. Its peer ranges intentionally stop before `0.83.0`; newer Pi releases require an explicit compatibility update rather than being accepted silently. Before `1.0.0`, only the latest published `0.1.x` release receives fixes.

Report bugs through [GitHub Issues](https://github.com/ayagmar/pi-maestro/issues). Report suspected vulnerabilities privately using the repository Security tab; see [SECURITY.md](SECURITY.md).

## Five-minute start

1. Install the extension with the command above.
2. Run `/maestro` to open the project control center, then choose **Check setup and recovery**.
3. Choose **Start a new goal** there, or run `/maestro start <goal>` directly.
4. Let the orchestrator create tasks with explicit success criteria and write scopes.
5. If `planGate` is enabled, inspect and approve with `/maestro plan`.
6. Start or resume with `/maestro drive`; use `/maestro timeline` for model-free history.

### Start an orchestrated run

```
/maestro start migrate the auth module to the new session API and add tests
```

This injects an orchestrator briefing into your current session. The model then drives the loop
with these tools:

| Tool | What it does |
|------|--------------|
| `maestro_plan` | Creates tasks with self-contained briefs, complexity tiers, dependencies, and bounded write scopes |
| `maestro_update` | Refines or cancels planned work |
| `maestro_drive` | Runs the state-aware run/review/retry loop to settlement, inspects it, or intervenes in live work |

Human-only slash commands and dashboard controls provide planning approval, drive, pause/resume/abort, simulation, timeline, reconciliation, and recovery without adding model-facing tools.

You can also call these tools yourself in plain prompts ("plan these three tasks…"), or manage the
board manually — the workflow is just tools plus a JSON file. If you already have a plan (design
doc, issue list), paste it and ask the model to turn it into `maestro_plan` tasks; `start` is
for when the decomposition itself needs the expensive model's judgment.

### Two-phase orchestration: plan, then hand off

Planning fills the orchestrator's context with investigation noise (file reads, greps, dead
ends) that is useless during execution — and stale reasoning can anchor the model to outdated
approaches. Because task briefs are self-contained by design, all durable state lives on the
board, so the planning context is disposable once the plan exists.

`/maestro handoff` starts a fresh session where a supervising orchestrator takes over from
the board alone: goal + task list + tier guidance, none of the planning tokens. It drives
run/review/retry and is instructed not to re-plan unless a task keeps failing. The planning
session stays on disk (`/resume` to revisit). The orchestrator briefing suggests the handoff itself when planning required heavy investigation. At the configured context threshold, Maestro queues the existing handoff command once it reaches a safe boundary; executor sessions do not receive it.

Recommended flow for large goals:

```
/maestro start <goal>          # expensive model investigates + plans
  …review the board, adjust…     # /maestro board, tweak briefs/statuses
/maestro handoff               # fresh supervisor drives execution with a clean context
```

For small goals, skip the handoff — one session is fine. You can also start the autonomous loop
from the current session with `/maestro drive` (or let the model call `maestro_drive`). It runs
independent work in parallel, reviews completed attempts, carries review feedback into retries,
and waits for approved dependencies before advancing them. When the model calls `maestro_drive` action=start,
that one tool call spans the whole loop: round-by-round progress streams into the live tool result, and the
call returns only when the board settles or a decision needs orchestrator judgment. The orchestrator therefore
spends one turn on an entire drive instead of polling it — polling turns re-send the conversation, evict the
prompt cache, and change nothing. A drive started from `/maestro drive` still reports through a bounded wakeup
message, as do unexpected background failures, so a supervisor is never left waiting on a drive that already
stopped. `maestro_drive` inspect returns bounded evidence for a board this session is not currently driving and
accepts an optional task scope; a decision already resolved is treated as history and is not re-surfaced.
`/maestro pause` requests a safe stop:
active executors finish, but no new executor batch starts. `/maestro resume` later continues the same
task scope from the board's fresh persisted state; `/maestro abort` instead aborts active executors.
The loop stops when work is complete or when a pause, plan gate, run budget, attempt cap, provider
block, repeated-rejection escalation, abort, blocked state, error, or its 20-round safety limit
requires intervention. Escalation is driven by stagnation rather than rejection count: once a task
reaches the rejection limit, the drive stops only if a reviewer repeated a finding an earlier attempt
was already told to fix. A task whose reviewer keeps raising genuinely new findings is still
converging and keeps its remaining attempts. The escalation notice names the repeated finding
fingerprints alongside the evidence, current tier, and a recommended next tier or
rewrite/split/cancel; changing the brief or tier — or an explicit scoped `/maestro drive` — resets the
counters so a chosen intervention can continue via `/maestro resume`. Approving a task marks its
outstanding findings verified, so resolved feedback is never re-injected into later prompts. At each decision point the
orchestrator chooses autonomously among the configured fallback/resume, `maestro_update`
(brief/tier/dependencies), a `maestro_plan` split, cancellation, or asking you when scope or cost
judgment is required; it never blindly retries a blocked provider or raises the project
`maxAttempts` to force another attempt. At an attempt cap, changing the capped task's tier or brief
cannot make it runnable because its consumed attempts remain. Create a narrowly scoped successor
whose title and brief identify the capped task and set its `supersedesTaskId` to the predecessor.
Maestro atomically keeps the predecessor visible as cancelled and rewires downstream dependencies;
then start `maestro_drive` for the successor and rewired dependents. Settled completion and intervention summaries stay on the
next pulse until the owning session observes them once, so a stray status call from another session
cannot discard them. An optional task-id list
limits the drive to those tasks. Session switches are blocked while a drive or executor is active;
pause and wait (or abort) before switching.

With `planGate` enabled, use an explicit plan-approve-drive flow. The gate validates dependency
references, dependency cycles, and configured tiers before any executor or reviewer starts.
`/maestro plan` starts with a read-only overview of every pending task, including criteria, write
scope, verification, review policy, commit message, and workflow preflight. Preflight clearly labels
its projected cost as an estimate: archived per-model-and-tier launch averages are preferred, then
model pricing metadata assumes 20,000 input and 4,000 output tokens per launch, and unresolved
models use a static $0.10-per-launch fallback. Each task offers a
read-only full-brief viewer plus editing for its title, brief, tier, dependencies, criteria, write
scope, commit message, verification profile, and cancellation state. Choose **Save changes** to
validate and persist the draft, or **Cancel editing**/Esc to discard it. Invalid plans remain
pending and unchanged until the listed task ids, references, cycles, or tiers are fixed. The same
fields remain available through `maestro_update`. Contract edits (`title`, `brief`, `successCriteria`,
`tier`, `writePaths`, `verificationProfile`, `reviewPolicy`, `dependsOn`, or `commitMessage`) are
rejected while a task is `running` or `ready_for_review`, because they invalidate paid work. If
that invalidation is intentional, pass `invalidateInFlight: true`; Maestro applies the edit and
returns a warning with the attempt cost. Cancellation and other non-contract updates remain
available without the override.

```
/maestro start <goal>          # maestro_plan leaves the new plan pending
/maestro plan                  # inspect summaries/full briefs, then Approve plan or Reject plan
/maestro drive                 # available after approval; rejection archives and clears the board
```

### Task lifecycle

```
todo ──run──▶ running ──▶ ready_for_review ──review──▶ approved
                 │                              │
                 ▼                              ▼
               failed                  changes_requested ──run──▶ running (retry with notes)
```

### Watch and intervene

- **Footer status**: `⚡ maestro 2/5 · 2 running · $0.1234` — live while executors run.
- **Live widget** above the editor shows each running executor: task, turns, cost, current tool.
- **`/maestro board`** (or `ctrl+alt+b`): phase-first project dashboard. It opens on the current
  workflow phase, then `→` drills into that phase's tasks and again into executor/reviewer launches;
  `←` moves back up. Live transcripts and evidence refresh without model calls. The durable run view uses
  **discovery → plan approval → execution → review → integration → verification → recovery →
  complete**, then task and launch evidence. Each phase distinguishes the current phase, a recovery
  phase that needs attention, retained historical evidence, and phases with no evidence; its detail pane
  explains purpose, task-state counts, and the next action. Phase and status refreshes are mechanical and
  never wake a model. Press `?` for the complete dashboard keybinding guide. From the dashboard you can:
  - `↑↓` select within the current phase/task/launch level, `→` drill in, `←` go back, and
    `PgUp/PgDn` scroll the selected transcript
  - `s` **steer a running executor** — choose **Stop - wrong approach, report current state**,
    **Run the project checks before finishing**, **Stay strictly within the task brief scope**, or
    **Custom message...** (which opens a text input). The message is queued into that executor's
    next LLM call (executors run in RPC mode, so mid-run steering works like it does in pi itself).
    The chooser scrolls to keep the selected template visible in short terminals.
  - `x` abort a running executor (task becomes `cancelled`)
  - `a` explicitly accepts eligible `ready_for_review` work after artifact checks (a manual
    review bypass); `m` opens the manual-status selector for any non-live, nonterminal task; `r`
    invokes the same centralized retry eligibility and confirmation path as `/maestro retry`,
    preserving prior attempts and recovery references
  - `g` cycle compact workflow-group filters: blocked, ready, running, review needed, approved,
    failed, and cancelled. The selected-task pane lists unresolved blockers, failure/review notes,
    recent attempts, model/provider, turns, cost, and changed files.
  - `f` hide/show settled tasks (approved and cancelled) to focus on remaining work
  - `t` switch the selected pane between the live transcript and derived task timeline
  - `enter` open the selected completed executor/reviewer session in your TUI when the drive is idle
- **Failure and retry actions**: use `/maestro retry T1`, the compact picker, or dashboard retry.
  Running tasks and attempt-capped tasks are refused; capped work needs a successor. Retrying
  accepted or integrated work requires confirmation, and execution retry is isolated even when
  normal worktrees are disabled. Changes-requested tasks carry reviewer notes into the same retained
  recovery attempt where safe. Rewrite a repeatedly failing brief with `maestro_update` when the
  contract itself is wrong.
  Maestro tracks two different counts per task: **launches** (every raw executor process start,
  including provider failures and model fallbacks) and **attempts** (launches that consumed the
  `maxAttempts` cap). A provider failure before useful work — an auth/rate-limit/quota error
  before any model turn — is a launch but not an attempt, so it never counts against
  `maxAttempts`; only launches that produced real work count.
- **`/maestro simulate [taskIds]`**: deterministic, read-only preview of dependency waves, concurrency, caps, and blockers. It assumes every run/review succeeds; it does not predict quality, cost, or spawn children.
- **`/maestro open T3`**: switches your TUI into that executor's persisted session so you can
  inspect exactly what it did — or continue working in it by hand. `/maestro back` returns to the
  previous session. Persisted session names identify the task and always number the run, for
  example `T3 Add replay support · attempt 1` and `T3 Add replay support · review 1`.
- **`/maestro start`** on a non-empty board archives the previous run first — each goal gets a
  fresh board, and old runs stay recoverable under `.pi/maestro/archive/`.

### Configuration

`/maestro config` opens an interactive settings editor (user scope by default,
`/maestro config project` for repo scope, `/maestro config show` to print the resolved
config). Every row has a description; changing any value switches the preset to `custom`.

**Presets** ship with defaults derived from the Artificial Analysis Coding Agent Index v1.1
and deep SWE leaderboard (pass@1 / avg cost per run):

| Preset | trivial | standard | complex | review | Parallel / attempts / attempt cap / run cap | Rationale |
|--------|---------|----------|---------|--------|----------------------------------------------|-----------|
| `inherit` (default) | pi default · low | pi default · medium | pi default · high | pi default · high | 3 / 3 / $5 / $25 | Works with any provider, zero setup |
| `openai-balanced` | terra · high | sol · medium | sol · high | sol · medium | 3 / 3 / $5 / $25 | Best cost/quality knee per tier (sol-high: 69% @ $3.47) |
| `openai-budget` | luna · high | terra · high | terra · xhigh | terra · xhigh | 4 / 3 / $2 / $25 | Cheapest sensible run (terra-xhigh: 60% @ $2.13) |
| `openai-quality` | sol · medium | sol · high | sol · xhigh | sol · high | 3 / 4 / $5 / $25 | Frontier on every tier (sol-xhigh: 71% @ $4.70) |
| `anthropic-balanced` | sonnet-5 · low | sonnet-5 · medium | opus-4-8 · high | fable-5 · high | 3 / 3 / $5 / $25 | Claude capability ladder; frontier model on read-only review |
| `anthropic-budget` | haiku-4-5 · medium | sonnet-5 · medium | sonnet-5 · high | sonnet-5 · high | 4 / 3 / $2 / $25 | Cheapest sensible Claude run |
| `anthropic-quality` | opus-4-8 · medium | opus-4-8 · high | fable-5 · high | fable-5 · high | 3 / 4 / $5 / $25 | Frontier Claude on every tier |

Preset models are provider-qualified (`openai-codex/gpt-5.6-sol`, `anthropic/claude-sonnet-5`),
so executors always run on that provider and fail fast with a `/login` hint if it is not authed.

All presets set `planGate`, `livePanes`, and `useWorktrees` to `false`; all set `maxRunCost` to $25.

Config files are plain JSON if you prefer editing by hand — user scope
`~/.pi/agent/maestro.json`, project scope `.pi/maestro.json`. Resolution is defaults, then user,
then project. Top-level fields merge by key; `tiers` merge by tier name, with the later scope's
whole tier object replacing the earlier object of the same name. Project config is honored only
for projects the user told pi to trust; in an untrusted project every setting stays at the
trusted user/default value:

```json
{
  "maxParallel": 4,
  "planGate": true,
  "useWorktrees": false,
  "detachedExecutors": false,
  "maxAttempts": 3,
  "maxCostPerTask": 2,
  "maxRunCost": 25,
  "statusWaitSeconds": 60,
  "tiers": {
    "trivial":  { "model": "gpt-5.6-terra", "thinking": "high" },
    "standard": {
      "model": "gpt-5.6-sol",
      "fallbacks": ["gpt-5.6-terra", "openai/gpt-5-mini"],
      "thinking": "medium"
    },
    "complex":  { "model": "gpt-5.6-sol", "thinking": "high" },
    "review":   { "model": "gpt-5.6-sol", "thinking": "medium", "tools": "read,grep,find,ls" }
  }
}
```

- `maxParallel` — maximum executor or reviewer processes run concurrently (default 3).
- `maxPlanTasks` / `maxDiscoveryGeneratedTasks` — hard workflow task limits (defaults 64 / 32).
- `maxTotalLaunchesPerRun` — combined raw executor and reviewer launch limit per drive (default 128).
- `confirmationPlanTasks` / `confirmationTotalLaunches` — explicit scale-confirmation thresholds (defaults 24 / 64).
- `reviewRequiredApprovals` — fresh approvals required by `confirm` (default 2, range 2–8). The
  full panel is spent on contested work. Once an intact panel has already approved the current
  attempt, a re-review forced by a mechanical failure (merge conflict, changed artifact, verification
  retry) charges a single confirmer instead of re-deriving the same verdict at full price; any
  genuine rejection on the attempt restores the full panel.
- `maxReviewerLaunches` — hard cap including reviewer provider fallbacks (default 4, range 1–16).
  Dependencies can reduce the number that are runnable at once.
- `planGate` — when enabled, the initial non-empty `maestro_plan` marks a new board pending and both
  `/maestro drive` and `maestro_drive` refuse to start executors. Once execution has begun, the
  orchestrator may add recovery or successor tasks without reopening the gate. Recipe and discovery
  expansion retain their explicit approval gates. `/maestro plan` lists task metadata,
  can display a full brief, and offers **Approve plan** or **Reject plan**. Approval opens the gate;
  rejection archives the board and, after confirmation, clears it (default false).
- `useWorktrees` — when enabled, every runnable task, including a one-task dispatch, gets an
  isolated git worktree and branch. Reviewers use the executor's worktree. Approval commits its changes,
  serializes merges into the original tree, then deletes the worktree and branch. A merge conflict
  is aborted, changes the task to `changes_requested`, and retains the checkout, branch, and
  recovery notes; the next retry reuses that worktree (default false).
- `detachedExecutors` — opt-in Unix executor survivability (default false). Git projects force each detached executor into its own task worktree. Because Pi RPC is stdio-only and cannot reconnect to an abandoned pipe, Maestro uses a detached supervisor with persisted JSONL event/control files. The supervisor auto-cancels UI requests, applies watchdog and cost-cap termination, enforces compact/full complete-line logging and byte caps while the parent is absent, records an atomic terminal outcome, and lets `session_start` reattach by incremental log tail. Reattached runs remain steerable and abortable; if they settle while Maestro is absent, startup reconstructs their outcome before review. Reviewer launches remain attached to the supervising runtime, and Windows falls back to the normal attached transport with `taskkill /t` descendant cleanup on abort/timeout; that Windows path remains best-effort until a hosted Windows run passes.
- `autoCommit` — commit each task's approved work as one conventional commit (default on).
  Maestro's own commits (attempt checkpoints and reviewed integrations) are always created with
  `--no-gpg-sign`. They are mechanical bookkeeping, and signing them would make the drive depend on
  an interactive passphrase: with `commit.gpgsign = true` and no reachable signing key, gpg blocks on
  a pinentry prompt that cannot appear from a remote or headless session. Your own commits are
  unaffected. Every git invocation also runs with a timeout and `GIT_TERMINAL_PROMPT=0`, so no git
  command can ever hang the editor.
  The commit message comes from the task's `commitMessage` (the orchestrator plans one per
  task, e.g. `fix: handle empty board`) or falls back to `feat: <title>`. Main-tree runs
  commit only the files the executor touched; worktree runs use the message for the merge
  commit. A failed commit or missing artifact proof blocks automated approval and preserves recovery evidence.
- `maxAttempts` — hard cap on execute attempts per task (default 3), counting only launches that
  produced real work (see raw launches vs. attempts above). Stops orchestrator retry loops. A capped
  task cannot be made runnable by changing its brief or tier because its consumed attempts remain.
  Recover with one `maestro_plan` successor using `supersedesTaskId`; Maestro atomically cancels the
  predecessor and rewires downstream dependencies before saving. Then start a scoped `maestro_drive`
  for the successor and rewired dependents. Never raised automatically as a recovery action — only an explicit edit in
  `/maestro config` changes it.
- `maxCostPerTask` — abort a launch when it exceeds this USD cost (default $5; 0 disables the cap).
  Applies to executor attempts and to each reviewer launch, so a runaway reviewer cannot outspend
  the executor it is checking. Safety net against a stuck launch burning tokens unattended.
- `statusWaitSeconds` — heartbeat interval for an awaited drive (default 60, maximum 240; 0
  disables it). Each pulse reports live agents, spend so far, and which tasks advanced since the
  previous pulse. Pulses are live tool updates: they keep a long round visibly alive without
  entering the orchestrator's context or costing a turn. Only a decision or completion becomes a
  bounded message.
- `maxRunCost` — gate new executor batches once total cost recorded across the board exceeds this
  USD amount (default $25; 0 disables the cap). The settings editor offers off, $5, $10, $25, and $50. A blocked
  `/maestro drive` reports the budget warning and stops before another batch; `maestro_drive` stops
  with the same warning. Already-running executors are not aborted, reviews can still run, and
  `maxCostPerTask` continues to enforce its separate per-attempt cap. Because gating happens before
  a batch, its concurrent executors can take the recorded total beyond the cap before the next gate.
- `model` — a pi model pattern. Bare names like `gpt-5.6-terra` are resolved against providers
  you actually have auth for (preferring the orchestrator's provider); `provider/id` pins one
  provider. Omit to inherit pi's default model.
- `fallbacks` — ordered model patterns for an executor tier. Unavailable patterns are skipped at
  preflight. At runtime maestro advances when the current provider/model fails before any model
  turn or reports quota/rate-limit exhaustion mid-run; that provider failure is recorded but does
  not consume `maxAttempts`. Other failures after a turn do not fall back. The settings UI has a
  searchable fallback row for every tier and edits the first fallback; edit `fallbacks` in JSON for
  longer chains. Review configuration accepts the same tier shape, and review launches use the same
  provider-failure fallback rules. Each raw review fallback launch counts toward
  `maxReviewerLaunches` and remains attached to its logical reviewer.
- `thinking` — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Per GPT-5.6 guidance: start
  medium, test one level lower, raise only when results show a gain.
- `tools` — comma-separated allowlist passed to the executor. Every preset's `review` tier defaults
  to `read,grep,find,ls`, so automated reviewers are read-only by default. This field is
  configurable: adding `bash` or other write-capable tools removes that guarantee; this is not a
  machine sandbox. Trusted verification commands remain the supported place for operator-selected checks. Manual approval from the board
  or task picker bypasses the reviewer entirely.
- You can add your own tier names; the orchestrator's planning guidance lists them.

Before an execution dispatch, maestro resolves the primary and fallbacks for every tier used by
that batch and fails with an actionable message if none are available. Before review, it resolves
that tier's primary and fallback models the same way. This happens before spawning executors.

### Safety and reconciliation

When `useWorktrees` is `false`, parallel batches (more than one runnable task with `maxParallel > 1`) are still automatically isolated in per-task worktrees under `.pi/maestro/worktrees/`, with a notice, because a shared checkout cannot safely attribute concurrent changes. Single-task batches continue to use the shared checkout, while non-Git projects retain the legacy shared-directory behavior.

When worktrees are enabled, every attempt—including a single task—runs in an isolated checkout. Once no executor or reviewer is using it, Maestro checkpoints recoverable edits on the task branch and removes the physical checkout. Review or retry restores that checkout only for the duration of active work; clean idle branches are deleted too. Git status is authoritative for staged, unstaged, and untracked paths; an empty path list never broadens a commit. New executable tasks require 1–12 explicit `successCriteria` plus bounded `writePaths`; explicit `kind: "investigation"` tasks (read-only/no-file work) use an empty scope, get investigation-appropriate watchdog progress detection, and legacy investigation-phrased briefs remain accepted. Declared paths prevent independent overlapping plans and make unpredicted changes visible to the reviewer. They are scheduling guidance rather than an automatic rejection boundary; the reviewer decides whether a deviation is necessary and safe. Scoped drives reject omitted unresolved dependencies instead of silently expanding scope. Review feedback is retained as a bounded, deduplicated finding checklist. Reviewed approvals record an authoritative immutable Git tree plus separate review, integration-commit, and trusted-verification provenance. Bounded diffs are presentation context only; dashboard acceptance records `approvalKind: "manual"` instead.

Trusted verification commands are arbitrary local code and may be defined only in the operator-owned user config (`~/.pi/agent/maestro.json`) with `verificationProfiles` entries shaped as `{ "command": "pnpm test", "timeoutSeconds": 300 }`. Repository `.pi/maestro.json` may select a known user profile with `defaultVerificationProfile`, but repository-defined commands and unknown selections are ignored. Task briefs and model instructions are never executed. Verification runs in a dedicated process group on Unix; timeout or abort sends TERM followed by KILL, bounds captured output, and logs under `.pi/maestro/verification/`. Candidate mutation invalidates review. Failed post-integration verification retains a checkpoint branch as recovery evidence while parking the idle checkout; successful approval removes both checkout and task branch only after provenance is persisted.

The watchdog steers once after `watchdogIdleSeconds` of silence (default 120) or `watchdogWarningTurns` without meaningful progress (default 12), then classifies continued inactivity as `stalled` after `watchdogTerminationTurns` (default 4 additional turns). After steering, the grace applies to both subsequent no-progress turns and prolonged silence, so a silent run cannot hang forever while a run that responds after steering can settle normally. Any tier, including `review`, may override those three fields for its launches; omitted tier values inherit the global thresholds. `handoffContextRatio` controls automatic safe handoff. Model prompts use named, priority-bounded sections: success criteria and open blockers are retained before dependency conclusions, display diffs, and historical detail. Repeated dependency payloads share a fixed budget, and `/maestro costs` reports compact executor-context character/token estimates. Logs use `logEvents` (`compact` by default) and `maxLogBytesPerRun`; zero bytes means unlimited. New defaults cap a task at $5 and a drive at $25 without overriding explicit user configuration. `cleanupCompletedTasks` defaults to `true`: after every board task is approved or cancelled, Maestro archives the final board and clears tasks from the live board. Set it to `false` to retain completed tasks live. `/maestro reconcile` separately reports manual acceptance and missing authoritative-tree, review, integration, verification, or recovery-worktree evidence without rewriting state.

`/maestro doctor` prints a non-secret readiness report: user/project config files and precedence,
effective limits and tier settings, authenticated model and fallback resolution, git readiness, and
managed worktrees classified as active, recoverable, retained after a merge conflict, orphaned, or
stale. It never prints API keys. Missing authentication, unavailable models, invalid JSON, and a
repository without an initial commit include next-step guidance. `/maestro doctor cleanup` offers a
confirmation before removing stale/orphaned entries, then rechecks the board and live runs so active
and recoverable worktrees remain untouched. In non-interactive mode, add `confirm` explicitly.

### Agent sessions

Use `/maestro agents`, the **Browse agent sessions** control-center action, or `ctrl+alt+w` to open a large, session-like viewer for executor and reviewer history. It includes live and completed launches, rich Pi chat/tool rendering, `←/→` session switching, and `j/k` or `PgUp/PgDn` scrolling. Live sessions also offer steer and follow-up. When opened through `/maestro agents` or the control center, completed sessions can be opened in Pi itself with Enter; `/maestro back` then returns to the owner session.

Each raw launch writes its full transcript beneath Pi's normal per-project session directory at `.maestro/<launch>/`. Pi's ordinary `/resume` picker does not recurse into that namespace, but recursive usage tools still include its token and cost records. A child opened in Pi uses its launch directory as the active session directory, so use `/maestro back`—not `/resume`—to return to the owner session. Sessions produced by older Maestro releases remain in their original top-level location until migrated or removed separately.

The compact activity widget remains visible while agents run. Set `livePanes` to `true` only if you also want a passive side pane to open automatically; automatic panes are off by default.

### Commands

```
/maestro start <goal>     plan + delegate a goal with the orchestrator
/maestro handoff          continue run/review in a fresh session (drops planning context)
/maestro drive [taskIds]  autonomously run, review, and retry all or selected tasks
/maestro retry <taskId>   deliberately retry eligible failed/review work with safety checks
/maestro pause            stop the drive after active executors finish; do not abort them
/maestro resume           continue the paused task scope from fresh board state
/maestro abort            abort an active drive/executors, or discard a paused drive
/maestro plan             inspect and approve or reject a plan awaiting approval
/maestro plan export <file>  write a versioned plan-only JSON file; never overwrites
/maestro plan import <file>  validate before replacing; non-empty boards require archive confirmation
/maestro plan diff <file> [taskId]  compare an export with the live board without mutation
/maestro recipe list      list effective user and project recipes
/maestro recipe inspect <name>  show the effective validated recipe
/maestro recipe preview <name> [JSON]  expand and compare without changing board or archives
/maestro recipe save <name> [user|project]  save the current plan (default: user)
/maestro recipe run <name> [JSON]  expand input into a gated plan
/maestro recipe remove <name> [user|project]  remove only after confirmation
/maestro discover <taskId> [append|replace]  preview and approve bounded discovery output
/maestro board            phase-first project dashboard (aliases: dash, dashboard; also ctrl+alt+b)
/maestro agents           browse rich live and completed executor/reviewer sessions
/maestro workflows        browse, inspect, preview, run, save, or remove reusable workflows
ctrl+alt+w                cycle the agent viewer: docked pane → centered → closed
ctrl+alt+j / ctrl+alt+k   move the agent selector under the editor (next/previous)
/maestro open <taskId>    switch into an executor's session
/maestro back             switch back to the previous session (after open/reviewer open)
/maestro config           interactive settings editor (user scope)
/maestro config project   interactive settings editor (repo scope)
/maestro config show      print the resolved defaults + user + project configuration
/maestro costs            attempts, total/average billed cost, models, providers, per-task spend
/maestro insights         compare model/tier approvals, cost, failures, and review rejection
/maestro reconcile        report board/artifact provenance inconsistencies
/maestro timeline [id]    show bounded chronological evidence without waking a model
/maestro timeline archive <file> [id]  inspect an archived board without restoring it
/maestro doctor           diagnose config, models, authentication, git, and worktrees
/maestro doctor cleanup   confirm removal of rechecked stale/orphaned worktrees
/maestro history [n]      show the last n audited status changes (default 20)
/maestro replay [file]    restore an archived board (newest-first picker when omitted)
/maestro reset [confirm]  archive then clear; prompts in TUI, requires confirm non-interactively
```

In non-interactive use, invoke `/maestro reset confirm`; plain `/maestro reset` refuses without
creating an archive or changing board state.

Approved and cancelled tasks are settled: all-cancelled and mixed approved/cancelled scopes
complete normally and are eligible for completed-board archival and cleanup. Cancellation never
counts as an approval or creates review evidence.

Completed drives print a compact outcome summary with approved, failed, cancelled, and blocked
counts, rounds and attempts, total cost, average cost across billed attempts, and the non-secret
model/provider identifiers recorded by executors and reviewers. `/maestro costs` prints it directly
without task details, including executor/reviewer context sizes, omission counts, and a reconciled
cost breakdown. Once more than one task has recorded spend it also ranks tasks most-expensive-first,
splitting executor from reviewer cost with launch counts, so a board that looks cheap per attempt
still shows which few tasks consumed the run. Zero-cost startup/provider
failures count as attempts but are excluded from the meaningful average. `/maestro insights` is a
bounded, model-free read over the current and archived boards, grouped by executor model and task
tier; it reports attempts, first-review approval rate, average end-to-end cost per approved task,
failure kinds, and reviewer rejection rate.

## Guides

- [Configuration reference](docs/configuration.md)
- [Operations and recovery](docs/operations.md)
- [Architecture and ownership](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)

## Limitations and trust boundaries

Ship-ready examples live in `examples/recipes/` — copy one into `.pi/maestro-recipes/` and run
`/maestro recipe run <name>`.

Recipes are versioned JSON stored in `~/.pi/agent/maestro-recipes/` (user scope) or
`.pi/maestro-recipes/` (project scope). A project file overrides a same-name user file before
parsing. Recipes contain only declarative task and input fields; scripts, hooks, commands, and
unknown fields are rejected. Saving validates the current plan against effective tiers and trusted
user verification profiles before creating a file. Expansion completes before the board changes,
and every expanded recipe enters the normal plan approval gate.

Discovery tasks are explicit no-file tasks with a declared scope for proposed work. Their executor
is restricted to `read,grep,find,ls`. Maestro parses only the latest completed final report as
bounded declarative JSON; it rejects commands and unsafe paths, shows a deterministic preview, and
adds or replaces ordinary tasks only after explicit UI confirmation. Approved generated tasks
always return to the normal plan gate. Discovery never starts generated work directly.

Approved completions carry a versioned canonical fingerprint of the effective task contract,
configured execution/review settings, trusted verification profile, write scope, review policy,
and dependency artifact identities. Scheduler cache reuse requires an exact fresh proof. Legacy
approvals remain visible but are never silently reused; changed inputs show a component-specific
stale reason and require retry, manual migration acceptance, or a successor. Plan edits, recipes,
discovery output, retry, status, and dashboard projections all use this same freshness policy.

`/maestro plan diff` validates a versioned export before comparing it with the current board.
`/maestro recipe preview` uses the exact recipe resolver and expansion path. Both report added,
removed, and changed task contracts plus fingerprint, dependency-wave, concurrency, launch-bound,
and verification-profile effects. They never write the board or archive; bounded reports include a
deterministic reference and task-specific follow-up command when detail is omitted.

Maestro is not a sandbox, CI service, analytics database, or generic plugin system. Executors can edit files within the permissions of the local account. Verification profiles execute arbitrary operator-selected local commands; repository config cannot define those commands, and untrusted projects cannot contribute any configuration at all (budgets, attempt caps, tier models, and tool lists stay at trusted values). Git worktrees and immutable objects provide attribution and recovery, not protection from malicious local code.

## How it stays deterministic

- The board (`.pi/maestro/board.json`) is the single source of truth, written atomically.
  Restarting pi loses nothing; the status bar and board rebuild from disk. Invalid board JSON is
  preserved as `board.json.corrupt-<timestamp>` before maestro recovers with an empty board;
  invalid user or project config is preserved beside it as `maestro.json.corrupt-<timestamp>` and
  that scope falls back to lower-precedence configuration.
- Executors are `pi --mode rpc` child processes. Each raw launch receives a unique
  `--session-dir` under Pi's default per-project session directory at `.maestro/<launch>/`.
  The nested transcript stays available through `/maestro agents` and exact board references;
  recursive usage reports include it without adding it to Pi's ordinary `/resume` list. Attempts
  retain descriptive, numbered names and their exact session path, with raw event logs under
  `.pi/maestro/logs/`. The
  `.pi/maestro/` state dir gitignores itself — runtime state never floods your git status.
  RPC mode is what makes mid-run steering and clean aborts possible. With `detachedExecutors` enabled on Unix, persisted JSONL transport files replace the otherwise non-reattachable stdio pipes so executor work can survive Pi exit and be reattached safely by PID plus process-start identity. Executor-side extension dialogs (e.g. permission gates) are auto-cancelled so headless runs can never hang.
- Dependencies gate execution: a task only runs when everything it `dependsOn` is `approved`.
  Its fresh prompt includes each approved dependency's report and, when available, a reference to
  that dependency's persisted pi session transcript. Injected dependency reports and retry review
  notes are bounded to 10,000 characters each, with explicit truncation markers.
- Boards are scoped to their owning sessions: the status bar and widget only render in
  sessions that started or drove the run (plan/run/start/handoff), so an unrelated pi chat in
  the same repo stays clean. The board file itself remains shared, hand-editable state.
- Successful executor attempts also capture a best-effort, bounded diff for the reviewer. In the
  main checkout it is limited to files reported as touched and includes staged and unstaged edits;
  in an isolated worktree it is the worktree diff from `HEAD`. The diff is truncated to the same
  10,000-character injected-context limit, omitted when empty, persisted on the attempt, and never
  changes the executor outcome if capture fails.
- Review verdicts persist on the reviewed attempt (`reviewReport`, `reviewSessionFile`): from the
  task picker you can view the retained verdict text or switch into the reviewer's session. Ordinary
  report previews are bounded, discovery JSON retains its larger validation limit, and an approved
  report artifact is never rewritten because its digest is dependency evidence. Reviewer usage is
  added to that task's totals.
- Reviewers must end with `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`; anything else leaves
  the task in `ready_for_review` for you or the orchestrator to re-review.
- Every task status change is appended to `.pi/maestro/history.jsonl`; `/maestro history [n]`
  reads this audit trail. Board writes are per-task against fresh state, so parallel executors
  finishing in any order cannot clobber each other's status updates.
- On pi exit, live executors are aborted (no orphan processes). On startup, tasks stuck in
  `running` from a crash are marked `failed` with a notice; retry them with
  `maestro_drive({ action: "start", taskIds: ["T3"] })` — explicitly scoped failed/cancelled tasks are runnable again.
- `/maestro replay [file]` refuses while executors are live and rechecks after the archive picker
  closes. With no file it lists valid archives newest first; `file` may be an archive filename or a
  path, but must resolve inside `.pi/maestro/archive/`. Maestro fully validates the archived board
  before changing state, archives the current board first, then restores the selected board. Invalid
  or out-of-directory files leave the current board untouched.
- `/maestro reset` refuses while executors are live, copies the current board to
  `.pi/maestro/archive/<timestamp>-board.json`, then (after TUI confirmation) clears tasks and the
  goal. Audit history and run logs remain. Maestro creates `.pi/maestro/.gitignore` containing `*`
  when it first saves state, so board, logs, history, archives, and worktrees ignore themselves.

## Development

```bash
pnpm install
pnpm run check    # typecheck + source/packed smoke tests + tests + lint + format
```

Quick manual test:

```bash
pi -e ./src/index.ts
```

## License

Pi Maestro is free and open-source software released under the [MIT License](LICENSE). Use it,
modify it, share it, and build something excellent.
