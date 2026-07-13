# Plan 019: Make trusted verification explicit, bounded, and recoverable

> **Executor instructions**: Use normal tools only. Preserve dirty work, branches, and worktrees. Do not invoke Maestro, add dependencies, commit, push, publish, release, or change versions/changelog. Plans 017–018 must be DONE.
>
> **Drift check (run first)**: `git rev-parse --short HEAD && git diff | sha256sum && git diff --stat -- src/config.ts src/runner.ts src/workflow.ts src/worktree.ts src/diagnostics.ts src/settings-ui.ts README.md test/config.test.ts test/runner.test.ts test/workflow.test.ts`
> Planned at `41b6057`, dirty checksum `af3a7b4605d23a5d25baa57deb3f9bf6e47f244b19344958b6a402dcf455d473`.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/017-review-integration-transaction.md`, `plans/018-authoritative-artifact-provenance.md`
- **Category**: security, correctness, dx
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Project `.pi/maestro.json` is repository-controlled, yet verification profiles currently execute with `shell: true` as if automatically trusted. Timeout sends only SIGTERM to the shell, so descendants may survive. Integration verification also deletes the worktree before proving success. Verification must have an explicit trust boundary, reliable process-tree termination, and recovery-first ordering.

## Current state

- `src/runner.ts:25-85` — `runVerification()` spawns a trusted shell command, keeps a bounded tail, and sends one SIGTERM on timeout.
- `src/config.ts` — user and project config both accept executable `verificationProfiles` and `defaultVerificationProfile`.
- `src/workflow.ts:1100-1170` — successful merge removes the worktree before post-integration verification.
- `README.md` currently calls user/project commands trusted without distinguishing repository trust.
- Executor process escalation in `src/runner.ts:300+` is the local pattern for TERM/KILL cleanup.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused | `node --import=tsx --test test/config.test.ts test/runner.test.ts test/workflow.test.ts test/diagnostics.test.ts` | all pass |
| Complete | `pnpm run check` | exit 0 |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**: config, runner verification boundary, workflow ordering, settings/doctor/README, focused tests.

**Out of scope**: OS containers, package-manager sandboxing, arbitrary task commands, CI service integration, dependencies.

## Steps

### Step 1: Establish explicit command trust

Choose and encode the minimal safe policy: executable profile definitions come from user config; project config may select a user-defined profile name but cannot silently introduce a command. If retaining project commands is required for ergonomics, add an explicit persisted user trust record keyed by canonical repository root plus command hash and require human confirmation before first execution. No model tool may approve trust.

**Verify**: tests prove an untrusted project command never spawns, a trusted user profile does, and project selection of a known user profile works.

### Step 2: Validate effective profile provenance

Config loading must retain enough source information to explain where a profile and selector came from. Doctor/settings should show `trusted user profile`, `project-selected`, or `ignored untrusted command` without printing secrets beyond the already visible command config. Preserve explicit zero/unlimited settings.

**Verify**: config precedence and doctor tests pass.

### Step 3: Terminate the complete process tree

On Unix, spawn verification in its own process group and terminate the group. Use staged SIGTERM then SIGKILL with bounded timers. Resolve exactly once on spawn error, abort, timeout, or close; clear listeners/timers in every path. Keep cross-platform behavior explicit and tested without multi-second sleeps.

**Verify**: fake commands that ignore SIGTERM and spawn descendants terminate within a bounded test window; no child remains.

### Step 4: Preserve recovery until proof succeeds

Change integration ordering to: candidate verify → review immutable identity → merge/commit → integrated verify → persist approval → remove worktree/branch. On integrated verification failure, retain recovery state and report the actual integrated commit/state without claiming automatic rollback.

**Verify**: failing post-integration profile leaves task unapproved and recovery checkout/branch present; passing profile cleans it only after persistence.

### Step 5: Document the contract

README must clearly distinguish trusted user configuration, repository selection, timeout/abort behavior, mutation expectations, and recovery semantics. Warn that verification commands are arbitrary local code chosen by the operator.

**Verify**: documentation assertions in `test/config.test.ts` or a focused docs test match defaults and trust semantics.

### Step 6: Full gate

**Verify**: `pnpm run check && git diff --check` exits 0.

## Test plan

- Untrusted project command, trusted user command, profile precedence, unknown selection.
- Spawn error, normal pass/fail, output cap, abort, timeout, ignored SIGTERM, descendant process.
- Candidate verifier mutation (Plan 018 identity must reject it).
- Post-integration fail retains worktree; success cleans after persistence.

## Done criteria

- [x] Repository content cannot silently introduce an executable command.
- [x] Verification always settles within timeout/kill grace.
- [x] Process descendants are terminated.
- [x] Recovery state survives failed integrated verification.
- [x] README and doctor explain effective trust.
- [x] Full checks pass and row is DONE.

## STOP conditions

- Safe process-tree termination requires a new dependency or privileged platform feature.
- Trust approval would need to originate from a model tool context.
- Recovery requires resetting or cleaning the user's integration tree.

## Maintenance notes

All future executable integrations must reuse this trust boundary and process runner; do not create a second shell path.
