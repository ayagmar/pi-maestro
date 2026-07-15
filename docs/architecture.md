# Architecture

Pi Maestro separates deterministic policy, persisted state, runtime adapters, and UI.

```text
Composition entry (src/index.ts) -> Pi runtime adapter (src/extension.ts)
                 |
Tools / commands / UI (src/tools.ts, src/command-dispatcher.ts, src/dashboard.ts)
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
| Pure artifact/fingerprint policy | `src/artifact-policy.ts` | No Pi, TUI, process, runner, or Git imports. |
| Active drive ownership and durable decisions | `src/drive-controller.ts` | One controller owns active/background drive state. |
| Child processes and verification process groups | `src/runner.ts` | No other module calls `spawn`. |
| Git, worktrees, immutable tree identity | `src/worktree.ts` | No other module executes Git. |
| Composition entry | `src/index.ts` | Re-exports the extension factory only; it owns no runtime state. |
| Model tool schemas, execution adapters, and rendering | `src/tools.ts` | Registers exactly the three model-facing tools. |
| Human command registration | `src/commands.ts` | The only module that registers the slash-command surface. |
| Human command dispatch | `src/command-dispatcher.ts` | Routes command families through explicit runtime, navigation, and view interfaces; family modules own their behavior. |
| Session replacement | `src/handoff.ts` | The only module allowed to call `newSession()`. |
| Pi lifecycle and UI wiring | `src/extension.ts` | Composes adapters, controller, workflow, dashboard, shortcuts, and event hooks. |

## Correctness transactions

Execution claims a task before launching. Review ownership remains claimed through reviewer settlement, immutable artifact checks, integration, trusted verification, and final board persistence. Claims renew while active and are released in `finally`; ownership-checked release cannot clear a replacement claim.

Review launches are written to the attempt before process spawn and finalized by stable launch id. A terminal convergence record separates approved work, requested changes, reviewer disagreement, and operational failure. Confirming reviewers receive no prior verdict; the find-and-refute confirmer receives only bounded finder evidence. Artifact and verification proof remains mandatory after reviewer convergence.

A background drive persists its owner, scope, and unique identity before reporting that it started.
Normal settlement atomically replaces that record with one bounded completion or decision. Reload or
shutdown reconciles an owner-scoped orphan into one internal-error decision, and durable delivery
claims prevent concurrent sessions from consuming the same wakeup.

A candidate is identified by a complete immutable Git tree, including untracked task files. Bounded diffs are presentation only. Approval provenance separately records candidate tree, review time, integrated commit/tree, and trusted verification.

Approved provenance also stores a versioned canonical task fingerprint and kind-aware dependency
artifact identities. The fingerprint covers the effective brief and criteria, normalized paths,
configured executor/reviewer tiers, review policy, trusted verification profile, and dependency
proof. Recursive freshness is memoized for dependency DAGs. Legacy or changed proof is retained for
inspection but cannot satisfy scheduling or cache reuse.

Plan import/export, pure comparison, recipe expansion, discovery approval, and ordinary planning all
produce the same validated task contracts. Comparison normalizes run state into plan definitions,
uses deterministic preflight waves and limits, and performs no board or archive writes.

The dashboard derives eight phases from board evidence rather than adding storage: discovery, plan
approval, execution, review, integration, verification, recovery, and complete. Run → phase → task →
launch navigation reads persisted attempts, review launches, artifact identities, verification, and
recovery references. Its timer only invalidates rendering; it never sends a message to a model.

Verification commands come only from operator-owned user config. Repository config may select a known profile but cannot define executable commands. Unix verification uses a process group with TERM/KILL escalation. Failed integrated verification retains recovery worktrees.

## Why exactly three model tools

The model API is deliberately limited to `maestro_plan`, `maestro_update`, and `maestro_drive`. Planning, correction, and driving cover model decisions without exposing status, simulation, pause, abort, or recovery as extra tools. Human slash commands and dashboard controls provide those operational surfaces without increasing model choice or tokens.

`maestro_drive` intentionally uses one provider-compatible object schema. The installed Pi API notes
that `Type.Union`/`Type.Literal` tool enums are not accepted by every supported provider, especially
Google-compatible APIs. Action-specific combinations are therefore checked by a small runtime
validator, while `prepareArguments` normalizes historical and plausible aliases before schema
validation. The public fields remain bounded and malformed combinations return actionable errors.
