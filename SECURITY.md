# Security policy

## Supported versions

Only the latest published release receives security fixes. Upgrade to the newest patch before reporting or reproducing an issue.

Pi Maestro requires pi 1.0 or newer and Node.js 22.19 or newer. It is tested against the `1.0.x` line of `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`. Reports against earlier pi releases are out of scope.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** flow in the repository Security tab to create a private security advisory. Include:

- the affected Pi Maestro and Node.js versions;
- the smallest reproducible configuration or board state;
- the security impact and required attacker access;
- relevant logs with credentials, tokens, private prompts, and repository content removed.

Expect an acknowledgement within seven days. A validated report will receive a remediation plan before public disclosure.

## Security boundaries

Pi Maestro runs local executors and operator-selected verification commands with the current user's permissions. Git worktrees provide isolation and recovery, not a security sandbox. Repository configuration cannot define verification commands, but installed extensions and user configuration remain trusted local code. See **Limitations and trust boundaries** in the README before operating on untrusted repositories.
