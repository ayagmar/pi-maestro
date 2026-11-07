# Command reference

Everything operational is a human command under `/maestro`, so the model's tool surface stays at three tools. Run `/maestro` with no arguments to open the project control center, or type a subcommand; the menu offers one entry per action and completes nested leaves such as `plan export` after the parent word.

## Plan and drive

| Command | What it does |
|---|---|
| `/maestro start <goal>` | Brief the orchestrator to plan and delegate a goal. On a non-empty board it archives the previous run first, so each goal gets a fresh board |
| `/maestro handoff` | Continue run and review in a fresh session that gets the board and none of the planning context |
| `/maestro plan` | Inspect, edit, and approve or reject a plan that awaits approval |
| `/maestro plan export <file>` | Write a versioned plan-only JSON file; never overwrites |
| `/maestro plan import <file>` | Validate, then replace the board. A non-empty board needs archive confirmation |
| `/maestro plan diff <file> [taskId]` | Compare an export with the live board without changing anything |
| `/maestro drive [taskIds]` | Run, review, and retry all tasks or the listed ones |
| `/maestro retry <taskId>` | Retry eligible failed or review-rejected work after safety checks |
| `/maestro pause` | Stop after active executors finish, without aborting them |
| `/maestro resume` | Continue the paused scope from fresh board state |
| `/maestro abort` | Abort active executors, or discard a paused drive |
| `/maestro simulate [taskIds]` | Preview dependency waves, concurrency, caps, and blockers. It assumes every run and review succeeds and spawns nothing |
| `/maestro discover <taskId> [append\|replace]` | Preview bounded discovery output, then add it as ordinary tasks after you confirm |

`retry` uses the same eligibility rules as the task picker and the dashboard. It refuses running and attempt-capped tasks (capped work needs a successor), asks for confirmation before retrying accepted or integrated work, preserves earlier attempts and recovery references, and runs in an isolated checkout even when worktrees are off. Review notes carry into the same retained recovery attempt where that is safe.

A scoped `drive` rejects a task list that omits an unresolved dependency instead of widening the scope.

## Watch and inspect

| Command | What it does |
|---|---|
| `/maestro board` | The phase-first dashboard (`dash` and `dashboard` also work; shortcut `ctrl+alt+b`) |
| `/maestro agents` | Browse live and completed executor and reviewer sessions (`ctrl+alt+w`) |
| `/maestro open <taskId>` | Switch your TUI into that executor's persisted session |
| `/maestro back` | Return to the session you left |
| `/maestro timeline [id]` | Bounded chronological evidence, no model call |
| `/maestro timeline archive <file> [id]` | Read an archived board without restoring it |
| `/maestro history [n]` | The last n audited status changes (default 20) |
| `/maestro costs` | Spend by attempt, model, provider, and task |
| `/maestro insights` | Approval, cost, failure, and rejection rates by executor model and tier |
| `/maestro reconcile` | Report missing review, artifact, integration, verification, or recovery proof without rewriting state |

During a run the footer shows progress, for example `⚡ maestro running · execution · ▰▰▰▱▱▱▱▱▱▱ 5/16 (31%) · 2 running · $84.21`. A live widget above the editor lists each running executor with its task, turns, cost, and current tool. A drive that is sleeping for provider quota says so there, with the time it resumes. Toasts report each task as it settles.

`ctrl+alt+j` and `ctrl+alt+k` move the agent selector under the editor, and `ctrl+alt+w` cycles the agent viewer between a docked pane, a centered viewer, and closed.

### The dashboard

`/maestro board` opens on the current workflow phase. `→` drills into the phase's tasks and then into executor and reviewer launches, `←` goes back, and `?` prints the full key list. The eight phases are discovery, plan approval, execution, review, integration, verification, recovery, and complete. Each is marked as current, needing attention, holding historical evidence, or empty, and its detail pane gives the purpose, task-state counts, and the next action. Refreshes read the board and never wake a model.

| Key | Action |
|---|---|
| `↑↓`, `←→`, `PgUp/PgDn` | Select, change level, scroll the transcript |
| `s` | Steer a running executor. Choose a template (stop and report, run the project checks, stay within scope) or write a custom message, which is queued into its next LLM call |
| `F` | Send a follow-up to a live session |
| `x` | Abort a running executor; its task becomes `cancelled` |
| `a` | Accept eligible `ready_for_review` work after artifact checks. This bypasses review and is recorded as `approvalKind: "manual"` |
| `m` | Set the status of any non-live, non-terminal task |
| `r` | Retry, through the same path as `/maestro retry` |
| `p`, `v` | Show the task's report or review verdict in the session. The card is a display-only entry and never enters the model's context |
| `e` | Show the task's evidence |
| `o`, `O` | Open the executor or reviewer session in pi when the drive is idle |
| `g` | Cycle the group filter: blocked, ready, running, review needed, approved, failed, cancelled |
| `f` | Hide or show settled tasks |
| `t` | Switch the pane between the live transcript and the task timeline |

## Recipes and workflows

Recipes are versioned, declarative JSON plans: task and input fields only, with no scripts, hooks, or commands, and unknown fields are rejected. User recipes live in `~/.pi/agent/maestro-recipes/` and project recipes in `.pi/maestro-recipes/`; a project file overrides a user file of the same name. Ready-made examples are in `examples/recipes/` in the repository.

| Command | What it does |
|---|---|
| `/maestro recipe list` | List the effective user and project recipes |
| `/maestro recipe inspect <name>` | Show the validated recipe |
| `/maestro recipe preview <name> [JSON]` | Expand and compare without touching the board or archives |
| `/maestro recipe save <name> [user\|project]` | Save the current plan (default `user`) |
| `/maestro recipe run <name> [JSON]` | Expand the input into a plan; it always enters the plan gate |
| `/maestro recipe remove <name> [user\|project]` | Remove after confirmation |
| `/maestro workflows` | Browse, inspect, preview, run, save, or remove reusable workflows |

Saving validates the plan against the effective tiers and trusted verification profiles. Expansion finishes before the board changes.

A discovery task is an explicit no-file task whose executor is limited to `read,grep,find,ls`. Maestro parses only the latest completed final report as bounded declarative JSON, rejects commands and unsafe paths, and shows a deterministic preview. Generated tasks are added only after you confirm and always return to the normal plan gate. Discovery never starts generated work.

`plan diff` and `recipe preview` report added, removed, and changed task contracts plus fingerprint, dependency-wave, concurrency, launch-bound, and verification-profile effects. Bounded reports carry a deterministic reference and a follow-up command when detail is omitted.

## Configuration and recovery

| Command | What it does |
|---|---|
| `/maestro config` | The settings editor for user scope. Every row has a description, and changing a value switches the preset to `custom` |
| `/maestro config project` | The same editor for the repository |
| `/maestro config show` | Print the resolved configuration |
| `/maestro config budget <usd>` | Raise or inspect the run budget |
| `/maestro doctor` | Diagnose config, models, authentication, Git, and managed worktrees |
| `/maestro doctor cleanup` | Offer to remove stale or orphaned worktrees after rechecking the board and live runs. Non-interactively, add `confirm` |
| `/maestro replay [file]` | Restore an archived board. With no file, a picker lists archives newest first |
| `/maestro reset [confirm]` | Archive, then clear the board and goal. Non-interactive use needs `/maestro reset confirm`; the plain form refuses without archiving or changing anything |

`doctor` classifies managed worktrees as active, recoverable, retained after a merge conflict, orphaned, or stale, and also checks approved tasks for stale approval proof. It leaves active and recoverable worktrees untouched.

`replay` and `reset` refuse while executors are live. `replay` accepts an archive filename or a path that resolves inside `.pi/maestro/archive/`, validates the whole archived board before changing anything, archives the current board, then restores the selected one. `reset` copies the board to `.pi/maestro/archive/<timestamp>-board.json` first; audit history and run logs remain.

In print (`-p`) and JSON mode, command output and notices go to stderr, so JSON stdout stays clean. In RPC mode, menus use pi's stock select and editor dialogs, which the client renders.

## Cost reports

`/maestro costs` prints the board's spend split into landed work (approved tasks, rejected attempts included), work in flight, and sunk cost in cancelled tasks. It adds executor and reviewer context sizes and a reconciled breakdown. Once more than one task has spend, it ranks tasks most expensive first with executor and reviewer cost and launch counts. It warns when review spend meets or exceeds executor spend. Zero-cost startup and provider failures count as attempts but are left out of the average.

A completed drive prints a compact summary: approved, failed, cancelled, and blocked counts, rounds and attempts, cost per approved task (or "no approvals yet"), this drive's spend beside the board total, and the model and provider identifiers recorded by executors and reviewers.

`/maestro insights` is a bounded, model-free read over the current and archived boards. It groups by executor model and task tier and reports attempts, first-review approval rate, average end-to-end cost per approved task, failure kinds, reviewer rejection rate, and the cost of retries that resumed the rejected session against retries that started fresh.
