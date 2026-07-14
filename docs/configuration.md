# Configuration

Resolution order is defaults, operator user config, then non-executable project settings.

- User: `~/.pi/agent/maestro.json`
- Project: `<repo>/.pi/maestro.json`

Project config can tune normal settings and select a user-defined `defaultVerificationProfile`. Project `verificationProfiles` commands are ignored.

| Key | Default | Range / semantics |
|---|---:|---|
| `maxParallel` | 3 | 1–64 |
| `planGate` | false | Require human plan approval |
| `livePanes` | true | Show owner-scoped live executor transcripts beside the editor in TUI mode |
| `useWorktrees` | false | Isolate task checkouts |
| `autoCommit` | true | Commit only attributed task paths |
| `maxAttempts` | 3 | 1–100 consumed attempts |
| `maxPlanTasks` | 64 | 1–512 tasks at plan mutation boundaries |
| `maxDiscoveryGeneratedTasks` | 32 | 1–128 and no greater than `maxPlanTasks` |
| `maxTotalLaunchesPerRun` | 128 | 1–4096 raw executor and reviewer launches |
| `confirmationPlanTasks` | 24 | Explicit confirmation above this task count; no greater than `maxPlanTasks` |
| `confirmationTotalLaunches` | 64 | Explicit confirmation above this raw-launch upper bound; no greater than `maxTotalLaunchesPerRun` |
| `reviewRequiredApprovals` | 2 | Integer 2–8; cannot exceed `maxReviewerLaunches` |
| `maxReviewerLaunches` | 4 | Integer 1–16; includes provider fallback launches |
| `maxCostPerTask` | 5 | USD; 0 disables |
| `maxRunCost` | 25 | USD; 0 disables |
| `statusWaitSeconds` | 60 | 0–240; 0 disables waiting |
| `logEvents` | `compact` | `compact` or `full` |
| `maxLogBytesPerRun` | 1000000 | 0 means unlimited |
| `watchdogIdleSeconds` | 120 | 0–86400 |
| `watchdogWarningTurns` | 12 | 0–10000 |
| `watchdogTerminationTurns` | 4 | 0–10000 |
| `handoffContextRatio` | 0.68 | 0–1; 0 disables |
| `cleanupCompletedTasks` | true | Archive then clear settled boards |

`tiers` must define valid thinking levels. The built-in tiers are `trivial`, `standard`, `complex`, and read-only `review`.

Tasks may select `reviewPolicy: "single" | "confirm" | "find-and-refute"`. `single` is the legacy default. `confirm` requires the configured number of fresh independent approvals. `find-and-refute` runs one finder and one independent confirmer/refuter.

The task fingerprint includes the effective task tier, configured tier model patterns/fallbacks,
review tier, review policy, confirmation count when relevant, and trusted verification profile.
Changing one of those values deliberately makes an existing approved completion stale; it is not
silently reused. Runtime-only limits such as concurrency and attempt caps affect preflight and
dispatch, but do not invalidate an otherwise identical artifact fingerprint.

Preflight classifies up to 8 tasks as small, 9–24 as medium, and larger plans as large. It reports
dependency waves, configured/effective concurrency, executor and reviewer launch upper bounds,
verification-profile usage, and confirmation thresholds. These are deterministic bounds, never
price estimates.

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

Commands are arbitrary local operator code. Output is bounded and logged. Timeout or abort terminates the verification process group. Verification must not mutate candidate files; mutation invalidates review.
