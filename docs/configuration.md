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
| `maxAttempts` | 3 | 1–100 consumed attempts |
| `maxPlanTasks` | 64 | 1–512 tasks at plan mutation boundaries |
| `maxDiscoveryGeneratedTasks` | 32 | 1–128 and no greater than `maxPlanTasks` |
| `maxTotalLaunchesPerRun` | 128 | 1–4096 raw executor and reviewer launches |
| `confirmationPlanTasks` | 24 | Explicit confirmation above this task count; no greater than `maxPlanTasks` |
| `confirmationTotalLaunches` | 64 | Explicit confirmation above this raw-launch upper bound; no greater than `maxTotalLaunchesPerRun` |
| `reviewPolicy` | `single` | `single`, `confirm`, or `find-and-refute`; inherited by new tasks that do not state one |
| `reviewRequiredApprovals` | 2 | Integer 2–8; cannot exceed `maxReviewerLaunches` |
| `maxReviewerLaunches` | 4 | Integer 1–16; includes provider fallback launches |
| `maxCostPerTask` | 5 | USD; 0 disables |
| `maxCostPerReview` | 0 | USD per reviewer launch; 0 inherits `maxCostPerTask` |
| `maxRunCost` | 25 | USD; 0 disables |
| `reviewRejectionLimit` | 2 | Integer 1–10; consecutive genuine reviewer rejections before a task escalates instead of retrying. One rejection spanning 4+ distinct criteria escalates immediately as an omnibus-task signal. |
| `retryContext` | resume | `resume` continues a review-rejected attempt's own session, so the model keeps everything it already read and providers bill the history at cached rates; `fresh` restarts every attempt with a clean context. Provider fallbacks, human retries, and discovery tasks always start fresh. |
| `statusWaitSeconds` | 60 | 0–240; awaited-drive heartbeat interval, 0 disables pulsing |
| `logEvents` | `compact` | `compact` or `full` |
| `maxLogBytesPerRun` | 1000000 | 0 means unlimited |
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
