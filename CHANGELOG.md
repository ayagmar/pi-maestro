# Changelog

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
