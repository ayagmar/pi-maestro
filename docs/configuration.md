# Configuration

`/maestro config` opens an interactive settings editor (user scope; `/maestro config project` for the repository, `/maestro config show` to print the resolved values). Every row has a description, and changing any value switches the preset to `custom`. The files are plain JSON if you prefer to edit by hand:

- User: `~/.pi/agent/maestro.json`
- Project: `<repo>/.pi/maestro.json`

Resolution order is defaults, then user config, then project config. Top-level keys merge by key. `tiers` merge by tier name, and a later scope's whole tier object replaces the earlier one of the same name. Maestro validates the effective configuration after the merge and reports incompatible values instead of clamping them or saving a configuration that cannot run.

Project config tunes ordinary settings and may select a user-defined `defaultVerificationProfile`; commands in a project's `verificationProfiles` are ignored. Pi decides whether a project is trusted. In an untrusted project, `.pi/maestro.json` is not read at all, so budgets, attempt caps, tier models, and tier tool lists keep their user or default values.

A file that is not valid JSON is moved aside as `maestro.json.corrupt-<timestamp>`, and one that parses but fails validation as `maestro.json.invalid-<timestamp>`. That scope then falls back to the lower-precedence configuration. Maestro moves a file aside only if it is still the file it read, and saves atomically, so a session reading mid-save never sees a half-written file.

| Key | Default | Range / semantics |
|---|---:|---|
| `maxParallel` | 3 | 1 to 64. Executor or reviewer processes running at once |
| `planGate` | false | Require human approval of the first plan before any executor starts |
| `livePanes` | false | Open the passive agent side pane automatically. Sessions stay available on demand |
| `useWorktrees` | false | Give every attempt an isolated Git worktree and branch |
| `detachedExecutors` | false | Unix-only detached executor transport; Git tasks auto-isolate. See below |
| `autoCommit` | true | Commit each approved task's attributed paths as one conventional commit |
| `pushOnIntegration` | false | Best-effort `git push origin <branch>` after each approved integration. A rejected push (for example a ruleset that requires pull requests) is reported as a warning and never blocks or reverts an approval. Keep it off on a protected default branch |
| `maxAttempts` | 3 | 1 to 100 consumed attempts per task |
| `maxPlanTasks` | 64 | 1 to 512 tasks at plan mutation boundaries |
| `maxDiscoveryGeneratedTasks` | 32 | 1 to 128, no greater than `maxPlanTasks` |
| `maxTotalLaunchesPerRun` | 128 | 1 to 4096 raw executor and reviewer launches per drive |
| `maxRoundsPerRun` | 20 | 1 to 1000 scheduling rounds per drive. A round is a loop pass that launched something (an execute batch plus its review batch). A clean sequential task costs one round; every rejection retry, quota-interrupted launch, or reviewer re-run costs another. The drive stops with `round_limit` when they run out, and any session can resume it |
| `confirmationPlanTasks` | 24 | Explicit confirmation above this task count; no greater than `maxPlanTasks` |
| `confirmationTotalLaunches` | 64 | Explicit confirmation above this raw-launch upper bound; no greater than `maxTotalLaunchesPerRun` |
| `reviewPolicy` | `single` | `single`, `confirm`, or `find-and-refute`. New tasks that state no policy inherit it |
| `reviewRequiredApprovals` | 2 | Integer 2 to 8; fresh approvals `confirm` requires. Cannot exceed `maxReviewerLaunches` |
| `maxReviewerLaunches` | 4 | Integer 1 to 16, counting provider-fallback launches |
| `maxCostPerTask` | 5 | USD per executor attempt; 0 disables. A capped attempt keeps its edits and resumes when the cap is raised above what it spent |
| `maxCostPerReview` | 0 | USD per reviewer launch. 0 inherits `maxCostPerTask`, so the effective reviewer ceiling is whatever that is; set this to bound reviews separately |
| `reviewCheapModel` | (none) | Model pattern for the first reviewer launch of each attempt, run at `thinking: low`. Unset keeps every reviewer on the `review` tier |
| `reviewEscalation` | risk | `risk`: escalate to the review tier on a doubtful cheap verdict or a money or migration path. `doubt`: only an unusable or rejecting cheap verdict. `always`: every reviewer after the first. `off`: no ladder. Inactive without `reviewCheapModel` |
| `maxRunCost` | 25 | USD across the board's lifetime spend, sunk cost of cancelled and superseded tasks included; 0 disables |
| `reviewRejectionLimit` | 2 | Integer 1 to 10. Consecutive genuine rejections before a task escalates instead of retrying. One rejection spanning 4 or more distinct criteria escalates at once |
| `retryContext` | resume | `resume` continues a review-rejected attempt's own session; `fresh` restarts every attempt clean. Provider fallbacks, human retries, and discovery tasks always start fresh |
| `statusWaitSeconds` | 60 | 0 to 240. Heartbeat interval for an awaited drive; 0 disables pulsing |
| `decisionNudgeMinutes` | 5 | 0 to 240. Minutes a delivered decision may sit unresolved with no board activity before the owner session is re-nudged, up to 3 times. 0 disables |
| `logEvents` | `compact` | `compact` or `full` |
| `providerQuotaWaitMinutes` | 360 | 0 to 1440. How long a drive may wait for an exhausted provider quota or usage window before stopping with `provider_blocked`. 0 stops at the first quota failure |
| `maxLogBytesPerRun` | 1000000 | Per-launch event log cap in bytes; 0 means unlimited |
| `watchdogIdleSeconds` | 120 | 0 to 86400. Silence before the watchdog steers once |
| `watchdogWarningTurns` | 12 | 0 to 10000. Turns without meaningful progress before it steers |
| `watchdogTerminationTurns` | 4 | 0 to 10000. Further no-progress turns after steering before the launch is classified `stalled` |
| `handoffContextRatio` | 0.68 | 0 to 1; 0 disables. Context fraction at which Maestro queues an automatic handoff |
| `cleanupCompletedTasks` | true | After every task is approved or cancelled, archive the final board and clear it |

## Presets

A preset sets the models and thinking level for each tier plus a few limits. The defaults derive from the Artificial Analysis Coding Agent Index v1.1 and its deep SWE leaderboard (pass@1 and average cost per run). Every preset keeps `planGate`, `livePanes`, and `useWorktrees` off and `maxRunCost` at $25.

| Preset | trivial | standard | complex | review | Parallel / attempts / attempt cap |
|---|---|---|---|---|---|
| `inherit` (default) | pi default · low | pi default · medium | pi default · high | pi default · high | 3 / 3 / $5 |
| `openai-balanced` | terra · high | sol · medium | sol · high | sol · medium | 3 / 3 / $5 |
| `openai-budget` | luna · high | terra · high | terra · xhigh | terra · xhigh | 4 / 3 / $2 |
| `openai-quality` | sol · medium | sol · high | sol · xhigh | sol · high | 3 / 4 / $5 |
| `anthropic-balanced` | sonnet-5 · low | sonnet-5 · medium | opus-4-8 · high | fable-5 · high | 3 / 3 / $5 |
| `anthropic-budget` | haiku-4-5 · medium | sonnet-5 · medium | sonnet-5 · high | sonnet-5 · high | 4 / 3 / $2 |
| `anthropic-quality` | opus-4-8 · medium | opus-4-8 · high | fable-5 · high | fable-5 · high | 3 / 4 / $5 |

`inherit` works with any provider and needs no setup. The others pin provider-qualified models (`openai-codex/gpt-5.6-sol`, `anthropic/claude-sonnet-5`), so executors always run on that provider and fail fast with a `/login` hint if it is not authenticated.

## Tiers

A task's `tier` selects its executor settings. The built-in tiers are `trivial`, `standard`, `complex`, and the read-only `review`; you can add your own, and the orchestrator's planning guidance lists them.

```json
{
  "maxParallel": 4,
  "planGate": true,
  "maxCostPerTask": 2,
  "maxRunCost": 25,
  "tiers": {
    "trivial": { "model": "gpt-5.6-terra", "thinking": "high" },
    "standard": {
      "model": "gpt-5.6-sol",
      "fallbacks": ["gpt-5.6-terra", "openai/gpt-5-mini"],
      "thinking": "medium"
    },
    "complex": { "model": "gpt-5.6-sol", "thinking": "high" },
    "review": { "model": "gpt-5.6-sol", "thinking": "medium", "tools": "read,grep,find,ls" }
  }
}
```

- `model` is a pi model pattern. A bare name such as `gpt-5.6-terra` resolves against providers you have authenticated, preferring the orchestrator's provider. `provider/id` pins one provider. Omit it to inherit pi's default model.
- `fallbacks` lists model patterns in order. Unavailable ones are skipped at preflight. At runtime Maestro advances when the current model fails before any model turn or reports quota exhaustion mid-run. That failure is recorded but does not consume `maxAttempts`, and other failures after a turn do not fall back. Review tiers take the same shape and follow the same rules, and each raw review fallback launch counts toward `maxReviewerLaunches` and stays attached to its logical reviewer. The settings editor has a searchable fallback row for every tier that edits the first fallback; write longer chains in JSON.
- `thinking` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Maestro passes it to the executor's `--thinking`, and pi clamps it to the nearest level the model supports.
- `tools` is a comma-separated allowlist. Every preset's `review` tier is `read,grep,find,ls`, so reviewers are read-only. Adding `bash` or any writing tool removes that guarantee, and this is not a machine sandbox. Operator-selected checks belong in trusted verification profiles.
- `watchdogIdleSeconds`, `watchdogWarningTurns`, and `watchdogTerminationTurns` override the global thresholds for launches on that tier, `review` included. Omitted values inherit.

Before a dispatch, Maestro resolves the primary and fallbacks for every tier in the batch, and before review it does the same for the review tier. If none is available, it fails with an actionable message before spawning anything.

## Budgets and caps

`maxRunCost` counts the board's lifetime spend, including sunk cost in cancelled and superseded tasks. Excluding it would let a cancel-and-replan loop spend without bound. `/maestro config budget <usd>` raises it in one deliberate step and resolves a pending `budget_blocked` decision when the new budget clears current spend. A running drive re-reads the budget at every boundary, so a raise takes effect without a restart, and a one-time notice fires at 80% consumption.

Each drive keeps one spend ledger. Every raw executor or reviewer launch is capped at a share of the budget left after settled spend and the caps of launches still running, so three parallel executors with $3 left can spend $3 in total, and the second reviewer of a `confirm` panel sees what the first one spent. A launch does not start when that share falls below one cent. The gate runs before a batch, so already-running executors are never aborted by it, and reviews can still run.

`maxCostPerTask` and `maxCostPerReview` abort a single launch. A capped attempt is not a failed one: its edits are checkpointed on the task branch, and once the cap rises above what it spent (or is set to 0), driving the task again resumes that attempt in the same checkout and session. Driving under the unchanged cap is refused without billing.

`maxAttempts` counts only launches that produced real work. A capped task cannot be made runnable by changing its brief or tier; recover with a successor that sets `supersedesTaskId`. Only an explicit edit in `/maestro config` changes the cap, and Maestro never raises it as a recovery action.

## Review settings

Tasks may set `reviewPolicy` to `single`, `confirm` (the configured number of fresh independent approvals), or `find-and-refute` (one finder and one independent confirmer). A task that states no policy inherits the project-wide `reviewPolicy`, so a repository chooses its review cost once; an explicit value on a task wins.

Review is where an expensive drive spends most of its money, so plan approval warns when projected reviewer spend is at least twice projected executor spend and names the effective per-launch reviewer cap. `reviewCheapModel` runs the first reviewer of each attempt on a cheap model, and `reviewEscalation` decides when the `review` tier takes over: a rejection, a missing `VERDICT` line, malformed criterion evidence, a change touching a money or migration path, or a refuter stage. The escalated verdict replaces the cheap one, and `maxReviewerLaunches` and the cost caps still bound the extra launch. The board records `costTier` and `escalationReason` per launch.

## Git behavior

With `autoCommit` on, the commit message comes from the task's `commitMessage` (the orchestrator plans one per task, such as `fix: handle empty board`) or falls back to `feat: <title>`. Main-tree runs commit only the files the executor touched, and worktree runs use the message for the merge commit. A failed commit or missing artifact proof blocks automated approval and keeps the recovery evidence.

Maestro's own commits (attempt checkpoints, reviewed integrations, worktree merges) pass `--no-gpg-sign`, because signing would make a drive depend on an interactive passphrase prompt that a remote or headless session cannot show. Your own commits are unaffected. Every Git call runs with a timeout and `GIT_TERMINAL_PROMPT=0`, so no command can hang the editor.

Promotion into your branch checks that `HEAD` still names the branch the candidate was prepared against, so switching branches or detaching `HEAD` during verification cannot land reviewed work somewhere else.

## Detached executors

`detachedExecutors` applies to executor launches, not reviewers. Pi RPC is stdio-only and cannot reconnect to an abandoned pipe, so on Unix Maestro runs the executor behind a detached supervisor with persisted JSONL event and control files. While the parent is absent, the supervisor cancels UI requests, applies the watchdog and cost caps, writes complete event lines within `maxLogBytesPerRun`, bounds stderr, and records an atomic terminal outcome.

Each launch uses its own files, named `<run id>.<8 hex>.jsonl`, and accepts only a terminal record that carries its launch id, so a leftover record from an earlier board cannot settle a new launch. An attempt stores its PID and kernel start identity and takes a seven-day dispatch lease. Git projects force it into its own task worktree. On session start, Maestro reattaches by incremental log tail and settles a run that finished while Maestro was away, before review. Windows uses the ordinary attached transport.

## Task fingerprint

An approved completion carries a versioned canonical fingerprint of the effective task contract, so it can be reused only while its inputs are unchanged. The fingerprint covers the brief and criteria, normalized write paths, the task's tier name, the review policy and confirmation count, the trusted verification profile, and the identities of dependency artifacts. It does not cover the tier's model, thinking level, tools, or fallbacks, because which model produced an artifact is provenance, not identity: a configuration edit does not change the reviewed Git tree. Runtime limits such as concurrency and attempt caps do not enter it either.

Changing a covered input marks an existing approval `stale_completion` with a component-specific reason. Recover with `/maestro retry`, a manual acceptance, or a successor. Strengthening the review policy (for example `single` to `confirm`) also makes older approvals stale unless the recorded review already meets the new policy.

## Scale confirmation and preflight

`confirmationPlanTasks` and `confirmationTotalLaunches` gate the initial plan and every drive start. Mid-run successor plans (recovery splits, `supersedesTaskId` replacements) do not re-enter the plan gate; their scale is confirmed once at the next drive start. Starting a drive through `maestro_drive` when confirmation is required is refused. The open decision is marked as awaiting you, reminders stop, and the status line asks for your `/maestro drive`.

Preflight sorts plans into small (up to 8 tasks), medium (9 to 24), and large. It reports dependency waves, configured and effective concurrency, executor and reviewer launch upper bounds, verification-profile use, and the confirmation thresholds. The projected cost is an estimate of the raw-launch upper bound. It prefers archived per-model-and-tier launch averages, then model pricing metadata with an assumed 20,000 input and 4,000 output tokens per launch, then $0.10 per unresolved launch. It is guidance, not a budget guarantee.

## Trusted verification profiles

Only user config may define executable profiles:

```json
{
  "verificationProfiles": {
    "check": { "command": "pnpm run check", "timeoutSeconds": 300 }
  },
  "defaultVerificationProfile": "check"
}
```

A project's `.pi/maestro.json` can select a known profile with `defaultVerificationProfile`; unknown selections and repository-defined commands are ignored. Task briefs and model instructions are never executed.

Commands are arbitrary local code. On Unix each runs in its own process group, and a timeout or abort sends TERM and then KILL. Windows uses `taskkill /t`, which stays best-effort until it has passed a hosted Windows run. Output is bounded and streamed to `.pi/maestro/verification/`, so a hard kill of pi keeps partial evidence. Verification must not change candidate files, and a mutation invalidates review.

## Logs and reports

`logEvents` and `maxLogBytesPerRun` control run event logs under `.pi/maestro/logs/`. Logs are capped on whole lines, and when the cap is hit one `maestro_log_capped` marker is written and the live pane shows a notice instead of a truncated fragment. Raise the cap for verbose builds if you want the pane to follow the whole run.

Runtime state is written with private POSIX modes where supported. Executor and reviewer reports are stored as bounded previews of at most 16,000 characters, and the full transcript stays in the pi session and the log. Discovery JSON keeps a larger validation limit, and an approved report is never rewritten, because its digest is dependency evidence. Dependency reports and review notes injected into a prompt are cut to 10,000 characters each, with an explicit truncation marker.
