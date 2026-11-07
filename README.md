# pi-maestro

[![MIT licensed](https://img.shields.io/badge/license-MIT-d9a520.svg)](LICENSE)
[![Node.js 22 or 24](https://img.shields.io/badge/node-22%20%7C%2024-2f6f44.svg)](package.json)
[![Pi 1.5+](https://img.shields.io/badge/pi-1.5%2B-243746.svg)](https://github.com/earendil-works/pi-mono)

Orchestrator/executor workflows for [pi](https://github.com/earendil-works/pi-mono).

The model in your pi session becomes the **orchestrator**. It plans a goal into small tasks with explicit success criteria, and each task runs in a **fresh-context executor**, a separate `pi` process on a cheaper model. A **reviewer** with a fresh context and read-only tools checks every result before it is approved. Tasks, attempts, verdicts, and costs live on a board under `.pi/maestro/`, so a run survives restarts and you can inspect all of it.

```text
you ──▶ orchestrator (your session, your model)
              │ maestro_plan               ┌────────────────────────────┐
              ▼                            │ .pi/maestro/board.json     │
        task board  ◀─────────────────────▶│ logs/  history.jsonl       │
              │ plan approval (optional)   └────────────────────────────┘
              │ /maestro drive or maestro_drive
              ▼
   executors in parallel (fresh context each, cheaper models)
              │
              ▼
   reviewers (fresh context, read-only tools by default)
              │ approve / request changes
              ▼
   approved tasks ──▶ one summary back to the orchestrator
```

## Why

- **Lower cost per run.** The expensive model plans, dispatches, and reads short reports. Executors run on cheaper models with a thinking level per tier.
- **No context rot.** Every executor and reviewer starts with a self-contained brief plus the reports of approved dependencies. The orchestrator never reads raw executor output and receives one bounded outcome per drive.
- **Independent review.** Rejected work is retried with the reviewer's findings. Tasks default to one reviewer and can ask for several independent confirmations or a finder and refuter pair. Disagreement and operational failures stop once with a decision for you instead of retrying forever.
- **Visible and recoverable.** `/maestro board` shows tasks, launches, evidence, and cost without calling a model. A drive that stops names the stop and the safe next step.

## Install

```bash
pi install npm:@ayagmar/pi-maestro
# or straight from GitHub
pi install git:github.com/ayagmar/pi-maestro
# or from a local checkout
pi install /path/to/pi-maestro
```

The npm package is scoped because the unscoped `pi-maestro` name on npm belongs to an unrelated project. Try it for one session with `pi -e npm:@ayagmar/pi-maestro`, and update an installed copy with `pi update npm:@ayagmar/pi-maestro`. A project-scoped install (`pi install -l …`) loads only in projects you have trusted in pi.

## Compatibility and support

Pi Maestro requires pi 1.5 or newer (tested against `1.5.x`) and Node.js 22.19 or newer. Earlier pi releases are not supported. Pi supplies its own packages to extensions at runtime, so the peer dependencies accept any version (`*`) as pi's package guidelines require; the tested line is the supported one. Only the latest published release receives fixes.

Report bugs through [GitHub Issues](https://github.com/ayagmar/pi-maestro/issues). Report suspected vulnerabilities privately; [SECURITY.md](SECURITY.md) says how.

## Five-minute start

1. Install the extension.
2. Run `/maestro doctor` (or `/maestro`, then **Check setup and recovery**). It checks config, authenticated models, Git, and worktrees, and never prints keys.
3. Run `/maestro start <goal>`, for example `/maestro start migrate the auth module to the new session API and add tests`.
4. The orchestrator creates tasks. With `planGate` on, read and approve them with `/maestro plan`.
5. Run `/maestro drive` to run, review, and retry until the board settles. The orchestrator can also start the drive itself.
6. Watch with `/maestro board`, and read the model-free history with `/maestro timeline`.

The default `inherit` preset needs no setup: executors use your pi default model and only the thinking level differs by tier. Pick a cheaper executor preset with `/maestro config`.

The model drives the loop with exactly three tools:

| Tool | What it does |
|------|--------------|
| `maestro_plan` | Creates tasks with self-contained briefs, tiers, dependencies, and bounded write scopes |
| `maestro_update` | Refines or cancels planned work. Changing the contract of a running or `ready_for_review` task needs `invalidateInFlight: true`, which discards that paid work and returns its cost as a warning |
| `maestro_drive` | Runs the run, review, and retry loop to settlement, inspects it, or intervenes in live work |

Approval, pause, abort, simulation, and recovery are human commands, so they never widen what the model can do. If you already have a plan (a design doc, an issue list), paste it and ask the model to turn it into `maestro_plan` tasks. `/maestro start` is for goals where the decomposition itself needs the expensive model.

For large goals, `/maestro handoff` starts a fresh session whose supervisor continues from the board alone, without the planning tokens. See [Getting started](docs/getting-started.md).

## Commands at a glance

```text
/maestro start <goal>        plan and delegate a goal
/maestro drive [taskIds]     run, review, and retry until the board settles
/maestro pause | resume | abort
/maestro plan                inspect, edit, approve, or reject a pending plan
/maestro plan diff <file>    compare an exported plan with the board (read-only)
/maestro retry <taskId>      retry eligible failed or rejected work after safety checks
/maestro board               phase-first dashboard (ctrl+alt+b)
/maestro agents              browse live and completed executor and reviewer sessions
/maestro open <taskId>       switch into an executor's session; /maestro back returns
/maestro timeline [id]       bounded history, no model call
/maestro costs               spend by attempt, model, provider, and task
/maestro insights            approval, cost, and failure rates by model and tier
/maestro reconcile           report missing review, integration, or verification proof
/maestro workflows           browse, preview, run, save, or remove reusable workflows
/maestro recipe preview <name> [JSON]   expand a recipe without writing anything
/maestro config              settings editor
/maestro doctor              diagnose config, models, Git, and worktrees
```

The [command reference](docs/commands.md) lists every command, the dashboard keys, and what each cost report shows.

## Watching a run

The footer shows progress, for example `⚡ maestro running · execution · ▰▰▰▱▱▱▱▱▱▱ 5/16 (31%) · 2 running · $84.21`, and a widget above the editor lists each running executor with its task, turns, cost, and current tool. `/maestro board` is the control surface: steer a running executor, abort it, retry a task, or open its session.

Each raw launch writes its transcript under pi's per-project session directory at `.maestro/<launch>/`. Pi's ordinary `/resume` picker does not recurse into that namespace, but recursive usage tools still count its tokens, so usage recurs through nested sessions while the human session list stays short. After opening a child session, return with `/maestro back`, not `/resume`.

A task moves through these states:

```text
todo ──run──▶ running ──▶ ready_for_review ──review──▶ approved
                 │                              │
                 ▼                              ▼
               failed                  changes_requested ──run──▶ running (retry with notes)
```

Approved and cancelled tasks are settled. A board of only cancelled tasks, or a mix of approved and cancelled ones, completes normally, and cancelling never counts as an approval.

## Configuration

`/maestro config` edits user scope, `/maestro config project` edits the repository, and `/maestro config show` prints the resolved values. Files are plain JSON at `~/.pi/agent/maestro.json` and `.pi/maestro.json`; project config is read only for projects you have trusted in pi. Models are set per tier (`trivial`, `standard`, `complex`, and the read-only `review` tier), each with optional `fallbacks` and a `thinking` level. Review tiers take the same shape, and review launches use the same provider-failure fallback rules as executors.

Defaults cap an attempt at $5 and a drive at $25 (`maxCostPerTask`, `maxRunCost`), run three processes at once, and allow three attempts per task. Seven presets set tier models. See the [configuration reference](docs/configuration.md) for every key, default, and range.

## Guides

The same guides are published at <https://ayagmar.github.io/pi-maestro/>.

- [Getting started](docs/getting-started.md): install, first goal, plan approval, and handoff
- [How it works](docs/how-it-works.md): roles, lifecycle, review, failures, and isolation
- [Command reference](docs/commands.md): every command and dashboard key
- [Configuration reference](docs/configuration.md): presets, tiers, budgets, and verification
- [Operations and recovery](docs/operations.md): what each stop means and the safe next step
- [Architecture and ownership](docs/architecture.md): module boundaries and invariants
- [Changelog](CHANGELOG.md) and [Contributing](CONTRIBUTING.md)
- Recipes: copy an example from `examples/recipes/` into `.pi/maestro-recipes/` and run `/maestro recipe run <name>`

## Limitations and trust boundaries

Maestro is not a sandbox, CI service, analytics database, or generic plugin system. Executors can edit files with the permissions of your local account. Git worktrees and immutable objects give attribution and recovery, not protection from malicious local code.

- Reviewers get `read,grep,find,ls` by default. A custom `review.tools` list that adds `bash` or another writing tool removes that guarantee, and manual approval from the board skips the reviewer entirely. Both are recorded.
- Verification profiles run arbitrary local commands. Only your user config can define them. A repository can select a profile you defined and cannot add commands.
- An untrusted project contributes no configuration at all: budgets, attempt caps, tier models, and tool lists keep your values.
- Write paths are scheduling guidance, not an enforced boundary. They keep independent plans from overlapping and make unexpected changes visible to the reviewer, who decides whether a deviation is safe.
- Isolated task checkouts are built from committed content, so a file a brief points at must be committed. A drive that isolates tasks warns about uncommitted paths the executors cannot see.
- In non-interactive use, `/maestro reset` refuses unless you run `/maestro reset confirm`; the plain form archives and changes nothing.
- Windows uses the attached executor transport and best-effort descendant cleanup. Detached executors are Unix-only.

## Development

```bash
pnpm install
pnpm run check    # typecheck, lint, format, unit and integration tests, pi CLI smoke test
pi -e ./src/index.ts   # quick manual test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repository layout, test layers, and how releases are cut.

## License

Pi Maestro is released under the [MIT License](LICENSE).
