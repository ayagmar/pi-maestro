# Contributing

## Repository layout

- `src/board.ts`: persisted board boundary
- `src/workflow.ts`: execution/review orchestration
- `src/artifact-policy.ts`: pure artifact checks
- `src/drive-controller.ts`: drive ownership and decisions
- `src/runner.ts`: child processes and verification
- `src/worktree.ts`: all Git operations
- `src/index.ts`: minimal extension entry point
- `src/extension.ts`: Pi dependency and UI composition
- `src/extension-lifecycle.ts`: Pi session lifecycle and reload recovery
- `src/tools.ts`: the three model tool adapters
- `src/commands.ts`: human slash-command registration
- `src/command-dispatcher.ts`: human command routing to cohesive command families
- `test/boundaries.test.ts`: enforced architecture ownership

Keep code readable and local. Prefer early returns and the smallest correct implementation. Do not add fallback paths or abstractions without a proven caller.

## Verification

Run focused behavioral tests while changing code, then:

```bash
pnpm run check
pnpm run check
git diff --check
```

The two full checks must report the same test count. Also run `pnpm run typecheck`, `pnpm test`,
`pnpm run lint`, and `pnpm run format:check` explicitly when producing final verification evidence.

Bug fixes should add a behavioral regression test. Registration assertions do not replace behavior tests. Never delete or narrow tests to make a gate pass.

Preserve dirty trees, stashes, branches, logs, archives, and recovery worktrees. Never make an empty path list stage or commit all dirty files.

## Extending contracts safely

- Config key: update `MaestroConfig`, defaults, merge/validation, settings/doctor, `docs/configuration.md`, and config tests.
- Persisted field: keep legacy boards loadable, update board validation, and add round-trip/corrupt-board tests.
- Stop or failure kind: update types, decisions, formatting, `docs/operations.md`, and behavioral routing tests.
- Tool: the model-facing API is intentionally fixed at three. Add operational behavior to human commands/dashboard or an existing tool action instead.

Do not publish, tag, bump versions, or edit release notes as part of ordinary code changes.
