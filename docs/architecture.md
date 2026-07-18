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
| Active drive ownership, live runs, and durable decisions | `src/drive-controller.ts` | One controller owns active/background drive state and identity-safe executor/reviewer lifetimes. |
| Child processes and verification process groups | `src/runner.ts` | No other module calls `spawn`. |
| Executor dispatch and attempt finalization | `src/workflow-execution.ts` | Owns executor launch fallback, attempt consumption, outcome classification, and finalization. |
| Reviewer execution and convergence | `src/workflow-review.ts` | Owns reviewer launch fallback, evidence, convergence, and settlement coordination. |
| Reviewed candidate integration transaction | `src/workflow-integration.ts` | Serializes prepared worktree/main-tree promotion and post-integration verification. |
| Git, worktrees, immutable tree identity | `src/worktree.ts` | No other module executes Git. |
| Composition entry | `src/index.ts` | Re-exports the extension factory only; it owns no runtime state. |
| Model tool schemas, execution adapters, and rendering | `src/tools.ts` | Registers exactly the three model-facing tools. |
| Human command registration | `src/commands.ts` | The only module that registers the slash-command surface. |
| Human command dispatch | `src/command-dispatcher.ts` | Routes command families through explicit runtime, navigation, and view interfaces; family modules own their behavior. |
| Session replacement | `src/handoff.ts` | The only module allowed to call `newSession()`. |
| Pi lifecycle events and reload recovery | `src/extension-lifecycle.ts` | The only adapter that registers session lifecycle hooks; it receives narrow runtime, navigation, and UI callbacks. |
| Dashboard overlay and task actions | `src/dashboard-controller.ts` | Owns dashboard construction, action wiring, session routing, and status mutation adapters. |
| Live agent pane overlay and focus | `src/live-pane-controller.ts` | Owns pane creation, suppression, focus, session actions, and stale-context-safe settlement. |
| Pi composition and UI wiring | `src/extension.ts` | Constructs adapters and registers tools, commands, shortcuts, rendering, and lifecycle teardown. |

## Correctness transactions

Execution claims a task before launching. Review ownership remains claimed through reviewer settlement, immutable artifact checks, integration, trusted verification, and final board persistence. Claims renew while active and are released in `finally`; ownership-checked release cannot clear a replacement claim.

Review launches are written to the attempt before process spawn and finalized by stable launch id. A terminal convergence record separates approved work, requested changes, reviewer disagreement, and operational failure. Confirming reviewers receive no prior verdict; the find-and-refute confirmer receives only bounded finder evidence. Artifact and verification proof remains mandatory after reviewer convergence.

A background drive persists its owner, scope, and unique identity before reporting that it started.
Normal settlement atomically replaces that record with one bounded completion or decision. Reload or
shutdown reconciles an owner-scoped orphan into one internal-error decision, and durable delivery
claims prevent concurrent sessions from consuming the same wakeup.

A candidate is identified by a complete immutable Git tree, including untracked task files. Bounded diffs are presentation only. Approval provenance separately records candidate tree, review time, integrated commit/tree, and trusted verification. Task worktrees exist only while an executor, reviewer, or manual inspection needs the checkout. At idle boundaries, recoverable changes are checkpointed on the task branch and the checkout is removed; review and retry restore it from that branch. Clean idle branches are deleted.

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

## Child-session storage boundary

`runner.ts` gives every raw executor and reviewer launch a unique `--session-dir` beneath
`<default-project-session-dir>/.maestro/`. The execution cwd may be an ephemeral worktree, but the
storage root is derived from the main Maestro project cwd. Pi's ordinary session picker is
non-recursive, so managed children remain outside `/resume`; board references and Maestro's agent
browser open their exact files. Recursive usage scanners still traverse the nested JSONL transcripts.
This separates session discoverability from accounting without changing Pi's session format.

Pi RPC is a stdin/stdout protocol and cannot reconnect abandoned anonymous pipes. When the opt-in `detachedExecutors` setting is enabled on Unix, `runner.ts` instead launches the executor behind persisted JSONL event/control files in a detached process group. Attempts persist PID plus kernel start identity and a long bounded dispatch lease; startup preserves only identity-matching live processes, tails their complete event log, and settles the existing worktree-backed attempt through the normal execution boundary. Reviewer launches remain attached, and Windows retains the ordinary transport.

Verification commands come only from operator-owned user config. Repository config may select a known profile but cannot define executable commands. Unix verification uses a process group with TERM/KILL escalation. Failed integrated verification retains a checkpoint branch while its idle checkout is parked.

## Why exactly three model tools

The model API is deliberately limited to `maestro_plan`, `maestro_update`, and `maestro_drive`. Planning, correction, and driving cover model decisions without exposing status, simulation, pause, abort, or recovery as extra tools. Human slash commands and dashboard controls provide those operational surfaces without increasing model choice or tokens.

`maestro_drive` intentionally uses one provider-compatible object schema. The installed Pi API notes
that `Type.Union`/`Type.Literal` tool enums are not accepted by every supported provider, especially
Google-compatible APIs. Action-specific combinations are therefore checked by a small runtime
validator, while `prepareArguments` normalizes historical and plausible aliases before schema
validation. The public fields remain bounded and malformed combinations return actionable errors.
