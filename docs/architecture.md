# Architecture

Pi Maestro separates deterministic policy, persisted state, runtime adapters, and UI.

```text
Composition entry (src/index.ts) -> Pi runtime adapter (src/extension.ts)
                 |
Tools / commands / UI (src/tools.ts, src/commands.ts, src/dashboard.ts)
                 |
Drive runtime (src/drive-controller.ts) -> workflow orchestration (src/workflow.ts)
                 |                         |
Board boundary (src/board.ts)       runner.ts / worktree.ts
                 |
       .pi/maestro durable state
```

## Ownership boundaries

| Concern | Owner | Rule |
|---|---|---|
| Board persistence and status history | `src/board.ts` | Other modules use board functions; they do not name the board file. |
| Pure artifact policy | `src/artifact-policy.ts` | No Pi, TUI, process, runner, or Git imports. |
| Active drive ownership and durable decisions | `src/drive-controller.ts` | One controller owns active/background drive state. |
| Child processes and verification process groups | `src/runner.ts` | No other module calls `spawn`. |
| Git, worktrees, immutable tree identity | `src/worktree.ts` | No other module executes Git. |
| Composition entry | `src/index.ts` | Re-exports the extension factory only; it owns no runtime state. |
| Model tool schemas, execution adapters, and rendering | `src/tools.ts` | Registers exactly the three model-facing tools. |
| Human command registration and parsing | `src/commands.ts` | Owns the slash-command surface; runtime handlers are composed by `src/extension.ts`. |
| Session replacement | `src/handoff.ts` | The only module allowed to call `newSession()`. |
| Pi lifecycle and UI wiring | `src/extension.ts` | Composes adapters, controller, workflow, dashboard, shortcuts, and event hooks. |

## Correctness transactions

Execution claims a task before launching. Review ownership remains claimed through reviewer settlement, immutable artifact checks, integration, trusted verification, and final board persistence. Claims renew while active and are released in `finally`; ownership-checked release cannot clear a replacement claim.

A candidate is identified by a complete immutable Git tree, including untracked task files. Bounded diffs are presentation only. Approval provenance separately records candidate tree, review time, integrated commit/tree, and trusted verification.

Verification commands come only from operator-owned user config. Repository config may select a known profile but cannot define executable commands. Unix verification uses a process group with TERM/KILL escalation. Failed integrated verification retains recovery worktrees.

## Why exactly three model tools

The model API is deliberately limited to `maestro_plan`, `maestro_update`, and `maestro_drive`. Planning, correction, and driving cover model decisions without exposing status, simulation, pause, abort, or recovery as extra tools. Human slash commands and dashboard controls provide those operational surfaces without increasing model choice or tokens.
