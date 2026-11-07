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
- `src/pages/`, `src/layouts/`, `src/styles/`, `src/data/`: the documentation site (not part of the extension or the npm package)
- `docs/`: the user documentation, rendered by the site
- `test/boundaries.test.ts`: enforced architecture ownership

[Architecture](docs/architecture.md) describes who owns what and the invariants the runtime keeps.

Keep code readable and local. Prefer early returns and the smallest correct implementation. Do not add fallback paths or abstractions without a proven caller.

## Verification

Run focused behavioral tests while changing code, then:

```bash
pnpm install
pnpm run check    # typecheck, lint, format check, unit and integration tests, pi CLI smoke test
git diff --check
```

`pnpm run check` is what CI and the release workflow run. Try the extension against a real pi with `pi -e ./src/index.ts`. Node.js 22.19 or newer is required.

Bug fixes should add a behavioral regression test. Registration assertions do not replace behavior tests. Never delete or narrow tests to make a gate pass.

### Test layers

- **Behavioral suites** cover policy and orchestration with fake executors. They are fast and hold
  most of the coverage. Use `test/helpers/executors.ts` rather than hand-rolling a fake:
  `settlingExecutor` for runs that should just finish, `heldExecutors` for asserting behavior while
  a run is still live.
- **`test/integration/executor.test.ts`** (run by `pnpm run test:integration`, part of
  `pnpm run check`) drives real `pi --mode rpc` subprocesses against a local
  scripted model server (`test/helpers/stub-model-server.ts`). It covers the RPC transport, session
  writing, Git attribution, and process teardown that fake executors cannot reach, with no provider
  account, no tokens, and no outbound network. Reach for this layer when a bug involves the executor
  process, Git, or the filesystem rather than a scheduling decision; several production bugs lived
  precisely in that gap while every fake-executor suite stayed green.
- **`test/boundaries.test.ts`** asserts capability boundaries only: which modules may spawn
  processes or execute Git, the three-tool model surface in source, and that the only runtime dependency is
  `@earendil-works/pi-schema` and that no framework directories ship. It deliberately does not assert where
  ordinary functions live. Those checks pass on completely broken code (gutting a function while
  keeping its name left them all green) and only tax refactors.
- **`test/package.test.ts`** checks the packed tarball: it ships the runtime and public docs but no
  docs-site, test, or tooling files, and the manifest entry registers exactly the three model tools.

Preserve dirty trees, stashes, checkpoint branches, logs, and archives. Maestro task checkouts are ephemeral: checkpoint recoverable task edits before parking an idle checkout, and restore it only for active work. Never make an empty path list stage or commit all dirty files.

## Extending contracts safely

- Config key: update `MaestroConfig`, defaults, merge/validation, settings/doctor, `docs/configuration.md`, and config tests.
- Persisted field: keep legacy boards loadable, update board validation, and add round-trip/corrupt-board tests.
- Stop or failure kind: update types, decisions, formatting, `docs/operations.md`, and behavioral routing tests.
- Tool: the model-facing API is intentionally fixed at three. Add operational behavior to human commands/dashboard or an existing tool action instead.

## Documentation and the site

User documentation lives in `docs/` and the root `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, and `CHANGELOG.md`. The site renders those files directly, so editing a page means editing its markdown file. `src/data/docs.ts` only lists the pages and their navigation metadata, and links between files stay relative (`configuration.md#budgets-and-caps`) so they work on GitHub and on the site. Update the docs in the same change as the behavior:

- a config key: `docs/configuration.md` (a test checks the defaults table)
- a command: `docs/commands.md`
- a stop or failure kind: `docs/operations.md`

Preview the site with `pnpm run dev` and build it with `pnpm run build`; `pnpm run site:check` then checks that every internal link in `dist/` resolves under the `/pi-maestro/` base path. Internal links in `.astro` files go through `url()` from `src/data/site.mjs`. The Pages workflow deploys `master` to <https://ayagmar.github.io/pi-maestro/>. The README's install command, the getting-started page, and the landing page must show the same command; a test checks it.

## Releasing

Releases are cut from GitHub Actions, never from a laptop. Do not publish, tag, bump versions, or edit generated release notes as part of ordinary code changes.

1. Merge Conventional Commits (`feat:`, `fix:`, `feat!:`) into `master`.
2. Run **Actions, Release, Run workflow**, or `gh workflow run release.yml -f increment=auto`. `auto` derives the bump from the commits; `patch`, `minor`, and `major` override it. Tick `dry_run` to preview.
3. The workflow runs `pnpm run check`. Then release-it bumps `package.json`, updates `CHANGELOG.md`, tags `vX.Y.Z`, pushes, and creates the GitHub release. Finally `npm publish` publishes with provenance through npm trusted publishing (OIDC, no npm token stored in the repository).

Preview locally with `pnpm run release:dry`.

### Changelog format

release-it writes each release under the `# Changelog` header as `## X.Y.Z (date)` (`## [X.Y.Z](compare-url) (date)` once a previous tag exists), grouped under `### ⚠ BREAKING CHANGES`, `### Features`, and `### Bug Fixes`. Pi reads those version headings, in the form `## [1.2.0]` or `## 1.2.0 - date`, and after an update shows entries newer than the version the user last saw. Keep every release under a heading pi can parse. A heading without a version number, such as `## Unreleased`, is skipped.

The `## 0.1.0` section of `CHANGELOG.md` is written by hand and describes the first release by theme. Release it with `first_release: true` (`gh workflow run release.yml -f first_release=true -f bootstrap=true`): the workflow tags the `0.1.0` already in `package.json`, uses that section as the GitHub release notes, and publishes, without running release-it. Every later release uses release-it as above, which counts from the `v0.1.0` tag and adds a generated section above the hand-written one.

### First publish

The first publish of a new package cannot use trusted publishing, because the package must exist on npm first. Run the workflow once with `bootstrap: true` and a short-lived, publish-only `NPM_TOKEN` repository secret. Then configure trusted publishing on npmjs.com (GitHub Actions, this repository, workflow `release.yml`) and delete the secret. If a run already tagged the release and created the GitHub release but failed at `npm publish`, re-run it with `publish_only: true` (plus `bootstrap: true` for that first publish) instead of cutting a new version.
