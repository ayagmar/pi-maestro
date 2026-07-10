# pi-conductor

Orchestrator/executor workflows for [pi](https://github.com/badlogic/pi-mono).

The model in your interactive session becomes the **orchestrator**: it plans a goal into small
tasks, delegates each task to a cheap **fresh-context executor** (a separate `pi` process), and an
**adversarial reviewer** independently verifies each result before it is approved. The orchestrator
never reads raw executor output — it works off short reports and status pulses, so its context
stays clean and your expensive model spends tokens on judgment, not typing.

```
you ──▶ orchestrator (SOTA model, your session)
              │ conductor_plan          ┌────────────────────────────┐
              ▼                         │ .pi/conductor/board.json   │
        task board  ◀──────────────────▶│ sessions/  logs/           │
              │ conductor_run           └────────────────────────────┘
              ▼
   executors in parallel (cheap models, fresh context each)
              │ conductor_review
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
  `conductor_status` instead of ingesting transcripts.
- **Same quality.** Every task passes an adversarial review with read-only tools before it is
  approved. Rejected work is retried with the reviewer's notes injected into the next attempt.
- **Deterministic and observable.** All state lives in `.pi/conductor/board.json`. Every executor
  session and raw JSON event log is persisted, and you can switch your TUI into any executor
  session.

## Install

```bash
pi install git:github.com/<you>/pi-conductor
# or from a local checkout
pi install /path/to/pi-conductor
```

## Usage

### Start an orchestrated run

```
/conductor start migrate the auth module to the new session API and add tests
```

This injects an orchestrator briefing into your current session. The model then drives the loop
with four tools:

| Tool | What it does |
|------|--------------|
| `conductor_plan` | Creates tasks with self-contained briefs, a complexity tier, and optional dependencies |
| `conductor_run` | Runs all runnable tasks in parallel fresh-context executors (respects `maxParallel` and dependencies) |
| `conductor_review` | Spawns adversarial fresh-context reviewers (read-only tools) that approve or request changes |
| `conductor_status` | Cheap status pulse: statuses, tiers, attempts, cost per task |

You can also call these tools yourself in plain prompts ("plan these three tasks…"), or manage the
board manually — the workflow is just tools plus a JSON file.

### Task lifecycle

```
todo ──run──▶ running ──▶ ready_for_review ──review──▶ approved
                 │                              │
                 ▼                              ▼
               failed                  changes_requested ──run──▶ running (retry with notes)
```

### Watch and intervene

- **Footer status**: `⚡ conductor 2/5 · 2 running · $0.1234` — live while executors run.
- **Live widget** above the editor shows each running executor: task, turns, cost, current tool.
- **`/conductor board`** (or `ctrl+alt+b`): full-screen live dashboard — task list on the left,
  live transcript of the selected task on the right (tailed from the executor's event log,
  auto-refreshing twice a second). From the dashboard you can:
  - `↑↓` switch between executors, `PgUp/PgDn` scroll the transcript
  - `s` **steer a running executor** — type a correction and it is queued into that executor's
    next LLM call (executors run in RPC mode, so mid-run steering works like it does in pi itself)
  - `x` abort a running executor (task becomes `cancelled`)
  - `a` approve / `r` reopen a finished task without spawning a reviewer
  - `enter` open the executor's full session in your TUI
- **`/conductor list`**: compact task picker (report view, status overrides, open session).
- **`/conductor open T3`**: switches your TUI into that executor's persisted session so you can
  inspect exactly what it did — or continue working in it by hand. Use `/resume` to return.

### Configuration

Defaults work out of the box (executors inherit your default pi model). Override per user in
`~/.pi/agent/conductor.json` or per project in `.pi/conductor.json` (project wins per key):

```json
{
  "maxParallel": 4,
  "tiers": {
    "trivial":  { "model": "openai/gpt-5-mini", "thinking": "low" },
    "standard": { "model": "anthropic/claude-sonnet-4-5", "thinking": "medium" },
    "complex":  { "model": "anthropic/claude-opus-4-5", "thinking": "high" },
    "review":   { "model": "anthropic/claude-sonnet-4-5", "thinking": "high", "tools": "read,bash,grep,find,ls" }
  }
}
```

- `model` — any pi model pattern (`provider/id`). Omit to inherit pi's default model.
- `thinking` — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `tools` — comma-separated allowlist passed to the executor. The `review` tier defaults to
  read-only tools so reviewers cannot modify files.
- You can add your own tier names; the orchestrator is told which tiers exist when it plans.

Check the resolved config with `/conductor config`.

### Commands

```
/conductor start <goal>   plan + delegate a goal with the orchestrator
/conductor board          full-screen live dashboard (also ctrl+alt+b)
/conductor list           compact task picker
/conductor open <taskId>  switch into an executor's session
/conductor config         show resolved tier configuration
/conductor reset          clear the board
```

## How it stays deterministic

- The board (`.pi/conductor/board.json`) is the single source of truth, written atomically.
  Restarting pi loses nothing; the status bar and board rebuild from disk.
- Executors are `pi --mode rpc` child processes with persisted sessions under
  `.pi/conductor/sessions/<task>-attempt-<n>/` and raw event logs under `.pi/conductor/logs/`.
  RPC mode is what makes mid-run steering and clean aborts possible. Executor-side extension
  dialogs (e.g. permission gates) are auto-cancelled so headless runs can never hang.
- Dependencies gate execution: a task only runs when everything it `dependsOn` is `approved`.
- Reviewers must end with `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`; anything else leaves
  the task in `ready_for_review` for you or the orchestrator to re-review.

Add `.pi/conductor/` to your project's `.gitignore` unless you want to commit run history.

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
