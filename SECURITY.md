# Security policy

## Supported versions

Only the latest published release receives security fixes. Upgrade to the newest patch before reporting or reproducing an issue.

Pi Maestro requires pi 1.5 or newer and Node.js 22.19 or newer. It is tested against the `1.5.x` line of `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`. Reports against earlier pi releases are out of scope. Pi supplies those packages at runtime, so a vulnerability in pi itself belongs with the pi project.

## Reporting a vulnerability

Do not put vulnerability details in a public issue. Use GitHub's **Report a vulnerability** button in the repository Security tab, which creates a private security advisory. If the button is not there, open an issue that says only that you have a security report and asks for a private channel, then wait for the maintainer to reply. A private report should include:

- the affected Pi Maestro and Node.js versions;
- the smallest reproducible configuration or board state;
- the security impact and required attacker access;
- relevant logs with credentials, tokens, private prompts, and repository content removed.

Expect an acknowledgement within seven days. A validated report will receive a remediation plan before public disclosure.

## Security boundaries

Pi Maestro runs local executors and operator-selected verification commands with the current user's permissions. Git worktrees provide isolation and recovery, not a security sandbox. Repository configuration cannot define verification commands, but installed extensions and user configuration remain trusted local code. Specifically:

- Executors can edit any file the current user can, and reviewers are read-only only while the `review` tier's `tools` stay at `read,grep,find,ls`. Manual approval skips review.
- Trusted verification commands are arbitrary local code. Only the user config (`~/.pi/agent/maestro.json`) can define them. A repository's `.pi/maestro.json` can select one by name and cannot add one.
- Pi decides whether a project is trusted. In an untrusted project Maestro reads no project configuration, so budgets, attempt caps, tier models, and tool lists keep the user's values.
- Maestro's own Git commits skip GPG signing, and every Git call runs with a timeout and without terminal prompts.
- Runtime state under `.pi/maestro/` is written with private file modes where the platform supports them. It can contain prompts, reports, and logs, so do not commit or share it.

See **Limitations and trust boundaries** in the README before operating on untrusted repositories.
