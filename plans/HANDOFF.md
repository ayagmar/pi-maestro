# Maestro drive handoff prompt

Start a fresh pi session in this repository and run `/maestro start`, followed by the prompt below. This is one program: create the full board first, then drive it through every phase. “Plan 001 first” means dependency order, not stopping after Plan 001.

```text
Execute the complete reliability program defined in plans/README.md and plans/001 through plans/007. This is one end-to-end Maestro program. Do not stop after Plan 001 or after any intermediate plan. Create the complete dependency-aware board up front, call maestro_drive, and continue supervising, resolving decisions, reviewing, and driving until all seven plans are integrated and verified or a genuine STOP condition from a plan makes continuation unsafe.

First read completely:

- applicable AGENTS.md instructions
- plans/README.md
- plans/001-recover-trustworthy-baseline.md
- plans/002-transactional-task-execution.md
- plans/003-consolidate-event-driven-drive.md
- plans/004-stall-watchdog-failure-routing.md
- plans/005-bounded-review-findings.md
- plans/006-conflict-aware-scheduling.md
- plans/007-token-controls-reconciliation-docs.md

Planning rules:

1. Translate the plans into small, independently reviewable Maestro tasks. Do not create one giant task per plan when a plan has separable implementation and test surfaces.
2. Preserve this dependency graph:
   - Plan 001 before all source feature work.
   - Plan 002 after Plan 001.
   - Plan 003 after Plan 002.
   - Plan 004 after Plan 003.
   - Plan 005 after Plan 002; it may run independently of Plans 003–004 when file scopes do not overlap.
   - Plan 006 after Plans 002 and 005.
   - Plan 007 after Plans 003, 004, 005, and 006.
3. Chain every pair of tasks that may edit the same file, even when their logical plans could otherwise run in parallel.
4. Each task brief must reference the exact plan file and exact step(s), include file scope, constraints, acceptance criteria, and focused verification.
5. Every task needs a conventional commit message.
6. Do not paste whole plan files into briefs. Reference their paths and restate only the task-specific requirements needed by the fresh executor.
7. Create the entire board before starting drive so I can see the complete program and so dependencies are explicit.

Critical starting state:

- Baseline commit is 41b6057.
- README.md, src/index.ts, src/prompts.ts, and test/index.test.ts contain a mixed uncommitted patch.
- The first recovery task must preserve that patch as required by Plan 001 before changing it.
- Do not use git reset --hard, blanket checkout, or destructive cleanup.
- Separate intended capped-task successor guidance from accidental removal of dispatch recovery, revision-checked replacement, retention/log-cap wiring, and handoff/lease regression tests.
- Do not trust .pi/maestro/board.json approvals as proof that features exist. Verify source, tests, Git artifacts, and integration state.

Self-hosting safety:

- Executors must not recursively call Maestro.
- Use worktree isolation for every parallel batch available under the current implementation.
- Until Plan 002’s always-isolate behavior has been integrated, never intentionally schedule overlapping write scopes in the same batch.
- Failed, canceled, rejected, cost-capped, or aborted work must not be manually copied into the main tree.
- After changes to Maestro’s own runtime behavior, continue using the board’s persisted state and verify the live source before subsequent recovery decisions. If the loaded extension runtime is demonstrably stale and requires reload before it can safely continue, stop once with an explicit reload instruction rather than improvising or discarding work.

Program invariants:

- No new dependencies.
- No release, version, tag, changelog, publication, or package-metadata work.
- Do not delete stashes, logs, worktrees, archives, or user changes without confirmation.
- Keep code simple and readable; avoid speculative abstractions.
- Final model-facing tool surface: maestro_plan, maestro_update, maestro_drive only.
- Preserve human slash commands and dashboard controls.
- Routine progress must be mechanical and token-free; wake the orchestrator only for decisions or completion.
- Every attempt must be isolated and Git-attributed after Plan 002.
- Automated approval must identify a reviewed, integrated, verified artifact.
- Manual acceptance must be visibly distinct.
- Never make verification green by deleting or weakening tests.

Pi documentation requirement:

Before implementing extension/session behavior, read the installed documentation completely:
$HOME/.fnm/node-versions/v24.12.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md

Follow its linked session, TUI, and RPC documentation when relevant. Respect ExtensionContext versus ExtensionCommandContext and session-replacement lifecycle rules.

Drive behavior:

- After creating the complete board, call maestro_drive once.
- While the current implementation still requires status pulses, use them only at the configured cadence and keep narration minimal.
- At review rejection, use the exact findings; do not broaden scope.
- At repeated same-cause failure, split/rewrite/reroute instead of raising maxAttempts.
- At provider block, switch to a configured different provider or stop for a real quota decision; do not hot-loop.
- At an attempt cap, create the narrowly scoped successor described by the plans, rewire dependents, and continue the scoped drive.
- Do not ask me to say “continue” between successful plans. Continue automatically through the dependency graph.
- Only stop for a plan STOP condition, unsafe stale runtime requiring reload, unavailable provider/cost decision, destructive action needing confirmation, or irreconcilable verification failure.

Verification discipline:

- Run focused tests after each task as specified by its plan step.
- Run pnpm run check and git diff --check before marking each plan DONE.
- Preserve or increase meaningful regression coverage and track test count when tests change.
- If the same verification fails twice for the same cause, stop that task and let the orchestrator change the approach; do not churn.
- Plan 007 must run the final complete gate twice with stable test count.

Completion criteria:

All seven plan rows in plans/README.md are DONE; all approved task artifacts are integrated; the final tool registration list is exactly maestro_plan, maestro_update, maestro_drive; pnpm run check passes twice; git diff --check passes; README matches tested behavior; and no dependency/release/metadata work occurred.

Final report:

- plans and tasks completed, with deviations
- files changed grouped by subsystem
- focused and full verification results with final test count
- final registered Maestro tools
- remaining risks or deferred work
- confirmation that no dependency, release, version, tag, changelog, publication, or package-metadata work occurred

Now investigate only enough to produce the full board, create all tasks with dependencies, and start maestro_drive. Continue through the entire program without waiting for me between plans.
```
