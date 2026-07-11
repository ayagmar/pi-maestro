# pi-maestro

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
              │ maestro_run or maestro_drive
              ▼
   executors in parallel (cheap models, fresh context each)
              │ maestro_review (or drive continues automatically)
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
  self-contained brief (plus approved dependency reports). The orchestrator pulses
  `maestro_status` instead of ingesting transcripts.
- **Independent review by default.** The automated path sends every task through an adversarial
  review with read-only tools before approval. Rejected work is retried with the reviewer's notes
  injected into the next attempt. Manual approval skips that review, and configuring writable
  reviewer tools removes the read-only guarantee.
- **Deterministic and observable.** Task state lives in `.pi/maestro/board.json`; audit history
  and raw event logs live beside it. Executor sessions use pi's normal session storage, and you
  can switch your TUI into any completed executor session.

## Install

```bash
pi install git:github.com/<you>/pi-maestro
# or from a local checkout
pi install /path/to/pi-maestro
```

## Usage

### Start an orchestrated run

```
/maestro start migrate the auth module to the new session API and add tests
```

This injects an orchestrator briefing into your current session. The model then drives the loop
with these tools:

| Tool | What it does |
|------|--------------|
| `maestro_plan` | Creates tasks with self-contained briefs, a complexity tier, and optional dependencies |
| `maestro_run` | Runs one batch of runnable tasks in parallel fresh-context executors (respects dependencies, `maxParallel`, plan approval, and run budget) |
| `maestro_review` | Spawns adversarial fresh-context reviewers that approve or request changes (reviewer tools are read-only by default) |
| `maestro_drive` | Repeats run/review/retry rounds until the selected tasks finish or need intervention |
| `maestro_update` | Refines a task's title, brief, or tier, or cancels it |
| `maestro_status` | Cheap status pulse: statuses, tiers, attempts, cost per task |

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
session stays on disk (`/resume` to revisit). The orchestrator briefing suggests the handoff
itself when planning required heavy investigation.

Recommended flow for large goals:

```
/maestro start <goal>          # expensive model investigates + plans
  …review the board, adjust…     # /maestro board, tweak briefs/statuses
/maestro handoff               # fresh supervisor drives execution with a clean context
```

For small goals, skip the handoff — one session is fine. You can also start the autonomous loop
from the current session with `/maestro drive` (or let the model call `maestro_drive`). It runs
independent work in parallel, reviews completed attempts, carries review feedback into retries,
and waits for approved dependencies before advancing them. The loop stops when work is complete
or when a plan gate, run budget, attempt cap, abort, blocked state, error, or its 20-round safety
limit requires intervention. An optional task-id list limits the drive to those tasks.

With `planGate` enabled, use an explicit plan-approve-drive flow:

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
- **`/maestro board`** (or `ctrl+alt+b`): full-screen live dashboard — task list on the left,
  live transcript of the selected task on the right (tailed from the executor's event log,
  auto-refreshing twice a second). From the dashboard you can:
  - `↑↓` switch between executors, `PgUp/PgDn` scroll the transcript
  - `s` **steer a running executor** — choose **Stop - wrong approach, report current state**,
    **Run the project checks before finishing**, **Stay strictly within the task brief scope**, or
    **Custom message...** (which opens a text input). The message is queued into that executor's
    next LLM call (executors run in RPC mode, so mid-run steering works like it does in pi itself).
    The chooser scrolls to keep the selected template visible in short terminals.
  - `x` abort a running executor (task becomes `cancelled`)
  - `a` approve / `r` reopen a finished task without spawning a reviewer (a manual lifecycle
    override that bypasses adversarial review)
  - `f` hide/show settled tasks (approved and cancelled) to focus on remaining work
  - `enter` open the executor's full session in your TUI
- **`/maestro list`**: compact task picker (report view, status overrides, open session).
- **`/maestro open T3`**: switches your TUI into that executor's persisted session so you can
  inspect exactly what it did — or continue working in it by hand. `/maestro back` returns.
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
| `inherit` (default) | pi default · low | pi default · medium | pi default · high | pi default · high | 3 / 3 / off / off | Works with any provider, zero setup |
| `balanced` | terra · high | sol · medium | sol · high | sol · medium | 3 / 3 / off / off | Best cost/quality knee per tier (sol-high: 69% @ $3.47) |
| `budget` | luna · high | terra · high | terra · xhigh | terra · xhigh | 4 / 3 / $2 / off | Cheapest sensible run (terra-xhigh: 60% @ $2.13) |
| `quality` | sol · medium | sol · high | sol · xhigh | sol · high | 3 / 4 / off / off | Frontier on every tier (sol-xhigh: 71% @ $4.70) |

All presets set `planGate` and `useWorktrees` to `false`; all leave `maxRunCost` off.

Config files are plain JSON if you prefer editing by hand — user scope
`~/.pi/agent/maestro.json`, project scope `.pi/maestro.json`. Resolution is defaults, then user,
then project. Top-level fields merge by key; `tiers` merge by tier name, with the later scope's
whole tier object replacing the earlier object of the same name:

```json
{
  "maxParallel": 4,
  "planGate": true,
  "useWorktrees": false,
  "maxAttempts": 3,
  "maxCostPerTask": 2,
  "maxRunCost": 25,
  "tiers": {
    "trivial":  { "model": "gpt-5.6-terra", "thinking": "high" },
    "standard": {
      "model": "gpt-5.6-sol",
      "fallbacks": ["gpt-5.6-terra", "openai/gpt-5-mini"],
      "thinking": "medium"
    },
    "complex":  { "model": "gpt-5.6-sol", "thinking": "high" },
    "review":   { "model": "gpt-5.6-sol", "thinking": "medium", "tools": "read,bash,grep,find,ls" }
  }
}
```

- `maxParallel` — maximum executor or reviewer processes run concurrently (default 3).
  Dependencies can reduce the number that are runnable at once.
- `planGate` — when enabled, every non-empty `maestro_plan` marks the board pending and both
  `maestro_run` and `maestro_drive` refuse to start executors. `/maestro plan` lists task metadata,
  can display a full brief, and offers **Approve plan** or **Reject plan**. Approval opens the gate;
  rejection archives the board and, after confirmation, clears it (default false).
- `useWorktrees` — when enabled, a single `maestro_run` dispatch with more than one runnable task
  gives every task in that batch an isolated git worktree and branch. A one-task dispatch stays in
  the current checkout. Reviewers use the executor's worktree. Approval commits its changes,
  serializes merges into the original tree, then deletes the worktree and branch. A merge conflict
  is aborted, changes the task to `changes_requested`, and retains the checkout, branch, and
  recovery notes; the next retry reuses that worktree (default false).
- `autoCommit` — commit each task's approved work as one conventional commit (default on).
  The commit message comes from the task's `commitMessage` (the orchestrator plans one per
  task, e.g. `fix: handle empty board`) or falls back to `feat: <title>`. Main-tree runs
  commit only the files the executor touched; worktree runs use the message for the merge
  commit. A failed commit (no repo, hooks) never blocks the approval.
- `maxAttempts` — hard cap on execute attempts per task (default 3). Stops orchestrator retry
  loops; a capped task fails with a hint to rewrite its brief via `maestro_update`.
- `maxCostPerTask` — abort an executor when a single attempt exceeds this USD cost (default 0 =
  off). Safety net against a stuck executor burning tokens unattended.
- `maxRunCost` — gate new executor batches once total cost recorded across the board exceeds this
  USD amount (default 0 = off). The settings editor offers off, $5, $10, $25, and $50. A blocked
  `maestro_run` returns the budget warning on each otherwise-runnable task; `maestro_drive` stops
  with the same warning. Already-running executors are not aborted, reviews can still run, and
  `maxCostPerTask` continues to enforce its separate per-attempt cap. Because gating happens before
  a batch, its concurrent executors can take the recorded total beyond the cap before the next gate.
- `model` — a pi model pattern. Bare names like `gpt-5.6-terra` are resolved against providers
  you actually have auth for (preferring the orchestrator's provider); `provider/id` pins one
  provider. Omit to inherit pi's default model.
- `fallbacks` — ordered model patterns for an executor tier. Unavailable patterns are skipped at
  preflight. At runtime maestro advances only when the current provider/model fails before any
  model turn; that provider failure is recorded but does not consume `maxAttempts`. Failures after
  a turn do not fall back. The interactive editor shows the primary model; edit JSON to set this
  array. Review configuration accepts the same tier shape, but review runs currently use its
  primary `model` only.
- `thinking` — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Per GPT-5.6 guidance: start
  medium, test one level lower, raise only when results show a gain.
- `tools` — comma-separated allowlist passed to the executor. Every preset's `review` tier defaults
  to `read,bash,grep,find,ls`, so automated reviewers are read-only by default. This field is
  configurable: adding write-capable tools removes that guarantee. Manual approval from the board
  or task picker bypasses the reviewer entirely.
- You can add your own tier names; the orchestrator's planning guidance lists them.

Before an execution dispatch, maestro resolves the primary and fallbacks for every tier used by
that batch and fails with an actionable message if none are available. Before review, it similarly
checks the review tier's primary model. This happens before spawning executors.

### Commands

```
/maestro start <goal>     plan + delegate a goal with the orchestrator
/maestro handoff          continue run/review in a fresh session (drops planning context)
/maestro drive [taskIds]  autonomously run, review, and retry all or selected tasks
/maestro plan             inspect and approve or reject a plan awaiting approval
/maestro board            full-screen live dashboard (aliases: dash, dashboard; also ctrl+alt+b)
/maestro list             compact task picker
/maestro open <taskId>    switch into an executor's session
/maestro back             switch back to the previous session (after open/reviewer open)
/maestro config           interactive settings editor (user scope)
/maestro config project   interactive settings editor (repo scope)
/maestro config show      print the resolved defaults + user + project configuration
/maestro history [n]      show the last n audited status changes (default 20)
/maestro replay [file]    restore an archived board (newest-first picker when omitted)
/maestro reset            archive the current board, then clear tasks and goal
```

## How it stays deterministic

- The board (`.pi/maestro/board.json`) is the single source of truth, written atomically.
  Restarting pi loses nothing; the status bar and board rebuild from disk. Invalid board JSON is
  preserved as `board.json.corrupt-<timestamp>` before maestro recovers with an empty board;
  invalid user or project config is preserved beside it as `maestro.json.corrupt-<timestamp>` and
  that scope falls back to lower-precedence configuration.
- Executors are `pi --mode rpc` child processes. Their sessions persist in pi's default
  session storage (so `/resume` and usage reports include them; each attempt records its
  session file on the board), with raw event logs under `.pi/maestro/logs/`. The
  `.pi/maestro/` state dir gitignores itself — runtime state never floods your git status.
  RPC mode is what makes mid-run steering and clean aborts possible. Executor-side extension
  dialogs (e.g. permission gates) are auto-cancelled so headless runs can never hang.
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
  task picker you can view the full verdict text or switch into the reviewer's session. Reviewer
  usage is added to that task's totals.
- Reviewers must end with `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`; anything else leaves
  the task in `ready_for_review` for you or the orchestrator to re-review.
- Every task status change is appended to `.pi/maestro/history.jsonl`; `/maestro history [n]`
  reads this audit trail. Board writes are per-task against fresh state, so parallel executors
  finishing in any order cannot clobber each other's status updates.
- On pi exit, live executors are aborted (no orphan processes). On startup, tasks stuck in
  `running` from a crash are marked `failed` with a notice; retry them with
  `maestro_run ["T3"]` — explicitly named failed/cancelled tasks are runnable again.
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
pnpm run check    # typecheck + smoke test + tests + lint + format
```

Quick manual test:

```bash
pi -e ./src/index.ts
```

## License

MIT
