# Getting started

Pi Maestro is a pi package. It adds an orchestrator layer to the session you already use: your model plans a goal into tasks, fresh pi processes execute them, independent reviewers check the results, and a board under `.pi/maestro/` keeps the evidence.

## Install

```bash
pi install npm:@ayagmar/pi-maestro
```

Other sources:

```bash
pi install git:github.com/ayagmar/pi-maestro   # straight from GitHub
pi install /path/to/pi-maestro                  # from a local checkout
pi -e npm:@ayagmar/pi-maestro                   # one session, nothing installed
pi update npm:@ayagmar/pi-maestro               # update an installed copy
```

The npm package is scoped because the unscoped `pi-maestro` name on npm belongs to an unrelated project. A project-scoped install (`pi install -l …`) loads only in projects you have trusted in pi.

Requirements: pi 1.5 or newer (tested against `1.5.x`) and Node.js 22.19 or newer.

## Check the environment

Run `/maestro` to open the project control center and choose **Check setup and recovery**, or run the diagnostic directly:

```text
/maestro doctor
```

The report covers config files and precedence, effective limits and tiers, authenticated model and fallback resolution, Git readiness, and managed worktrees. It never prints API keys. Missing authentication, unavailable models, invalid JSON, and a repository without an initial commit each come with a next step.

The default `inherit` preset needs no setup: executors use your pi default model and only the thinking level differs between tiers. For cheaper executors, pick a preset with `/maestro config` (see [Configuration](configuration.md)).

## Run a first goal

```text
/maestro start migrate the auth module to the new session API and add tests
```

Maestro injects an orchestrator briefing into the current session, and the model drives the loop with three tools:

| Tool | What it does |
|---|---|
| `maestro_plan` | Creates tasks with self-contained briefs, complexity tiers, dependencies, and bounded write scopes |
| `maestro_update` | Refines or cancels planned work. Changing the contract of a running or `ready_for_review` task needs `invalidateInFlight: true`, which discards that paid work and returns its cost as a warning |
| `maestro_drive` | Runs the run/review/retry loop until the board settles, inspects it, or intervenes in live work |

Everything else (approval, pause, abort, recovery, inspection) is a human command, so it never enlarges the model's choices.

Give each task one outcome, a bounded write scope, and 1 to 12 observable success criteria. A read-only investigation sets `kind: "investigation"` and an empty scope. If you already have a plan (a design doc, an issue list), paste it and ask the model to turn it into `maestro_plan` tasks. `/maestro start` is for goals that need the expensive model to do the decomposition.

Then start the loop with `/maestro drive`, or let the model call `maestro_drive`. Follow it with `/maestro board` and read the history with `/maestro timeline`; neither calls a model.

## Approve a plan before it runs

With `planGate` on, the first `maestro_plan` leaves the plan pending and no executor starts until you approve it:

```text
/maestro start <goal>     # the model plans; the plan stays pending
/maestro plan             # read summaries and full briefs, edit, then Approve plan or Reject plan
/maestro drive            # runs after approval
```

Rejecting archives the board and, after confirmation, clears it. `/maestro plan` opens with an overview of every pending task (criteria, write scope, verification, review policy, commit message) and a projected-cost estimate. Each task can be edited in place: title, brief, tier, dependencies, criteria, write scope, commit message, verification profile, or cancellation. **Save changes** validates the whole draft, and an invalid plan stays pending and unchanged until the listed ids, references, cycles, or tiers are fixed.

## Plan, then hand off

Planning fills the orchestrator's context with file reads and dead ends that execution does not need. Task briefs are self-contained and all durable state lives on the board, so the planning context is disposable:

```text
/maestro start <goal>     # expensive model investigates and plans
/maestro board            # review and adjust
/maestro handoff          # a fresh supervisor drives from the board alone
```

`/maestro handoff` starts a new session whose supervisor gets the goal, the task list, and tier guidance, and none of the planning tokens. The planning session stays on disk (`/resume` to revisit it). When the context crosses `handoffContextRatio`, Maestro queues the same handoff once it is safe to do so. For small goals, skip it: one session is fine.

## Next

- [How it works](how-it-works.md): roles, task lifecycle, and what stops a drive
- [Command reference](commands.md): every command, the dashboard keys, and cost reports
- [Configuration](configuration.md): presets, tiers, limits, and trusted verification
- [Operations and recovery](operations.md): what to do when a drive stops
