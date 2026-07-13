# Plan 013: Validate configuration inputs and make documentation executable truth

> **Executor instructions**: Add no dependency. Preserve invalid files for diagnosis; do not silently rewrite user configuration.
>
> **Drift check**: `git diff --stat -- src/config.ts src/types.ts src/settings-ui.ts src/diagnostics.ts README.md test/config.test.ts test/settings-ui.test.ts test/diagnostics.test.ts`
> Planned at `41b6057`; dirty-diff checksum `5d86f382a96852fbe76fffc44b0afff54e4e8f78e91fcbede7e0c850b8bb0275`.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/011-artifact-contract-gates.md`, `plans/012-real-progress-watchdog.md`
- **Category**: bug, dx, docs
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

Config files are parsed and cast without structural validation, allowing invalid values to fail later in unrelated orchestration paths. README defaults already disagree with runtime cost caps and worktree behavior. One dependency-free validator plus tested documentation closes both gaps.

## Current state

- `src/config.ts:282-296` casts JSON to `Partial<MaestroConfig>`.
- Invalid JSON is archived, but structurally invalid valid JSON is accepted.
- `README.md:193-204` says run caps are off although presets use `$25`.
- `README.md:240-243` contradicts itself about one-task worktrees.
- `README.md:257` says task cost default is zero although source uses five.

## Scope

**In scope**: listed files.

**Out of scope**: dependency upgrades, schema libraries, automatic migration/writes, release docs.

## Steps

### Step 1: Validate every accepted field

Implement readable type guards/range checks for booleans, finite bounded numbers, log enum, handoff ratio, watchdog values, cleanup flag, tier model/fallback/thinking/tools shape, and unknown/empty tier names. Partial files remain valid. Return file-scoped diagnostics.

### Step 2: Preserve invalid files safely

Use the existing corrupt-file preservation convention for structurally invalid files, with a distinguishable suffix/reason. Fall back by precedence without overwriting explicit valid lower-scope values. Never include secrets in diagnostics.

### Step 3: Surface diagnostics

`describeConfig`, settings UI, and doctor show effective values and identify ignored invalid scope files. Preserve explicit zero/unlimited values.

### Step 4: Reconcile README

Update tool contract, worktree behavior, all preset cost tables, cleanup semantics, watchdog keys, handoff, logs, and human-only commands. Add tests that extract key documented defaults or centralize a generated default table so drift fails CI.

### Step 5: Verify

Test malformed types, NaN-equivalent strings, negative/huge values, bad enums, invalid tiers/fallbacks, valid partial overrides, explicit zeros, and precedence.

## Done criteria

- [ ] Arbitrary parsed JSON is never cast directly to config.
- [ ] Invalid scope files are preserved and ignored with actionable diagnostics.
- [ ] Explicit valid user values survive project/default merges.
- [ ] README defaults match source and are regression-tested.
- [ ] Full gate and `git diff --check` pass.

## STOP conditions

- Validation would reject a documented currently supported configuration.
- A migration would overwrite an explicit user file.
- Fix requires a new schema dependency.

## Maintenance notes

Every new config key must update the validator, merge logic, description, settings/doctor surface where applicable, and one default-doc assertion.