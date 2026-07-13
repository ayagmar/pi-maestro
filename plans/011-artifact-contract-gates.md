# Plan 011: Make write scope, deterministic gates, and approval provenance truthful

> **Executor instructions**: Implement the smallest coherent artifact contract. Do not add planning metadata beyond `writePaths`, and do not weaken tests to accept unsafe artifacts.
>
> **Drift check**: `git diff --stat -- src/types.ts src/board.ts src/index.ts src/workflow.ts src/worktree.ts src/prompts.ts test/board.test.ts test/index.test.ts test/workflow.test.ts test/worktree.test.ts test/prompts.test.ts`
> Planned at `41b6057`; dirty-diff checksum `5d86f382a96852fbe76fffc44b0afff54e4e8f78e91fcbede7e0c850b8bb0275`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/008-dispatch-lifecycle-transaction.md`, `plans/009-restore-three-tool-regressions.md`
- **Category**: correctness, tests
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

`writePaths` is optional for newly planned tasks, so overlap and actual-scope enforcement can be bypassed. Pre-review gates cover only a narrow deleted-test heuristic and scope mismatch. Approval provenance can record the current unrelated `HEAD` as an integrated commit when work remains dirty or commit fails.

## Current state

- `src/index.ts:510,694` makes `writePaths` optional.
- `src/workflow.ts:850-888` implements ad hoc deletion/scope checks.
- `src/workflow.ts:1041-1050` always sets reviewed provenance and attempts to record `headCommit(cwd)`.
- `src/worktree.ts:100-150` owns authoritative Git path/diff/commit operations.
- Legacy boards must remain loadable with absent write scopes.

## Scope

**In scope**: listed files.

**Out of scope**: `readPaths`, risk matrices, arbitrary globs, semantic AI gates, new dependencies.

## Steps

### Step 1: Require bounded write scopes for new work

Keep `Task.writePaths` optional only in persisted legacy boards. Require it in `maestro_plan`; allow `[]` only when the brief explicitly identifies investigation/no-file work. `maestro_update` can migrate legacy tasks. Normalize exact files and one simple `directory/**` form.

### Step 2: Centralize deterministic artifact validation

Create one pure gate returning bounded structured findings. Reuse it before review. Check:

- actual Git paths are attributable and within scope;
- expected code work has a non-empty diff;
- existing tests are not deleted unless explicitly required;
- test discovery/config is not narrowed;
- no conflict markers exist;
- required trusted verification result is present (Plan 014 will formalize profiles; preserve an extension point without abstraction bloat).

Do not infer safety from tool telemetry.

### Step 3: Correct approval states

Define truthful outcomes:

- `reviewed` means reviewer approved a specific patch hash;
- `integratedCommit` exists only when that reviewed patch is proven contained in the recorded commit;
- reviewed but intentionally uncommitted main-tree work remains visibly unintegrated and must not masquerade as committed;
- manual acceptance remains `approvalKind: "manual"`;
- merge/commit/verification failure never transitions to approved integrated state.

Update `/maestro reconcile` to report each mismatch.

### Step 4: Preserve failed artifacts

Gate failures must not merge. Retain recoverable worktree metadata and merge findings by stable fingerprint. Repeated identical gate failures stop at the existing decision policy.

### Step 5: Tests and docs

Add fixtures for missing scope, empty diff, Bash-created out-of-scope file, top-level `*.test.ts` deletion, test-config narrowing, conflict markers, dirty main-tree approval, failed commit hook, reviewed worktree merge, and manual acceptance.

## Done criteria

- [ ] New model-planned tasks cannot omit write scope.
- [ ] One deterministic gate implementation covers all mechanical checks.
- [ ] No-diff/test-weakening/scope failures launch zero reviewers.
- [ ] Integrated commit provenance is cryptographically/structurally tied to the reviewed patch.
- [ ] Legacy boards remain loadable.
- [ ] Focused/full checks pass.

## STOP conditions

- Required verification would execute arbitrary model-provided commands.
- Backward compatibility requires rewriting existing boards automatically.
- Git attribution cannot be established without touching a dirty user tree.

## Maintenance notes

Keep gates deterministic and explainable. New gate kinds should reuse the bounded finding shape rather than adding parallel note fields.