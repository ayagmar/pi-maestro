# Plan 024: Make onboarding, operating guidance, and documentation executable truth

> **Executor instructions**: This plan finishes the non-release improvement batch. Use normal tools only. Do not invoke Maestro, add/upgrade dependencies, commit/push/release, publish, change versions, tags, or changelog. All prior plans 017–023 must be DONE.
>
> **Drift check (run first)**: `git rev-parse --short HEAD && git diff | sha256sum && git diff --stat -- README.md package.json scripts test src/config.ts src/diagnostics.ts src/commands.ts`
> Planned at `41b6057`, dirty checksum `af3a7b4605d23a5d25baa57deb3f9bf6e47f244b19344958b6a402dcf455d473`.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/017-review-integration-transaction.md`, `plans/018-authoritative-artifact-provenance.md`, `plans/019-verification-sandbox-and-recovery.md`, `plans/020-pure-core-composition-boundaries.md`, `plans/021-plan-quality-and-execution-contracts.md`, `plans/022-context-and-token-budgeting.md`, `plans/023-durable-run-timeline.md`
- **Category**: dx, docs, tests, tech-debt
- **Planned at**: commit `41b6057`, 2026-07-12

## Why this matters

The README is comprehensive but long, mixes normal flow with rare recovery details, and has already drifted from runtime defaults. New users need a five-minute path, operators need a precise recovery guide, and maintainers need architecture and testing guidance. Documentation should be checked against source rather than manually synchronized prose.

## Current state

- `README.md` is the sole large user document and contains installation, concepts, commands, configuration, lifecycle, recovery, and internals.
- `package.json` provides `check`; CI runs all constituent gates.
- Config defaults are defined in `src/config.ts` and partly duplicated in README tables.
- Commands are centralized in `src/commands.ts`; exactly three model tools remain.
- There is no focused architecture/operations/contributing guide in `docs/`.
- Release metadata/version/changelog are explicitly out of scope.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Docs tests | `node --import=tsx --test test/docs.test.ts test/config.test.ts test/index.test.ts` | all pass |
| Complete twice | `pnpm run check && pnpm run check` | stable test count, exit 0 |
| Hygiene | `git diff --check` | exit 0 |

## Scope

**In scope**: README reorganization, new `docs/architecture.md`, `docs/operations.md`, `docs/configuration.md`, `CONTRIBUTING.md` or `AGENTS.md` if appropriate, source-derived documentation tests/scripts, package scripts only when no dependency/version change is required.

**Out of scope**: release/version/changelog, publication workflow, dependency updates, marketing site, screenshots requiring external services.

## Steps

### Step 1: Define the onboarding information architecture

Restructure README around:

1. What Maestro is and is not.
2. Five-minute install/start/plan/approve/drive path.
3. Exactly three model tools versus human commands.
4. Normal lifecycle and safety guarantees.
5. Links to configuration, operations/recovery, architecture, and contributing.
6. Clear limitations and trust boundaries.

Move detailed recovery matrices and complete configuration reference to docs; do not delete useful behavior documentation.

**Verify**: README headings and links pass docs tests; install and first-run example use actual commands.

### Step 2: Write architecture truth

`docs/architecture.md` should document pure core, board persistence, drive controller, Pi adapters, runner/worktree boundaries, dispatch transaction, artifact identity, verification trust, decision delivery, and why only three model tools exist. Include a compact dependency diagram and ownership table matching boundary tests.

**Verify**: referenced files/symbols exist; boundary documentation test checks key ownership statements.

### Step 3: Write operations and recovery truth

`docs/operations.md` should provide state-based procedures for plan gate, provider block, attempt cap, repeated review rejection, stall, conflict, candidate verification failure, integrated verification failure, pause/resume/abort, stale claim, orphan worktree, manual acceptance, and reconciliation. Each procedure must say what is preserved and which human command is safe.

**Verify**: every durable stop code and failure kind from source appears in operations docs.

### Step 4: Generate or assert configuration reference

Avoid duplicating defaults by adding a source-derived Markdown table generator used in check mode, or a test that extracts documented defaults and compares them to `DEFAULT_CONFIG`/presets. Include trust source, range, zero/off semantics, and profile behavior. Do not rewrite user config.

**Verify**: intentionally changing a fixture default makes the docs test fail; current docs pass.

### Step 5: Add contributor and agent guidance

Document repository layout, readability rules, boundary ownership, exact focused/full commands, behavioral-test expectations, dirty-tree preservation, no empty-path commit semantics, and how to add a config key/persisted field/stop reason safely. Reference exemplar tests.

**Verify**: all named scripts/files exist and commands are correct.

### Step 6: Add installed-shape smoke validation without release work

Create a temporary packed/copy fixture or file-list test that verifies the declared package files include every runtime module and documentation required by installation. Do not publish, bump version, or create a tarball in the working tree. Keep the existing source smoke test.

**Verify**: test fails when a required runtime module is omitted from package files and passes in the live tree.

### Step 7: Final program gate

Run the full suite twice, compare test counts, verify exact tools, no placeholder tests, docs links, and patch hygiene. Update all plan statuses.

**Verify**:

```bash
pnpm run check
pnpm run check
rg -o 'name: "maestro_[a-z_]+"' src -g'*.ts' | sort -u
git diff --check
```

Expected tools are exactly `maestro_plan`, `maestro_update`, and `maestro_drive`; checks pass with stable count.

## Test plan

- README links/headings and command names.
- Source stop codes/failure kinds represented in operations docs.
- Config defaults/preset table match runtime.
- Architecture boundary ownership matches import guard.
- Package installed-shape contains all runtime imports.
- Full suite twice with stable count.

## Done criteria

- [ ] A new user can reach a first approved task from the README without reading recovery internals.
- [ ] Architecture, operations, configuration, and contribution docs match runtime.
- [ ] Defaults and command/status enums are checked automatically.
- [ ] Installed package shape is smoke-tested without publication.
- [ ] Exactly three model tools remain and human controls remain.
- [ ] Full suite passes twice; all 017–024 rows are DONE.

## STOP conditions

- Documentation truth requires changing runtime behavior; STOP and fix the owning earlier plan instead.
- Installed-shape testing would require publishing, versioning, or dependency changes.
- A generated-doc approach makes prose harder to maintain than a small assertion test.

## Maintenance notes

Every new config key, stop reason, failure kind, model tool, or command must update source-derived docs checks in the same change.
