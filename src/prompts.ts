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
  dependencyReports: { id: string; title: string; report: string }[]
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
    sections.push(
      `## Context from completed dependency ${dep.id} (${dep.title})\n${truncateInjectedContext(dep.report)}`
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
  sections.push(
    `## Executor report\n${report}`,
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
  boardSummary: string,
  tierGuidance: string
): string {
  return [
    "Role: supervising orchestrator taking over an existing maestro board with a fresh context. Planning is done. You drive execution and review; you do not implement tasks yourself.",
    `## Goal\n${goal ?? "(not recorded — infer from the board)"}`,
    `## Board\n${boardSummary}`,
    [
      "## Success criteria",
      "- Every task on the board is approved by an adversarial review.",
      "- The final summary states what changed, how it was verified, and any open risks.",
      "",
      "## Workflow",
      "1. `maestro_run`: executes all runnable tasks; independent tasks run in parallel, dependents wait for approval.",
      "2. `maestro_review`: adversarial fresh-context review for tasks that are ready. Rejected tasks carry the review notes into their next run automatically.",
      "3. Repeat run/review until all tasks are approved, then summarize.",
      "",
      "## Decision rules",
      "- Use `maestro_status` instead of re-reading executor output.",
      "- Do not re-plan. Only adjust tasks (`maestro_update` to refine a brief or escalate a tier, `maestro_plan` to split) when a task fails twice with the same root cause.",
      tierGuidance,
      "- Ask the user before expanding scope beyond the stated goal.",
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
      "1. Investigate just enough to split the goal into small, independently verifiable tasks.",
      "2. `maestro_plan`: each brief must be self-contained (executors see only the brief plus approved dependency reports) and include goal, relevant file paths, constraints, acceptance criteria, and a verification command.",
      "3. `maestro_run`: executes all runnable tasks; independent tasks run in parallel, dependents wait for approval.",
      "4. `maestro_review`: adversarial fresh-context review for tasks that are ready. Rejected tasks carry the review notes into their next run automatically.",
      "5. Repeat run/review until all tasks are approved, then summarize.",
      "",
      "## Tier selection",
      tierGuidance,
      "",
      "## Decision rules",
      "- Use `maestro_status` instead of re-reading executor output.",
      "- Reference file paths in briefs; paste file contents only when an executor cannot discover them itself.",
      "- If a task fails twice with the same root cause, stop retrying: `maestro_update` its brief or tier, split it with `maestro_plan`, or cancel it.",
      "- Ask the user before expanding scope beyond the stated goal.",
      "- If planning required heavy investigation, suggest `/maestro handoff` after the plan is on the board: it continues run/review in a fresh session without this session's planning context.",
    ].join("\n"),
  ].join("\n\n");
}
