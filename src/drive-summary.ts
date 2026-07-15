import { findTask, loadBoard } from "./board.js";
import { truncateText } from "./format.js";
import { type Board } from "./types.js";
import { type DriveSummary, formatDriveSummary, lastReport, snapshot } from "./workflow.js";

export function unexpectedDriveSummary(
  cwd: string,
  taskIds: string[] | undefined,
  error: unknown
): DriveSummary {
  const board = loadBoard(cwd);
  const selected = board.tasks.filter((task) => !taskIds || taskIds.includes(task.id));
  return {
    rounds: 0,
    tasks: selected.map((task) => snapshot(task)),
    stoppedBecause: {
      code: "error",
      message: `Drive stopped with an internal error: ${error instanceof Error ? error.message : String(error)}`,
      taskIds: selected.map((task) => task.id),
    },
  };
}

export function formatDrivePulse(summary: DriveSummary): string {
  const base = formatDriveSummary(summary);
  const code = summary.stoppedBecause.code;
  if (code === "no_progress") {
    return `${summary.stoppedBecause.message}\n\n${base}`;
  }
  if (code === "provider_blocked") {
    return `${base}\n\nChoose a recovery: configure another fallback in /maestro config then /maestro resume, or maestro_update the task, or ask the user if the block is a cost/quota decision. Do not blindly retry the same provider.`;
  }
  if (code === "escalation_required") {
    return `${base}\n\nChoose one: maestro_update to raise the tier or rewrite the brief, maestro_plan to split the task, cancel it, or ask the user when scope/cost judgment is required, then /maestro resume. Do not blindly retry or raise maxAttempts.`;
  }
  if (code === "review_disagreement") {
    return `${base}\n\nResolve the disagreement deliberately: use maestro_update to change the task reviewPolicy, or split/cancel the task after inspecting both retained reviewer reports. Then start maestro_drive for the corrected scope.`;
  }
  if (code === "reviewer_failure") {
    return `${base}\n\nInspect the retained reviewer launch and artifact/verification evidence, correct the operational cause, then start maestro_drive for the affected task. Operational failures do not count as reviewer rejection or disagreement.`;
  }
  if (code === "attempt_cap") {
    return `${base}\n\nThe capped predecessor cannot run again because its consumed attempts remain. Create a narrowly scoped successor with maestro_plan and set supersedesTaskId to the capped task. Maestro atomically preserves the predecessor as cancelled and rewires downstream dependencies. Then start maestro_drive for the successor and rewired dependents. Do not perform cancellation/rewiring as separate calls or raise maxAttempts.`;
  }
  if (code === "stale_completion") {
    return `${base}\n\nThe approved proof is stale or legacy and cannot satisfy dependencies. Use the human Retry control for an isolated rerun, or create a scoped successor when the old work must remain retained. Inspect the fingerprint reason before changing the contract or configuration.`;
  }
  if (code === "blocked") {
    return `${base}\n\nChoose one: maestro_update the brief/tier, maestro_plan to split, cancel the task, or ask the user. Do not raise the project maxAttempts to force another retry.`;
  }
  return base;
}

export function reportPreview(board: Board, taskId: string, maxLines: number): string {
  const task = findTask(board, taskId);
  const report = task ? lastReport(task) : undefined;
  if (!report) return "";
  return `\nReport:\n${truncateText(report, maxLines)}`;
}
