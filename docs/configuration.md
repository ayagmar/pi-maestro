# Configuration

Resolution order is defaults, operator user config, then non-executable project settings.

- User: `~/.pi/agent/maestro.json`
- Project: `<repo>/.pi/maestro.json`

Project config can tune normal settings and select a user-defined `defaultVerificationProfile`. Project `verificationProfiles` commands are ignored.

| Key | Default | Range / semantics |
|---|---:|---|
| `maxParallel` | 3 | 1–64 |
| `planGate` | false | Require human plan approval |
| `useWorktrees` | false | Isolate task checkouts |
| `autoCommit` | true | Commit only attributed task paths |
| `maxAttempts` | 3 | 1–100 consumed attempts |
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
