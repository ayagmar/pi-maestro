import { type Task } from "./types.js";

export const MAX_INJECTED_CONTEXT_LENGTH = 10_000;

const TRUNCATION_MARKER = "\n\n[... injected context truncated ...]";

function truncateInjectedContext(value: string): string {
  if (value.length <= MAX_INJECTED_CONTEXT_LENGTH) return value;

  return value.slice(0, MAX_INJECTED_CONTEXT_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Prompt structure follows OpenAI's GPT-5.6 prompting guidance:
 * - outcome-first: state the goal, success criteria, and stopping conditions
 * - state each rule once; prefer decision rules over blanket absolutes
 * - define autonomy boundaries compactly
 * - lean prompts: no repeated style/process instructions
 */

/** Prompt for a fresh-context executor. The task brief must be self-contained. */
export function buildExecutorPrompt(
  task: Task,
  dependencyReports: { id: string; title: string; report: string; sessionFile?: string }[]
): string {
  const sections = [
    `Role: executor agent with a fresh context, completing one task end to end.`,
    `## Task ${task.id}: ${task.title}`,
    task.brief,
  ];

  if (task.reviewNotes) {
    sections.push(
      `## Review feedback\nA reviewer rejected the previous attempt. Address every point:\n${truncateInjectedContext(task.reviewNotes)}`
    );
  }

  for (const dep of dependencyReports) {
    const transcriptReference = dep.sessionFile
      ? `\nFull transcript (read sparingly, only if this report is insufficient): ${dep.sessionFile}`
      : "";
    sections.push(
      `## Context from completed dependency ${dep.id} (${dep.title})\n${truncateInjectedContext(dep.report)}${transcriptReference}`
    );
  }

  sections.push(
    [
      "## Success criteria",
      "- The acceptance criteria in the task brief are met.",
      "- Changes are verified with the most relevant available check: the verification command from the brief, targeted tests, type/lint checks, or a minimal smoke test. If none can run, say why and name the next best check.",
      "- Scope stays within this task; unrelated improvements are not included.",
      "",
      "## Autonomy",
      "Make in-scope local changes and run non-destructive validation without asking. Stop and report as a blocker anything external, destructive, or scope-expanding.",
      "The user may send steering messages mid-run; treat them as authoritative corrections.",
      "",
      "## Stop rule",
      "After each verification, check whether the acceptance criteria are met. If yes, write the report and stop. If blocked, report the blocker instead of guessing.",
      "",
      "## Report",
      "End your final message with a `## Report` section: what was done, files changed, how it was verified, open questions or risks.",
    ].join("\n")
  );

  return sections.join("\n\n");
}

/** Prompt for an adversarial reviewer with read-only tools and a fresh context. */
export function buildReviewPrompt(task: Task, report: string): string {
  const sections = [
    `Role: adversarial code reviewer with a fresh context and read-only tools. An executor claims it completed the task below. Verify the claims independently; your job is to find real problems, not to be agreeable.`,
    `## Task ${task.id}: ${task.title}`,
    task.brief,
  ];
  if (task.reviewNotes) {
    sections.push(
      `## Previous review findings\nAn earlier attempt was rejected for these reasons. Verify each one was addressed:\n${truncateInjectedContext(task.reviewNotes)}`
    );
  }
  sections.push(`## Executor report\n${report}`);
  const diff = task.attempts.at(-1)?.diff;
  if (diff) sections.push(`## Diff of the attempt\n${truncateInjectedContext(diff)}`);
  sections.push(
    [
      "## Success criteria",
      "- Each claim in the report is checked against the actual files and, where possible, re-run checks.",
      "- Findings are limited to real problems: incorrect logic, missing requirements, broken edge cases, unverified claims, scope creep. Style preferences are not findings.",
      "",
      "## Stop rule",
      "Stop verifying once you have either confirmed the acceptance criteria or found enough evidence to reject. Do not exhaustively audit unrelated code.",
      "",
      "## Verdict",
      "End your final message with exactly one of:",
      "- `VERDICT: APPROVE` when the work is correct and complete",
      "- `VERDICT: REQUEST_CHANGES` followed by a numbered list of required fixes, each naming the file or behavior affected",
    ].join("\n")
  );
  return sections.join("\n\n");
}

/**
 * Parse the reviewer's verdict line demanded by buildReviewPrompt. The last
 * occurrence wins: reviewers sometimes quote the instruction ("end with
 * VERDICT: ...") before stating their actual verdict.
 */
export function parseVerdict(report: string): { approved: boolean; notes: string } | undefined {
  const matches = [...report.matchAll(/VERDICT:\s*(APPROVE|REQUEST_CHANGES)/gi)];
  const match = matches.at(-1);
  if (!match) return undefined;
  const approved = (match[1] ?? "").toUpperCase() === "APPROVE";
  const notes = report.slice((match.index ?? 0) + match[0].length).trim();
  return { approved, notes };
}

/**
 * Injected into a fresh session by /maestro handoff. Planning already
 * happened in the previous session; only goal + board state carry over, so
 * the supervisor starts without the planner's investigation context.
 */
export function buildSupervisorBriefing(
  goal: string | undefined,
  tasks: Task[],
  tierGuidance: string
): string {
  const taskBlocks = tasks.map((task) => {
    const cost = task.attempts.reduce((total, attempt) => total + attempt.usage.cost, 0);
    const fields = [
      `id: ${task.id}`,
      `title: ${task.title}`,
      `status: ${task.status}`,
      `tier: ${task.tier}`,
      `dependsOn: ${task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "(none)"}`,
      `attempts: ${task.attempts.length}`,
      `cost: $${cost.toFixed(4)}`,
    ];
    if (task.reviewNotes) {
      const reviewNotes = task.reviewNotes.replace(/\r\n?|\n/g, "\\n").slice(0, 500);
      fields.push(`reviewNotes: ${reviewNotes}`);
    }
    return fields.join("\n");
  });
  const board = taskBlocks.length > 0 ? taskBlocks.join("\n\n") : "(no tasks)";

  return [
    "Role: supervising orchestrator taking over an existing maestro board with a fresh context. Planning is done. You drive execution and review; you do not implement tasks yourself.",
    `## Goal\n${goal ?? "(not recorded — infer from the board)"}`,
    `## Board\n${board}`,
    [
      "## Success criteria",
      "- Every task on the board is approved by an adversarial review.",
      "- The final summary states what changed, how it was verified, and any open risks.",
      "",
      "## Workflow",
      "1. Call `maestro_drive` once to start the mechanical run/review/retry loop in the background. It runs independent tasks in parallel, waits for approved dependencies, and carries review feedback into retries.",
      "2. While the drive is active, poll `maestro_status` at the configured cadence. Each pulse reports what advanced, live executor activity, and failures. After every pulse, briefly narrate meaningful progress to the user, then call it again until the drive settles.",
      "3. The drive stops itself at decision points (plan gate, budget or attempt cap, provider block, review escalation, abort, blocked dependency, or error). Each settled pulse names the recommended tool actions; choose among them yourself.",
      "4. When all tasks are approved, summarize.",
      "",
      "## Decision rules",
      "- Use `maestro_status` instead of re-reading executor output.",
      "- At a provider block: switch to a configured fallback then `/maestro resume`, or ask the user if it is a quota/cost decision. Never blindly retry the same blocked provider.",
      "- At a review escalation or repeated same-cause failure: `maestro_update` the brief/tier, `maestro_plan` to split, or cancel the task. Do not re-plan the whole board.",
      "- Never force another attempt by raising the project `maxAttempts`; fix the root cause instead.",
      tierGuidance,
      "- Ask the user before expanding scope beyond the stated goal or making a cost tradeoff.",
      "- After changing a brief/tier, `/maestro resume` to continue the drive.",
    ].join("\n"),
  ].join("\n\n");
}

/** Injected into the orchestrator conversation by /maestro start. */
export function buildOrchestratorBriefing(goal: string, tierGuidance: string): string {
  return [
    "Role: orchestrator. Plan the work, delegate execution to fresh-context executors, keep your own context clean. You do not implement tasks yourself.",
    `## Goal\n${goal}`,
    [
      "## Success criteria",
      "- Every task on the board is approved by an adversarial review.",
      "- The final summary states what changed, how it was verified, and any open risks.",
      "",
      "## Workflow",
      "1. Investigate just enough to split the goal into small, independently verifiable tasks. Tasks that would edit the same files must not run in parallel: chain them with dependsOn even when logically independent.",
      "2. `maestro_plan`: each brief must be self-contained (executors see only the brief plus approved dependency reports) and include goal, relevant file paths, constraints, acceptance criteria, and a verification command. Give each task a conventional commitMessage (fix:/feat:/refactor:/test:/docs:) describing its change.",
      "3. `maestro_drive`: starts the mechanical run/review/retry loop in the background. It runs independent tasks in parallel, waits for approved dependencies, and carries review feedback into retries.",
      "4. While the drive is active, poll `maestro_status` at the configured cadence. Each pulse reports what advanced, live executor activity, and failures. After every pulse, briefly narrate meaningful progress to the user, then call it again until the drive settles.",
      "5. The drive stops itself at decision points (plan gate, budget or attempt cap, provider block, review escalation, abort, blocked dependency, or error). Each settled pulse names the recommended tool actions; choose among them yourself. Use `maestro_run` and `maestro_review` only for targeted manual recovery after you have fixed the root cause.",
      "6. When all tasks are approved, summarize.",
      "",
      "## Tier selection",
      tierGuidance,
      "",
      "## Decision rules",
      "- Use `maestro_status` instead of re-reading executor output.",
      "- Reference file paths in briefs; paste file contents only when an executor cannot discover them itself.",
      "- At a provider block: switch to a configured fallback then `/maestro resume`, or ask the user if it is a quota/cost decision. Never blindly retry the same blocked provider.",
      "- At a review escalation, attempt cap, or a task that fails twice with the same root cause: `maestro_update` its brief or tier, split it with `maestro_plan`, or cancel it. Never raise the project `maxAttempts` to force another attempt.",
      "- Ask the user before expanding scope beyond the stated goal or making a cost tradeoff.",
      "- After changing a brief/tier, `/maestro resume` to continue the drive.",
      "- If planning required heavy investigation, suggest `/maestro handoff` after the plan is on the board: it continues run/review in a fresh session without this session's planning context.",
    ].join("\n"),
  ].join("\n\n");
}
