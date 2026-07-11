# pi-maestro

Orchestrator/executor workflows for [pi](https://github.com/badlogic/pi-mono).

The model in your interactive session becomes the **orchestrator**: it plans a goal into small
tasks, delegates each task to a cheap **fresh-context executor** (a separate `pi` process), and an
**adversarial reviewer** independently verifies each result before it is approved. The orchestrator
never reads raw executor output — it works off short reports and status pulses, so its context
stays clean and your expensive model spends tokens on judgment, not typing.

```
you ──▶ orchestrator (SOTA model, your session)
              │ maestro_plan          ┌────────────────────────────┐
              ▼                         │ .pi/maestro/board.json   │
        task board  ◀──────────────────▶│ sessions/  logs/           │
              │ maestro_run           └────────────────────────────┘
              ▼
   executors in parallel (cheap models, fresh context each)
              │ maestro_review
              ▼
   adversarial reviewers (read-only tools, fresh context)
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
- **Same quality.** Every task passes an adversarial review with read-only tools before it is
  approved. Rejected work is retried with the reviewer's notes injected into the next attempt.
- **Deterministic and observable.** All state lives in `.pi/maestro/board.json`. Every executor
  session and raw JSON event log is persisted, and you can switch your TUI into any executor
  session.

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
with four tools:

| Tool | What it does |
|------|--------------|
| `maestro_plan` | Creates tasks with self-contained briefs, a complexity tier, and optional dependencies |
| `maestro_run` | Runs all runnable tasks in parallel fresh-context executors (respects `maxParallel` and dependencies) |
| `maestro_review` | Spawns adversarial fresh-context reviewers (read-only tools) that approve or request changes |
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
/maestro handoff               # fresh supervisor executes with a clean context
```

For small goals, skip the handoff — one session is fine.

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
  - `s` **steer a running executor** — type a correction and it is queued into that executor's
    next LLM call (executors run in RPC mode, so mid-run steering works like it does in pi itself)
  - `x` abort a running executor (task becomes `cancelled`)
  - `a` approve / `r` reopen a finished task without spawning a reviewer
  - `enter` open the executor's full session in your TUI
- **`/maestro list`**: compact task picker (report view, status overrides, open session).
- **`/maestro open T3`**: switches your TUI into that executor's persisted session so you can
  inspect exactly what it did — or continue working in it by hand. Use `/resume` to return.

### Configuration

`/maestro config` opens an interactive settings editor (user scope by default,
`/maestro config project` for repo scope, `/maestro config show` to print the resolved
config). Every row has a description; changing any value switches the preset to `custom`.

**Presets** ship with defaults derived from the Artificial Analysis Coding Agent Index v1.1
and deep SWE leaderboard (pass@1 / avg cost per run):

| Preset | trivial | standard | complex | review | Rationale |
|--------|---------|----------|---------|--------|-----------|
| `inherit` (default) | pi default · low | pi default · medium | pi default · high | pi default · high | Works with any provider, zero setup |
| `balanced` | terra · high | sol · medium | sol · high | sol · medium | Best cost/quality knee per tier (sol-high: 69% @ $3.47) |
| `budget` | luna · high | terra · high | terra · xhigh | terra · xhigh | Cheapest sensible run (terra-xhigh: 60% @ $2.13) |
| `quality` | sol · medium | sol · high | sol · xhigh | sol · high | Frontier on every tier (sol-xhigh: 71% @ $4.70) |

Config files are plain JSON if you prefer editing by hand — user scope
`~/.pi/agent/maestro.json`, project scope `.pi/maestro.json` (project wins per key):

```json
{
  "maxParallel": 4,
  "maxAttempts": 3,
  "maxCostPerTask": 2,
  "tiers": {
    "trivial":  { "model": "gpt-5.6-terra", "thinking": "high" },
    "standard": { "model": "gpt-5.6-sol", "thinking": "medium" },
    "complex":  { "model": "gpt-5.6-sol", "thinking": "high" },
    "review":   { "model": "gpt-5.6-sol", "thinking": "medium", "tools": "read,bash,grep,find,ls" }
  }
}
```

- `maxAttempts` — hard cap on execute attempts per task (default 3). Stops orchestrator retry
  loops; a capped task fails with a hint to rewrite its brief via `maestro_update`.
- `maxCostPerTask` — abort an executor when a single attempt exceeds this USD cost (default 0 =
  off). Safety net against a stuck executor burning tokens unattended.
- `model` — a pi model pattern. Bare names like `gpt-5.6-terra` are resolved against providers
  you actually have auth for (preferring the orchestrator's provider); `provider/id` pins one
  provider. Omit to inherit pi's default model.
- `thinking` — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Per GPT-5.6 guidance: start
  medium, test one level lower, raise only when results show a gain.
- `tools` — comma-separated allowlist passed to the executor. The `review` tier defaults to
  read-only tools so reviewers cannot modify files.
- You can add your own tier names; the orchestrator's planning guidance lists them.

Before any run, maestro preflights every tier's model against your configured providers and
fails with an actionable message (which tier, which model, how to fix) instead of spawning
dead executors.

### Commands

```
/maestro start <goal>     plan + delegate a goal with the orchestrator
/maestro handoff          continue run/review in a fresh session (drops planning context)
/maestro board            full-screen live dashboard (also ctrl+alt+b)
/maestro list             compact task picker
/maestro open <taskId>    switch into an executor's session
/maestro config           interactive settings editor (user scope)
/maestro config project   interactive settings editor (repo scope)
/maestro config show      print the resolved configuration
/maestro reset            clear the board
```

## How it stays deterministic

- The board (`.pi/maestro/board.json`) is the single source of truth, written atomically.
  Restarting pi loses nothing; the status bar and board rebuild from disk.
- Executors are `pi --mode rpc` child processes with persisted sessions under
  `.pi/maestro/sessions/<task>-attempt-<n>/` and raw event logs under `.pi/maestro/logs/`.
  RPC mode is what makes mid-run steering and clean aborts possible. Executor-side extension
  dialogs (e.g. permission gates) are auto-cancelled so headless runs can never hang.
- Dependencies gate execution: a task only runs when everything it `dependsOn` is `approved`.
- Reviewers must end with `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`; anything else leaves
  the task in `ready_for_review` for you or the orchestrator to re-review.
- Board writes are per-task against fresh state, so parallel executors finishing in any order
  cannot clobber each other's status updates.
- On pi exit, live executors are aborted (no orphan processes). On startup, tasks stuck in
  `running` from a crash are marked `failed` with a notice; retry them with
  `maestro_run ["T3"]` — explicitly named failed/cancelled tasks are runnable again.

Add `.pi/maestro/` to your project's `.gitignore` unless you want to commit run history.

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
