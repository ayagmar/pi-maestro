# Plan 018: Identify, review, verify, and integrate one authoritative Git artifact

> **Executor instructions**: Preserve all dirty user work and recoverable worktrees. Use normal tools only; do not invoke Maestro, commit, push, release, add dependencies, or update versions/changelog. Read Plan 017 and confirm it is DONE. Update the index when complete.
>
> **Drift check (run first)**: `git rev-parse --short HEAD && git diff | sha256sum && git diff --stat -- src/workflow.ts src/worktree.ts src/types.ts src/board.ts src/prompts.ts test/workflow.test.ts test/worktree.test.ts test/prompts.test.ts`
> Baseline commit `41b6057`, dirty checksum `af3a7b4605d23a5d25baa57deb3f9bf6e47f244b19344958b6a402dcf455d473`. STOP if Plan 017 is incomplete or artifact fields changed without updated tests.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/017-review-integration-transaction.md`
- **Category**: correctness, security, tests
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

`reviewedPatchHash` currently hashes a bounded presentation diff. Git diff output omits untracked file contents and is truncated for model context; trusted verification may also mutate files after capture. Approval must point to one complete immutable Git artifact, while bounded diffs remain presentation only.

## Current state

- `src/worktree.ts:100-135` — `changedPaths()` sees untracked files, but `captureDiff()` uses `git diff` and truncates to `MAX_INJECTED_CONTEXT_LENGTH`.
- `src/workflow.ts:1180-1210` — approval hashes `attempt.diff` and separately records `HEAD`.
- `src/workflow.ts:920-980` — candidate verification can run before review without proving it left the artifact unchanged.
- `src/types.ts:120-126` — task stores `reviewedPatchHash`, `integratedCommit`, and text verification summary.
- Boundary convention: Git commands remain exclusively in `src/worktree.ts`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import=tsx --test test/worktree.test.ts test/workflow.test.ts test/prompts.test.ts` | all pass |
| Boundaries | `node --import=tsx --test test/boundaries.test.ts` | all pass |
| Complete | `pnpm run check` | exit 0 |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**: `src/worktree.ts`, `src/workflow.ts`, `src/types.ts`, `src/board.ts`, `src/prompts.ts`, focused tests.

**Out of scope**: release packaging, generic content-addressed storage, databases, changing model tool count, executing model-authored commands.

## Steps

### Step 1: Define the authoritative identity

Use Git's object model rather than a custom full-file hash. Add a worktree-owned operation that snapshots exactly the candidate task paths, including untracked files, into an immutable tree or commit without modifying the integration tree. Return a stable identity and a separately bounded display diff. Do not make an empty path list stage all files.

For legacy main-tree execution, either create an isolated temporary index/tree safely or mark the artifact visibly unintegrated; never stage unrelated dirty files. Prefer worktrees for automated reviewed approval if complete identity cannot be established safely in a dirty main tree.

**Verify**: focused tests prove identical content gives identical identity and untracked content changes alter it.

### Step 2: Bind review to the identity

Persist candidate identity before reviewer launch. Include the identity in the review prompt and require the workflow to re-read it after candidate verification and reviewer completion. If files changed, reject with a deterministic `artifact-changed` finding and do not integrate.

**Verify**: verifier mutation and reviewer-time mutation tests launch no merge and persist `changes_requested`.

### Step 3: Bind integration and verification

After merge/commit, prove the reviewed tree is contained by the recorded integrated commit. Store structured provenance sufficient for reconciliation: candidate identity, integrated commit, verification profile/result reference, and timestamps. Keep legacy optional fields loadable.

**Verify**: worktree approval test proves reviewed identity is contained in integrated commit; unrelated dirty main-tree files are excluded.

### Step 4: Correct reconciliation and presentation

Update `/maestro reconcile`, dashboard details, and README terminology so “reviewed,” “integrated,” and “verified” are separate facts. Bounded diffs must never be described as the authority.

**Verify**: focused index/dashboard tests pass; README examples match field semantics.

### Step 5: Full gate

**Verify**: `pnpm run check && git diff --check` exits 0.

## Test plan

- New untracked file identity and changed content.
- Staged, unstaged, renamed, deleted, and binary paths.
- Empty `writePaths` does not stage all dirty files.
- Candidate verification mutation invalidates review.
- Dirty unrelated main-tree work cannot enter identity or commit.
- Reviewed worktree tree is contained in integrated commit.
- Legacy board without provenance fields still loads.

## Done criteria

- [x] Approval identity covers complete task content, including untracked files.
- [x] Bounded presentation data is never used as artifact authority.
- [x] Candidate mutation invalidates review/integration.
- [x] Integrated commit is structurally tied to reviewed identity.
- [x] Reconciliation reports each missing proof distinctly.
- [x] Full checks pass and row is DONE.

## STOP conditions

- Establishing identity would stage, reset, clean, or rewrite unrelated user work.
- The solution requires a non-Git database or new dependency.
- Main-tree identity cannot be made safe; STOP and recommend requiring worktrees for automated approval rather than improvising.

## Maintenance notes

Future verification, CI, and export features must refer to the authoritative Git identity, not reports or truncated diffs.
