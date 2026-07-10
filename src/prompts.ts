import { type Task } from "./types.js";

/** Prompt for a fresh-context executor. The task brief must be self-contained. */
export function buildExecutorPrompt(
  task: Task,
  dependencyReports: { id: string; title: string; report: string }[]
): string {
  const sections = [
    `You are an executor agent working on one task with a fresh context. Complete it fully, then stop.`,
    `## Task ${task.id}: ${task.title}`,
    task.brief,
  ];

  if (task.reviewNotes) {
    sections.push(`## Review feedback to address\n${task.reviewNotes}`);
  }

  for (const dep of dependencyReports) {
    sections.push(`## Context from completed dependency ${dep.id} (${dep.title})\n${dep.report}`);
  }

  sections.push(
    [
      "## Rules",
      "- Work only on this task. Do not expand scope.",
      "- The user may send steering messages mid-run; treat them as authoritative corrections.",
      "- Verify your work (run tests/build/typecheck where applicable).",
      "- End your final message with a `## Report` section containing:",
      "  - What was done (short bullets)",
      "  - Files changed",
      "  - How it was verified",
      "  - Open questions or risks, if any",
    ].join("\n")
  );

  return sections.join("\n\n");
}

/** Prompt for an adversarial reviewer with read-only tools and a fresh context. */
export function buildReviewPrompt(task: Task, report: string): string {
  return [
    `You are an adversarial code reviewer with a fresh context. Another agent claims it completed the task below. Your job is to find real problems, not to be agreeable.`,
    `## Task ${task.id}: ${task.title}`,
    task.brief,
    `## Executor report\n${report}`,
    [
      "## Instructions",
      "- Independently verify the claims: read the changed files, run read-only checks.",
      "- Look for: incorrect logic, missing requirements, broken edge cases, unverified claims, scope creep.",
      "- Do NOT modify any files.",
      "- End your final message with a verdict line, exactly one of:",
      "  - `VERDICT: APPROVE` when the work is correct and complete",
      "  - `VERDICT: REQUEST_CHANGES` followed by a numbered list of required fixes",
    ].join("\n"),
  ].join("\n\n");
}

/** Parse the reviewer's verdict line demanded by buildReviewPrompt. */
export function parseVerdict(report: string): { approved: boolean; notes: string } | undefined {
  const match = report.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES)/i);
  if (!match) return undefined;
  const approved = (match[1] ?? "").toUpperCase() === "APPROVE";
  const notes = report.slice((match.index ?? 0) + (match[0]?.length ?? 0)).trim();
  return { approved, notes };
}

/** Injected into the orchestrator conversation by /conductor start. */
export function buildOrchestratorBriefing(goal: string): string {
  return [
    "You are the orchestrator. Plan the work, delegate execution to cheap fresh-context executors, and keep your own context clean. Do not implement tasks yourself.",
    `## Goal\n${goal}`,
    [
      "## Workflow",
      "1. Investigate just enough to split the goal into small, independently verifiable tasks.",
      "2. Call `conductor_plan` with self-contained briefs (executors see ONLY the brief plus approved dependency reports). Pick a tier per task by complexity: trivial, standard, or complex.",
      "3. Call `conductor_run` to execute all runnable tasks. Independent tasks run in parallel; dependent tasks wait for approval of their dependencies.",
      "4. For each task that is ready for review, call `conductor_review` (adversarial fresh-context reviewer). If changes are requested, re-run the task with `conductor_run` — the review notes are passed to the executor automatically.",
      "5. Repeat run/review until all tasks are approved, then summarize the overall outcome for the user.",
      "",
      "## Rules",
      "- Never paste large file contents into task briefs; reference paths instead.",
      "- Keep briefs precise: goal, constraints, acceptance criteria, verification command.",
      "- Trust reports, but let the reviewer verify. Do not re-read all executor output yourself.",
    ].join("\n"),
  ].join("\n\n");
}
