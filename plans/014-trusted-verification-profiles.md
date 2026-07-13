# Plan 014: Add trusted verification profiles and post-integration proof

> **Executor instructions**: Verification commands must come only from trusted user/project configuration, never task/model text. Keep the first version small: named profiles, bounded output, timeout, and explicit result metadata.
>
> **Drift check**: `git diff --stat -- src/types.ts src/config.ts src/runner.ts src/workflow.ts src/format.ts src/diagnostics.ts src/settings-ui.ts test/config.test.ts test/runner.test.ts test/workflow.test.ts test/format.test.ts README.md`
> Planned at `41b6057`; dirty-diff checksum `5d86f382a96852fbe76fffc44b0afff54e4e8f78e91fcbede7e0c850b8bb0275`.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/011-artifact-contract-gates.md`, `plans/013-config-validation-doc-truth.md`
- **Category**: direction, correctness
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Approval provenance cannot mean verified integration while verification exists only as prose in a task brief. Trusted named profiles make deterministic gates and post-merge proof real without executing arbitrary model-authored commands.

## Current state

- Tasks include prose verification commands but no trusted executable contract.
- Workflow can capture patches and integrate worktrees.
- Runner owns child processes; boundary tests require other modules not to spawn.
- Output must remain bounded and full logs referenced by path.

## Scope

**In scope**: listed files and tests.

**Out of scope**: arbitrary shell from model parameters, CI service integrations, matrix DSL, containers, new dependencies.

## Steps

### Step 1: Define minimal trusted profiles

Add optional config `verificationProfiles` mapping names to `{ command, timeoutSeconds }` and a default profile selector. Commands are trusted because config is user/project controlled. Validate names, command length, finite timeout, and profile count in Plan 013's validator.

### Step 2: Select profiles without bloating task schema

Add one optional task `verificationProfile` string. New tasks default to configured project default; model may choose only among names exposed in planning guidance. Reject unknown names before dispatch.

### Step 3: Execute through the process boundary

Add a runner-owned verification function with timeout, abort, bounded tail, duration, exit code, and artifact log path. Do not use shell interpolation when a safely tokenized representation is feasible; if shell commands are retained for project ergonomics, clearly treat config as trusted and never combine task input into it.

### Step 4: Gate review and integration

Run the task profile on the final candidate before reviewer and after integration. A failure creates a deterministic finding and cannot approve. Store a bounded verification reference/summary and tie it to the reviewed patch/integrated commit.

### Step 5: Tests and docs

Cover pass, failure, timeout, abort, large output, unknown profile, profile precedence, worktree cwd, post-merge failure, and no configured profile. Document trust boundary prominently.

## Done criteria

- [ ] No model-authored command is executed.
- [ ] Verification output and time are bounded.
- [ ] Reviewed approval includes successful final candidate and post-integration verification proof when configured.
- [ ] Failures avoid reviewer spend and prevent approval.
- [ ] Boundary and full tests pass.

## STOP conditions

- Secure command execution requires a runtime dependency.
- Post-integration verification would mutate or clean the user's dirty tree.
- Existing boundary tests would require allowing child-process use outside runner.

## Maintenance notes

Resist adding a workflow language. Named command+timeout profiles cover the proven need; CI adapters can consume the same result later.