# Plan 006: Prevent overlapping tasks and recover integration conflicts narrowly

> **Executor instructions**: Execute normally. Reuse transactional worktrees from Plan 002 and finding format from Plan 005. Do not introduce a run-level integration worktree in this plan. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 41b6057..HEAD -- src/types.ts src/board.ts src/index.ts src/workflow.ts src/worktree.ts src/prompts.ts test/board.test.ts test/index.test.ts test/workflow.test.ts test/worktree.test.ts test/prompts.test.ts README.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-transactional-task-execution.md`, `plans/005-bounded-review-findings.md`
- **Category**: correctness, architecture
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Current conflict prevention is only a prompt instruction telling the planner to chain tasks touching the same files. Worktrees prevent immediate corruption but independent overlapping tasks still conflict during integration. The scheduler needs one small structured signal—expected write paths—and focused recovery when reality differs.

## Current state

- Tasks contain title, brief, tier, dependencies, attempts, and optional commit/review metadata.
- `maestro_plan` accepts free-form briefs and dependencies but no write set.
- Plan validation checks references, cycles, and tiers.
- Worktree merges are serialized and preserve recoverable state after conflicts.
- Reviewer merge conflicts do not count as reviewer rejections.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Focused | `node --import=tsx --test test/board.test.ts test/index.test.ts test/workflow.test.ts test/worktree.test.ts test/prompts.test.ts` | all pass |
| Full | `pnpm run check` | exit 0 |

## Scope

**In scope**:
- files listed in drift check

**Out of scope**:
- `readPaths`, risk scores, ownership databases
- run-level integration worktree
- automatic semantic conflict resolution without review
- new dependencies

## Steps

### Step 1: Add required bounded `writePaths` for new tasks

Add normalized repository-relative `writePaths` to Task. Keep it optional when reading legacy boards, but require it for newly model-planned code-changing tasks. Allow an explicit empty list for documentation/no-file or investigation-only tasks only when the brief explains it.

Validation rules:

- no absolute paths
- no `..` traversal
- normalize separators and leading `./`
- bounded count and string length
- support exact files first; allow simple directory suffix `/**` only if needed

Update `maestro_plan`/`maestro_update` schemas without adding other planning metadata.

**Verify**: board/schema tests cover normalization, invalid paths, legacy absence, and bounds.

### Step 2: Detect independent overlaps during plan validation

Two unresolved tasks overlap when their normalized write sets intersect and neither transitively depends on the other. Exact-file intersections must be detected; directory globs must conservatively overlap descendants.

Plan validation should return an actionable error naming both tasks and paths, instructing the planner to add a dependency or narrow scope. Do not silently invent dependencies unless the order is unambiguous and explicitly tested; rejection is safer.

**Verify**: tests cover direct overlap, transitive ordering, disjoint paths, directory overlap, canceled/settled tasks, and normalized variants.

### Step 3: Enforce actual scope after execution

Compare Plan 002’s Git-derived actual changed paths with declared `writePaths`. If actual changes leave scope:

- do not launch reviewer
- do not merge
- create a deterministic open finding
- preserve worktree
- stop unchanged repeated scope violations through Plan 004 fingerprinting

Allow explicitly generated companion files only if they were declared; do not add fallback guesses.

**Verify**: out-of-scope Bash edit is rejected mechanically.

### Step 4: Refresh task branch from latest integration state before final review

Before LLM review, update the task worktree with the latest main/integration HEAD using existing serialized Git operations. If update is clean:

- recalculate patch and changed paths
- rerun relevant verification
- review the final rebased/integrated candidate

This avoids approving a patch that later changes under merge.

Do not mutate the user’s dirty main tree; Plan 002’s clean integration preconditions apply.

**Verify**: task started on old HEAD receives an intervening approved change, updates cleanly, and reviewer sees the final patch.

### Step 5: Create focused internal conflict repair

When branch refresh conflicts:

- abort the partial merge/rebase safely
- persist conflict path set and fingerprint
- launch an internal executor only when policy permits, using the existing executor mechanism but no new model tool
- prompt it with conflicting files, both relevant task reports/findings, and acceptance criteria
- prohibit unrelated files
- rerun affected verification
- send the resolution through normal review

If the same conflict fingerprint recurs, stop at a drive decision instead of relaunching.

**Verify**: conflict fixture launches one focused repair, constrains paths, and stops on repeated identical conflict.

### Step 6: Update planning guidance and human UI

Briefings should require realistic write paths and say overlap is enforced. Board/dashboard details should show write paths compactly only when useful; do not crowd the default task list.

README should explain that dependencies serialize overlapping write scopes and actual out-of-scope changes are rejected before review.

**Verify**: prompt tests and width-safe dashboard tests pass.

### Step 7: Full verification

```bash
node --import=tsx --test test/board.test.ts test/index.test.ts test/workflow.test.ts test/worktree.test.ts test/prompts.test.ts
pnpm run check
git diff --check
```

## Test plan

Cover:

- path normalization and traversal rejection
- exact and directory overlap
- transitive dependency resolves overlap
- legacy task remains loadable
- new planned task requires write paths
- actual Bash edit outside scope blocks review/merge
- branch refresh before review
- clean refresh recalculates patch
- focused conflict repair sees bounded context and conflict paths
- repeated conflict fingerprint stops
- human dashboard remains compact

## Done criteria

- [ ] New tasks carry bounded write paths.
- [ ] Independent overlap blocks plan approval/drive.
- [ ] Actual scope is checked from Git before review.
- [ ] Task branch is refreshed before final review.
- [ ] Conflict repair is internal, focused, and reviewed.
- [ ] Repeated identical conflict stops.
- [ ] No new model-facing tools.
- [ ] Focused/full checks pass.

## STOP conditions

- Write-path enforcement would require broad unrestricted globs to support normal tasks.
- Branch refresh cannot be performed without touching a dirty user working tree.
- Conflict repair requires exposing full unrelated dependency transcripts.
- Plan 002 did not establish authoritative Git-derived changed paths.

## Maintenance notes

Start with exact paths and conservative behavior. Do not turn write scopes into a complex ownership language. If users consistently need broader patterns, add them from measured cases with tests.
