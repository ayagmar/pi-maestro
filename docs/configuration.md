# Configuration

Resolution order is defaults, operator user config, then non-executable project settings. Maestro
validates the effective configuration after the merge and reports the incompatible effective values
instead of clamping them or saving a configuration that cannot execute.

- User: `~/.pi/agent/maestro.json`
- Project: `<repo>/.pi/maestro.json`

Project config can tune normal settings and select a user-defined `defaultVerificationProfile`. Project `verificationProfiles` commands are ignored.

| Key | Default | Range / semantics |
|---|---:|---|
| `maxParallel` | 3 | 1–64 |
| `planGate` | false | Require human plan approval |
| `livePanes` | false | Automatically open the passive agent pane; sessions remain available on demand |
| `useWorktrees` | false | Isolate task checkouts |
| `detachedExecutors` | false | Unix-only detached executor transport; Git tasks auto-isolate |
| `autoCommit` | true | Commit only attributed task paths |
| `pushOnIntegration` | false | Best-effort `git push origin <branch>` after each approved integration. Never blocks or reverts an approval; a rejected push (for example a ruleset that requires pull requests on the default branch) is reported as a warning, so keep this off when the default branch is protected or when approved work is not yet authorized for publication. |
| `maxAttempts` | 3 | 1–100 consumed attempts |
| `maxPlanTasks` | 64 | 1–512 tasks at plan mutation boundaries |
| `maxDiscoveryGeneratedTasks` | 32 | 1–128 and no greater than `maxPlanTasks` |
| `maxTotalLaunchesPerRun` | 128 | 1–4096 raw executor and reviewer launches |
| `maxRoundsPerRun` | 20 | 1–1000 scheduling rounds per drive (one round is a loop pass that launched something: an execute batch plus its review batch). A clean sequential task costs one round; every rejection retry, quota-interrupted launch, or reviewer re-run costs another. Raise it for long unattended drives; the drive stops with `round_limit` when exhausted, which any session can resume. |
| `confirmationPlanTasks` | 24 | Explicit confirmation above this task count; no greater than `maxPlanTasks` |
| `confirmationTotalLaunches` | 64 | Explicit confirmation above this raw-launch upper bound; no greater than `maxTotalLaunchesPerRun` |
| `reviewPolicy` | `single` | `single`, `confirm`, or `find-and-refute`; inherited by new tasks that do not state one |
| `reviewRequiredApprovals` | 2 | Integer 2–8; cannot exceed `maxReviewerLaunches` |
| `maxReviewerLaunches` | 4 | Integer 1–16; includes provider fallback launches |
| `maxCostPerTask` | 5 | USD per executor attempt; 0 disables. A capped attempt keeps its edits and resumes when the cap is raised above what it spent |
| `maxCostPerReview` | 0 | USD per reviewer launch; 0 inherits `maxCostPerTask` (the effective reviewer ceiling is whatever `maxCostPerTask` is, so set this explicitly to bound reviews separately) |
| `reviewCheapModel` | (none) | Model pattern for the first reviewer launch on each attempt, run at `thinking: low`. Unset keeps every reviewer on the `review` tier (with its configured thinking). The review tier takes over when the cheap first pass is doubtful (a rejection, no `VERDICT` line, or malformed criterion evidence), the change touches a money or migration/schema path, a refuter stage runs, or the trigger says so. |
| `reviewEscalation` | risk | `risk` (default): escalate on doubt or a money/migration path. `doubt`: only an unusable or rejecting cheap verdict. `always`: every reviewer after the first runs on the review tier. `off`: no ladder. Inactive without `reviewCheapModel`. |
| `maxRunCost` | 25 | USD across the board's lifetime spend, sunk cost of cancelled and superseded tasks included; 0 disables. Excluding sunk spend would let a cancel-and-replan loop spend without bound. Each launch is additionally capped at the remaining run budget, and `/maestro config budget <usd>` raises the cap deliberately when a board needs more. |
| `reviewRejectionLimit` | 2 | Integer 1–10; consecutive genuine reviewer rejections before a task escalates instead of retrying. One rejection spanning 4+ distinct criteria escalates immediately as an omnibus-task signal. |
| `retryContext` | resume | `resume` continues a review-rejected attempt's own session, so the model keeps everything it already read and providers bill the history at cached rates; `fresh` restarts every attempt with a clean context. Provider fallbacks, human retries, and discovery tasks always start fresh. |
| `statusWaitSeconds` | 60 | 0–240; awaited-drive heartbeat interval, 0 disables pulsing |
| `decisionNudgeMinutes` | 5 | 0–240; minutes a delivered decision may sit unresolved with no board activity before the owner session is re-nudged (up to 3 reminders). A provider failure can kill the turn a decision triggered; without the nudge the board sits blocked while the orchestrator looks idle. 0 disables. |
| `logEvents` | `compact` | `compact` or `full` |
| `providerQuotaWaitMinutes` | 360 | 0–1440 | How long a drive may wait for a provider whose quota or usage window is exhausted (`usage limit`, `429`, `rate limit`) before stopping with `provider_blocked`. For `openai-codex` Maestro reads the account usage endpoint and waits exactly until the exhausted window's published `reset_at`; the default covers a full 5-hour window, and a weekly window that resets beyond the budget stops the drive at once with its reset time. Providers without a reset clock are probed with 2/4/8/15-minute backoff (each probe is a failed launch that never consumes an attempt). 0 stops at the first quota failure. Credential, billing, and unknown-model failures never wait. |
| `maxLogBytesPerRun` | 1000000 | Per-launch event log cap; 0 means unlimited. Whole lines only: when the cap is hit one `maestro_log_capped` marker is written and the live pane shows a notice. Raise it for verbose builds (Maven, Gradle) if you want the pane to follow the whole run. |
| `watchdogIdleSeconds` | 120 | 0–86400 |
| `watchdogWarningTurns` | 12 | 0–10000 |
| `watchdogTerminationTurns` | 4 | 0–10000 |
| `handoffContextRatio` | 0.68 | 0–1; 0 disables |
| `cleanupCompletedTasks` | true | Archive then clear settled boards |

`detachedExecutors` is opt-in and applies to executor launches, not reviewers. Pi RPC exposes only stdio, so Unix survivability uses persisted JSONL control/event files and a detached supervisor process rather than attempting to reconnect abandoned pipes. The supervisor handles UI requests by cancelling them, applies the same watchdog and cost-cap termination policy, writes complete event lines within `maxLogBytesPerRun`, bounds stderr, and persists a terminal outcome record; after the executor exits it drains stdout briefly and then settles even if a tool-spawned descendant still holds the stdio pipes, reaping that process group. Attempts persist PID plus kernel start identity, receive a seven-day dispatch lease, auto-isolate in Git worktrees, and reattach by incremental log tail on session start. Windows uses the ordinary attached transport.

`tiers` must define valid thinking levels. The built-in tiers are `trivial`, `standard`, `complex`, and read-only `review`. Each tier may set `watchdogIdleSeconds` (0–86400), `watchdogWarningTurns` (0–10000), and `watchdogTerminationTurns` (0–10000); those values override the corresponding global watchdog thresholds only for launches on that tier. Omitted tier fields inherit the global values, including on the `review` tier.

Tasks may select `reviewPolicy: "single" | "confirm" | "find-and-refute"`. A task that states no policy inherits the project-wide `reviewPolicy` setting (default `single`), so a repository chooses its review cost once instead of per task; an explicit value on a task always wins. `confirm` requires the configured number of fresh independent approvals. `find-and-refute` runs one finder and one independent confirmer/refuter.

The task fingerprint includes the effective task tier, configured tier model patterns/fallbacks,
review tier, review policy, confirmation count when relevant, and trusted verification profile.
Changing one of those values deliberately makes an existing approved completion stale; it is not
silently reused. Runtime-only limits such as concurrency and attempt caps affect preflight and
dispatch, but do not invalidate an otherwise identical artifact fingerprint.

Scale confirmation (`confirmationPlanTasks`, `confirmationTotalLaunches`) gates the initial plan
and every drive start. Mid-run successor plans (recovery splits, `supersedesTaskId` replacements)
do not re-enter the plan gate; their scale is confirmed once at the next drive start instead of
freezing autonomous recovery behind a second human approval.

Preflight classifies up to 8 tasks as small, 9–24 as medium, and larger plans as large. It reports
dependency waves, configured/effective concurrency, executor and reviewer launch upper bounds,
verification-profile usage, confirmation thresholds, and a clearly labeled projected-cost estimate.
The estimate prices the raw-launch upper-bound scenario. It prefers archived per-model-and-tier
launch averages, falls back to model pricing metadata with a rough assumption of 20,000 input and
4,000 output tokens per launch, then uses $0.10 per unresolved launch. It is guidance rather than a
budget guarantee.

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

Commands are arbitrary local operator code. Output is bounded and logged. Timeout or abort terminates the verification process tree (Unix process groups; Windows `taskkill /t` with forced escalation). Verification must not mutate candidate files; mutation invalidates review. Runtime board, history, archive, control, log, and verification evidence is created with private POSIX modes where supported. Ordinary executor and reviewer reports are bounded previews; discovery JSON retains its larger validation limit, approved report identities are immutable, and the full transcript remains in the Pi session/log. Windows tree cleanup remains best-effort until it passes a real hosted Windows run.
