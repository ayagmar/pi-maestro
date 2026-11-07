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

## Invariants

**Claims.** A drive claims a task before it launches anything. A claim records the owner's PID and kernel start identity, and it stays held through attempt persistence, reviewer settlement, immutable artifact checks, integration, trusted verification, and the final board write. Claims renew while active and are released in `finally`; an ownership-checked release cannot clear a replacement claim. A claim whose owner process is still alive is never taken over when its 30-second lease lapses, because a slow Git command or commit hook can block the owner's event loop. Claims written by older boards keep plain lease expiry. If attributing an executor's changes fails, the attempt fails and is saved with the claim still held; startup fails any `running` task left without a claim, so it can be retried.

**Locks.** The board lock records the owner's process start time (`/proc` on Linux, `ps` on macOS and BSD), so a recycled PID cannot keep a dead lock alive. Two sessions that reclaim the same dead lock cannot delete the one the faster session just took. Interactive handlers wait for the lock asynchronously, so contention never stalls the TUI event loop. Config files are saved atomically, and a load moves a file aside only if it is still the file it read.

**One ledger per drive.** Every raw executor or reviewer launch is capped at a share of the run budget that is left after settled spend and the caps of launches still running. See [Budgets and caps](configuration.md#budgets-and-caps).

**Retired drives.** Shutdown and reload retire the drives the session started. A retired drive launches nothing further, a trusted verification that is already running is cancelled, and promotion is refused. Detached executors keep running. Startup cleanup never removes a checkout that a live executor, a detached executor, or a reviewer holding a claim is using.

**Branch-checked integration.** Promotion into the user's checkout first confirms that `HEAD` still names the branch the candidate was prepared against, so switching branches or detaching `HEAD` during verification cannot land reviewed work elsewhere. The main-tree identity check ignores `.pi/maestro.json` and `.pi/maestro-recipes/`, so editing Maestro's own configuration mid-review does not fail promotion.

**Checkpoint before removal.** Parking a task checkout checkpoints its changes onto the task branch first. If the checkpoint fails, the checkout is kept instead of being force-removed.

**Launch records.** Review launches are written to the attempt before the process spawns and finalized by stable launch id. A terminal convergence record separates approved work, requested changes, reviewer disagreement, and operational failure. Confirming reviewers receive no prior verdict; the find-and-refute confirmer receives only bounded finder evidence. Each reviewer launch records the candidate tree and task fingerprint it judged, and a `confirm` panel is cut to one reviewer only for the same candidate under the same task contract. Artifact and verification proof stays mandatory after reviewer convergence.

**Launch lifetime.** Every launch writes its event log and its detached control, exit, and stderr files under its own name, `<run id>.<8 hex>.jsonl`, and a detached launch accepts only a terminal record that carries its launch id. A leftover record from an earlier board therefore cannot settle a new launch. An attached launch settles at most two seconds after pi exits and then kills its process group, so a descendant that inherited pi's output cannot hold the outcome. A launch that pi settles with `aborted: true` when Maestro did not ask for it is recorded as a retryable failure even when pi exits 0, so a cancel from inside the child can never settle a task or finish a drive. A stdout line that is valid JSON but not an RPC event is skipped and recorded as at most three `maestro_malformed_event` diagnostics per launch. A session is resumed only inside the checkout it recorded; when that checkout is gone the attempt starts fresh. An executor whose prompt pi reports as `handled` fails at once with that reason.

**Transcripts stay out of context.** Reading an agent session transcript or a run log with the model's read tools is blocked before execution. Bounded evidence is available through `maestro_drive` inspect and the dashboard. A task report or review verdict opened from the dashboard is added to the session as a custom entry with its own renderer, so it never enters the model's context. Orchestrator kickoff and decision messages do reach the model.

**Background drives.** A background drive persists its owner, scope, and unique identity before reporting that it started.
Normal settlement atomically replaces that record with one bounded completion or decision. Reload or
shutdown reconciles an owner-scoped orphan into one internal-error decision, and durable delivery
claims prevent concurrent sessions from consuming the same wakeup.

**Candidate identity.** A candidate is identified by a complete immutable Git tree, including untracked task files. Bounded diffs are presentation only. Approval provenance separately records candidate tree, review time, integrated commit/tree, and trusted verification. Task worktrees exist only while an executor, reviewer, or manual inspection needs the checkout. At idle boundaries, recoverable changes are checkpointed on the task branch and the checkout is removed; review and retry restore it from that branch. Clean idle branches are deleted.

**Approval freshness.** Approved provenance also stores a versioned canonical task fingerprint and kind-aware dependency
artifact identities. The fingerprint covers the effective brief and criteria, normalized paths,
tier name, review policy, trusted verification profile, and dependency
proof. It leaves out the tier's model, thinking level, tools, and fallbacks, because which model produced an artifact is provenance, not identity; see [Task fingerprint](configuration.md#task-fingerprint). The record keeps `version: 1` and marks the current hashing as `executionShape: 2`, so a build that is still running in another pi session does not reject it as an unknown version. Recursive freshness is memoized for dependency DAGs. Legacy or changed proof is retained for
inspection but cannot satisfy scheduling or cache reuse.

**One contract path.** Plan import/export, pure comparison, recipe expansion, discovery approval, and ordinary planning all
produce the same validated task contracts. Comparison normalizes run state into plan definitions,
uses deterministic preflight waves and limits, and performs no board or archive writes.

**Dashboard.** The dashboard derives eight phases from board evidence rather than adding storage: discovery, plan
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

Pi RPC is a stdin/stdout protocol and cannot reconnect abandoned anonymous pipes. When the opt-in `detachedExecutors` setting is enabled on Unix, `runner.ts` launches the executor behind a detached supervisor process with persisted JSONL event/control files. The supervisor handles UI cancellation, watchdog steering/termination, cost caps, complete-line compact/full logging, bounded stderr, and an atomic terminal outcome record while the parent is absent. Attempts persist PID plus kernel start identity and a long bounded dispatch lease; startup preserves only identity-matching live processes, incrementally tails appended event bytes, and settles the existing worktree-backed attempt through the normal execution boundary. Reviewer launches remain attached, and Windows retains the ordinary transport. Ordinary report previews are bounded at ingestion; discovery JSON keeps its larger validation limit, and a previously approved report artifact is never rewritten because its digest is dependency evidence.

Verification commands come only from operator-owned user config. Repository config may select a known profile but cannot define executable commands. Unix verification uses a process group with TERM/KILL escalation. Windows attached runs invoke `taskkill /t` with forced escalation for descendant cleanup, but Windows CI remains non-blocking until that behavior has passed a real hosted Windows run. Failed integrated verification retains a checkpoint branch while its idle checkout is parked.

## UI surfaces

Maestro renders for the mode pi reports. In the TUI, pickers and viewers are custom components that take their key hints and bindings from the keybindings pi injects, so remapped keys work and show correctly. Inline pickers and the single-line editor pass pi's `blocked` status to `ctx.ui.custom`, so a terminal that shows pi's program status reports Maestro as waiting for you instead of working. Rows in the agent selector are cut to the terminal width, because pi's main-screen TUI mode rejects a wider row by crashing.

In `pi --mode rpc`, `/maestro plan`, `/maestro workflows`, and the plan task editor use pi's stock select and editor dialogs, which RPC forwards to the client, and the viewers send their text as a notification. In print (`-p`) and JSON mode, command output and notices go to stderr, so JSON stdout stays clean.

The live agent pane marks a launch finished on `agent_settled`, not `agent_end`, so a launch that pi is about to retry or continue does not show as done. It applies `context_edit` session entries as they arrive.

## Why exactly three model tools

The model API is deliberately limited to `maestro_plan`, `maestro_update`, and `maestro_drive`. Planning, correction, and driving cover model decisions without exposing status, simulation, pause, abort, or recovery as extra tools. Human slash commands and dashboard controls provide those operational surfaces without increasing model choice or tokens.

`maestro_drive` intentionally uses one provider-compatible object schema. The installed Pi API notes
that `Type.Union`/`Type.Literal` tool enums are not accepted by every supported provider, especially
Google-compatible APIs. Action-specific combinations are therefore checked by a small runtime
validator, while `prepareArguments` normalizes historical and plausible aliases before schema
validation. The public fields remain bounded and malformed combinations return actionable errors.
