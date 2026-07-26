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

### Test layers

- **Behavioral suites** cover policy and orchestration with fake executors. They are fast and hold
  most of the coverage. Use `test/helpers/executors.ts` rather than hand-rolling a fake:
  `settlingExecutor` for runs that should just finish, `heldExecutors` for asserting behavior while
  a run is still live.
- **`test/executor-integration.test.ts`** drives real `pi --mode rpc` subprocesses against a local
  scripted model server (`test/helpers/stub-model-server.ts`). It covers the RPC transport, session
  writing, Git attribution, and process teardown that fake executors cannot reach — with no provider
  account, no tokens, and no outbound network. Reach for this layer when a bug involves the executor
  process, Git, or the filesystem rather than a scheduling decision; several production bugs lived
  precisely in that gap while every fake-executor suite stayed green.
- **`test/boundaries.test.ts`** asserts capability boundaries only: which modules may spawn
  processes or execute Git, and the published package shape. It deliberately does not assert where
  ordinary functions live — those checks pass on completely broken code (gutting a function while
  keeping its name left them all green) and only tax refactors.

Preserve dirty trees, stashes, checkpoint branches, logs, and archives. Maestro task checkouts are ephemeral: checkpoint recoverable task edits before parking an idle checkout, and restore it only for active work. Never make an empty path list stage or commit all dirty files.

## Extending contracts safely

- Config key: update `MaestroConfig`, defaults, merge/validation, settings/doctor, `docs/configuration.md`, and config tests.
- Persisted field: keep legacy boards loadable, update board validation, and add round-trip/corrupt-board tests.
- Stop or failure kind: update types, decisions, formatting, `docs/operations.md`, and behavioral routing tests.
- Tool: the model-facing API is intentionally fixed at three. Add operational behavior to human commands/dashboard or an existing tool action instead.

Do not publish, tag, bump versions, or edit release notes as part of ordinary code changes.
