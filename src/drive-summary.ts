import { findTask, loadBoard } from "./board.js";
import { boardUsage, describeProgressDelta, truncateText } from "./format.js";
import { type Board, type MaestroConfig, type TaskStatus } from "./types.js";
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
    return `${base}\n\nChoose one: maestro_update to raise the tier or rewrite the brief (then /maestro resume — the edit resets the rejection counters), maestro_plan to split the task with supersedesTaskId (then start maestro_drive for the successor scope; a paused drive scope rewires to the successor automatically), cancel it, or ask the user when scope/cost judgment is required. Do not blindly retry or raise maxAttempts.`;
  }
  if (code === "review_disagreement") {
    return `${base}\n\nResolve the disagreement deliberately: use maestro_update to change the task reviewPolicy, or split/cancel the task after inspecting both retained reviewer reports. Then start maestro_drive for the corrected scope.`;
  }
  if (code === "reviewer_failure") {
    return `${base}\n\nUse maestro_drive inspect for the reviewer verdict, convergence, and failure evidence, correct the operational cause, then start maestro_drive for the affected task. Never open a raw session or log file to investigate: those transcripts are megabytes of replayed tool output, and reading one into this conversation destroys the context and prompt cache. Operational failures do not count as reviewer rejection or disagreement.`;
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

/**
 * Emit a live progress pulse while an awaited drive is running, so a long
 * round is visibly alive. `statusWaitSeconds` is the pulse interval; 0
 * disables pulsing. Returns a stop function.
 */
/** Just the live-run projection a pulse needs, so this stays off the controller. */
export interface HeartbeatRuns {
  liveRunCount(): number;
  liveRunValues(): Iterable<{
    taskId: string;
    kind: "execute" | "review";
    turns: number;
    cost: number;
    lastActivity: string;
  }>;
}

export function startDriveHeartbeat(
  cwd: string,
  runs: HeartbeatRuns,
  config: MaestroConfig,
  emit: (message: string) => void,
  schedule: (callback: () => void, intervalMs: number) => { stop: () => void } = defaultInterval
): () => void {
  const seconds = config.statusWaitSeconds;
  if (!seconds || seconds <= 0) return () => {};
  let previous: Map<string, TaskStatus> | undefined;
  const timer = schedule(() => {
    const tasks = loadBoard(cwd).tasks;
    const delta = describeProgressDelta(previous, tasks);
    previous = new Map(tasks.map((task) => [task.id, task.status] as const));
    const live = [...runs.liveRunValues()]
      .map(
        (run) =>
          `${run.taskId} ${run.kind === "review" ? "reviewing" : "running"} · ${run.turns} turns · $${run.cost.toFixed(4)} · ${run.lastActivity}`
      )
      .join("\n");
    const usage = boardUsage(tasks);
    const header = `Drive running · ${live ? `${runs.liveRunCount()} live agent(s)` : "no live agent"} · $${usage.cost.toFixed(4)} so far`;
    emit([header, live, delta].filter(Boolean).join("\n"));
  }, seconds * 1000);
  return () => timer.stop();
}

function defaultInterval(callback: () => void, intervalMs: number): { stop: () => void } {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
