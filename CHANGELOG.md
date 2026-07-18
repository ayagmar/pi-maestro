# Changelog

## Unreleased

### Correctness

- Parallel non-worktree batches now auto-isolate in per-task worktrees (with a user notice) so concurrent executors can never cross-attribute each other's file changes; single-task dispatch keeps the shared checkout, and non-Git projects keep legacy behavior.
- Investigation runs that legitimately write a long report across turns without tool calls now count meaningful report growth as watchdog progress.
- Legacy investigation-phrased briefs (empty writePaths without `kind: "investigation"`) now produce an explicit deprecation notice at planning; the explicit kind is the supported path.
- Watchdog progress detection is now run-kind aware: investigation/discovery executors and reviewers progress through novel read-tool activity instead of being steered with implementation text and killed as stalled; only exact repeated actions count as no progress, and steering messages are phase-specific.
- Non-worktree executions now attribute file changes by content against a pre-run Git baseline, so bash-side mutations (sed -i, git apply, codegen) are included in touched files, candidate trees, and review scope; pre-existing user dirt is never attributed to the executor.
- Task contracts gained an explicit `kind: "investigation"` field replacing the brief-phrasing regex for no-file work; legacy investigation-phrased briefs remain accepted, and the kind flows through maestro_plan, maestro_update, recipes, plan export/import, and the contract fingerprint.
- Human-retry risk tokens no longer include `updatedAt`, so unrelated board touches between confirmation and dispatch cannot invalidate a confirmed retry; acceptance and integration evidence changes still do.
- Stale board locks now record the owner's kernel process start time on Linux, so a recycled PID can no longer keep a dead lock alive.
- Main-tree identity checks exclude `.pi/maestro.json` and `.pi/maestro-recipes/`, so editing maestro config or recipes mid-review no longer fails promotion with a spurious "main checkout changed".

### Security

- Project-local `.pi/maestro.json` is honored only for pi-trusted projects; untrusted repositories can no longer influence budgets, attempt caps, tier models, or tier tool lists.

### Observability

- Plan approval and drive scale preflight now show a clearly labeled projected-cost estimate, preferring archived per-model-and-tier launch averages before model pricing metadata and a documented static fallback.

### Performance

- Hot render paths (per-executor-event UI refresh) are throttled with a leading-edge coalescing scheduler; single refreshes stay synchronous, bursts collapse to one trailing render.
- The status bar and widgets read a zero-copy cached board view instead of cloning the board on every executor event.
- Interactive tool handlers (maestro_plan/maestro_update and drive decision recovery) wait for the board lock asynchronously, so cross-process contention can no longer stall the TUI event loop.
- macOS and BSD now also get PID-recycle-safe board locks via `ps` start-time identity (Linux keeps /proc).
- Board and config reads are cached by exact file identity (inode + size + mtime ns), and board lock contention now spins at fine granularity before backing off, reducing synchronous stalls on the interactive session.

### Reliability

- Verification logs are streamed to disk as output arrives, so a hard kill of pi retains partial verification evidence.
- Added a best-effort (non-blocking) Windows CI job for typecheck and tests.

## 0.1.0

### Orchestration

- Added plan, run, review, update, status, and drive tools for dependency-aware task workflows.
- Added optional plan approval and autonomous run/review/retry driving.

### Executors

- Nested fresh-context executor and reviewer transcripts under Pi's normal project session root so recursive usage accounting includes them without crowding `/resume`.
- Added fresh-context RPC child sessions with live steering and abort support.
- Added ordered model fallbacks, including quota-aware retries that do not consume the task attempt cap.
- Added per-attempt and whole-run cost caps.

### Git

- Added one automatic commit per approved task.
- Added optional worktree isolation for parallel tasks, with merge-then-delete cleanup after approval.
- Made physical task checkouts ephemeral: recoverable idle work is checkpointed on its task branch and restored only for retry, review, or inspection.

### Observability

- Added a phase-first live dashboard with steering templates, status filters, task and launch drill-down, and explicit current/attention/evidence phase states.
- Persisted review verdicts, task status history, and descriptive numbered attempt and review session names.
- Added board archiving and replay.

### Configuration

- Added built-in presets and an interactive settings UI.
- Added user and project configuration scopes, including primary and fallback model selection.

### Compatibility and release safety

- Added Node.js 22 and 24 CI coverage and bounded compatibility with the Pi `0.80.x` package line.
- Added packed-artifact content and extension-registration smoke testing.
- Added a security policy and automated dependency update configuration.
