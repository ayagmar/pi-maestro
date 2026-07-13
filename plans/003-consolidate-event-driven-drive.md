# Plan 003: Expose three model tools and make autonomous drive event-driven

> **Executor instructions**: Use normal repository execution. Read the full pi extension documentation before changing session/message behavior: `$HOME/.fnm/node-versions/v24.12.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`. Pay particular attention to `pi.sendMessage`, `pi.sendUserMessage`, `ExtensionContext` versus `ExtensionCommandContext`, session replacement footguns, `StringEnum`, and output truncation. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 41b6057..HEAD -- src/index.ts src/prompts.ts src/types.ts src/format.ts test/index.test.ts test/prompts.test.ts README.md`
> Reconcile Plan 002’s approval/worktree changes before proceeding.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/002-transactional-task-execution.md`
- **Category**: architecture, performance, dx
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Six model-facing tools expose mechanical workflow phases and encourage expensive polling. The orchestrator should express only three intentions: create work, change work, and drive work. Routine progress should remain in the dashboard; the model should wake only for a compact decision or completion message.

## Current state

`src/index.ts` registers six tools:

- `maestro_plan`
- `maestro_run`
- `maestro_review`
- `maestro_drive`
- `maestro_update`
- `maestro_status`

`maestro_drive` starts a background operation, while the prompt instructs the model to repeatedly call `maestro_status`. Status returns the full board plus progress and cost. Handoff exists as a slash command because only command contexts can call `newSession()` safely. Existing dashboard and slash controls must remain available to humans.

Relevant pi API constraints:

- Tools receive `ExtensionContext`, not `ExtensionCommandContext`; they cannot directly call `newSession()`.
- `pi.sendMessage(..., { triggerTurn: true })` can wake an idle agent with a custom decision message.
- A tool can queue an extension command as a follow-up user message when command-context behavior is required; follow the documented reload-runtime pattern rather than using stale context.
- Use `StringEnum` from `@earendil-works/pi-ai` for model-compatible action enums.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tool registration check | `rg -n 'name: "maestro_' src/index.ts` | exactly three model-facing names after migration |
| Focused tests | `node --import=tsx --test test/index.test.ts test/prompts.test.ts` | all pass |
| Full gate | `pnpm run check` | exit 0 |

## Scope

**In scope**:
- `src/index.ts`
- `src/prompts.ts`
- `src/types.ts`
- `src/format.ts` if compact decision formatting belongs there
- `test/index.test.ts`
- `test/prompts.test.ts`
- `README.md`

**Out of scope**:
- Removing human slash commands or dashboard actions
- Implementing detailed stall heuristics (Plan 004)
- Changing executor/reviewer models
- New dependencies
- Rewriting the board persistence layer

## Git workflow

Do not commit unless separately requested. Keep intermediate states testable: extract internal operations first, then replace registrations, then update prompts/docs.

## Steps

### Step 1: Extract state-aware internal workflow operations

Extract the existing run, review, status, resume, pause, abort, and handoff mechanics into readable internal functions. Preserve current tests while removing dependence on a specific tool registration.

The drive engine must infer mechanical action from task state:

- `todo`/retryable → execute
- `ready_for_review` → review
- approved/canceled → skip unless explicitly reactivated
- provider/cost/escalation/cap → stop with decision

Do not require the model to choose run versus review.

**Verify**: existing run/review/drive tests pass before tool registrations change.

### Step 2: Define a compact `maestro_drive` action schema

Use one model tool with a small enum and optional fields, for example:

```ts
{
  action: "start" | "inspect" | "intervene",
  taskIds?: string[],
  decisionId?: string,
  intervention?: "steer" | "abort" | "handoff",
  instruction?: string
}
```

Rules:

- `start` starts or resumes a state-aware drive; optional task IDs scope it.
- `inspect` returns bounded evidence for live tasks or the current decision, never the full transcript by default.
- `intervene` requires a live persisted decision ID and validates the chosen action.
- Task plan changes remain in `maestro_plan`/`maestro_update`; do not duplicate tier/brief/dependency fields here.
- Use `prepareArguments()` only if needed to migrate stored legacy drive calls.

**Verify**: schema tests reject invalid field combinations and accept the minimal examples.

### Step 3: Reduce model-facing tools to three

Keep registered for the LLM:

- `maestro_plan`
- `maestro_update`
- `maestro_drive`

Remove `maestro_run`, `maestro_review`, and `maestro_status` as model tools after their mechanics are internal. Preserve equivalent slash commands and dashboard actions for humans.

Tool descriptions and prompt snippets must be short and intention-oriented. Avoid duplicating the full workflow policy in every description.

**Verify**:

```bash
python3 - <<'PY'
import re
s=open('src/index.ts').read()
print(re.findall(r'name: "(maestro_[^"]+)"', s))
PY
```

Expected list contains exactly plan, update, drive.

### Step 4: Persist compact decision records

Add a bounded decision record to board/run state containing:

- stable decision ID
- task IDs
- kind
- concise evidence
- allowed interventions
- created timestamp
- resolution if settled

Do not persist raw transcripts or giant reports in the decision. Store file/session references for deeper inspection.

Only one active unresolved decision should exist per drive. Repeated calls must be idempotent.

**Verify**: reload tests reconstruct and resolve a decision exactly once.

### Step 5: Wake the orchestrator only for decisions and completion

When a background drive settles at a decision point or completes, use `pi.sendMessage()` with a compact custom message and `triggerTurn: true`. Choose delivery mode so it does not interrupt an active model turn; follow the extension docs.

Routine round/task progress updates only refresh TUI status/widget/dashboard and optionally append TUI-only entries. They must not trigger LLM turns or enter LLM context.

Prevent duplicate wakeups across reload/session ownership by persisting notification state or a delivered marker.

**Verify**: tests assert:

- routine progress sends no model message
- one decision sends exactly one triggered message
- completion sends exactly one triggered message
- reload does not resend an acknowledged decision
- another session cannot consume the owner’s decision

### Step 6: Route handoff through the existing command safely

Because tools cannot call `newSession()`, `maestro_drive` intervention `handoff` should queue the existing `/maestro handoff` extension command using the documented follow-up-message pattern. The command remains the only code that performs session replacement.

Handoff must:

- occur only with no unsafe live operation
- capture only plain serializable board/goal data before replacement
- use only the fresh context inside `withSession`
- preserve the parent session
- inject compact unresolved board/decision state

**Verify**: retain all stale-context handoff tests and add a tool-to-command routing test.

### Step 7: Rewrite briefings and docs around the new contract

Remove instructions to poll and narrate every pulse. Briefings should say:

1. Plan with `maestro_plan`.
2. Amend with `maestro_update` when judgment changes the plan.
3. Call `maestro_drive({action:"start"})` once.
4. Wait for decision/completion wakeups.
5. Resolve decisions through update/plan/drive intervention.

Document that manual slash commands still exist but are not part of the LLM tool surface.

**Verify**:

```bash
rg -n "maestro_status|maestro_run|maestro_review" src/prompts.ts README.md
```

Expected: mentions only in human-command/manual compatibility documentation, not orchestrator instructions.

### Step 8: Run full verification

```bash
node --import=tsx --test test/index.test.ts test/prompts.test.ts
pnpm run check
git diff --check
```

## Test plan

Cover:

- exactly three registered model tools
- state-aware drive executes then reviews without model phase choice
- compact action schema and invalid combinations
- persisted decision ownership/idempotency
- no wakeup for routine progress
- one wakeup for decision and completion
- bounded inspect result
- handoff intervention queues command safely
- slash run/review/status behavior remains available to humans
- old stored drive arguments are handled or rejected clearly

## Done criteria

- [ ] Only three `maestro_*` tools are model-facing.
- [ ] Human slash/dashboard controls remain.
- [ ] Routine progress causes zero LLM turns.
- [ ] Decisions/completion cause exactly one bounded wakeup.
- [ ] Drive infers execute/review mechanically.
- [ ] Handoff uses command context safely.
- [ ] Prompts no longer request polling narration.
- [ ] Focused and full checks pass.

## STOP conditions

- The installed pi API differs from the fully read extension docs for message delivery or command routing.
- Handoff would require calling `newSession()` from a tool/event context.
- Event wakeups cannot be made idempotent across reloads without changing session storage outside existing board/session patterns.
- Removing a tool would remove a human command rather than only model registration.

## Maintenance notes

Tool count is not the only token source; descriptions, schemas, results, and repeated calls also matter. Keep `maestro_drive` compact rather than replacing six names with one enormous undocumented union. Decision records are the stable boundary between deterministic mechanics and model judgment.
