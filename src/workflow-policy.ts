import {
  findTask,
  forceStatus,
  isRunnable,
  isRunnableWithConfig,
  scopedDependencyGaps,
} from "./board.js";
import { taskUsage, truncateText } from "./format.js";
import {
  type Attempt,
  type Board,
  type MaestroConfig,
  type ReviewLaunch,
  type Task,
  type TaskStatus,
} from "./types.js";

export interface AttemptSnapshot {
  attempt: number;
  model?: string;
  provider?: string;
  reviewModel?: string;
  reviewProvider?: string;
  turns: number;
  cost: number;
  touchedFiles: string[];
  failureReason?: Attempt["failureReason"];
  consumesAttempt?: boolean;
  reviewLaunches?: ReviewLaunch[];
  reviewNotes?: string;
}

export interface TaskSnapshot {
  id: string;
  title: string;
  status: TaskStatus;
  tier: string;
  /** Attempts that consume maxAttempts. */
  attempts: number;
  /** Raw executor launches, including provider failures and fallbacks. */
  launches?: number;
  cost: number;
  turns: number;
  history: AttemptSnapshot[];
  retryAction?: string;
  note?: string;
}

export type DriveStopCode =
  | "completed"
  | "aborted"
  | "paused"
  | "plan_gate"
  | "budget_blocked"
  | "provider_blocked"
  | "review_disagreement"
  | "reviewer_failure"
  | "launch_limit"
  | "escalation_required"
  | "attempt_cap"
  | "stale_completion"
  | "blocked"
  | "no_progress"
  | "round_limit"
  | "error";

export interface DriveStopReason {
  code: DriveStopCode;
  message: string;
  taskIds?: string[];
}

export interface DriveSummary {
  rounds: number;
  tasks: TaskSnapshot[];
  stoppedBecause: DriveStopReason;
  /** USD spent by this drive invocation alone; task totals are board-lifetime. */
  driveCost?: number;
}

export function formatDriveSummary(summary: DriveSummary): string {
  const approved = summary.tasks.filter((task) => task.status === "approved").length;
  const failed = summary.tasks.filter((task) => task.status === "failed").length;
  const cancelled = summary.tasks.filter((task) => task.status === "cancelled").length;
  const blocked = summary.tasks.length - approved - failed - cancelled;
  const attempts = summary.tasks.reduce((total, task) => total + task.attempts, 0);
  const launches = summary.tasks.reduce(
    (total, task) => total + (task.launches ?? task.history.length),
    0
  );
  const totalCost = summary.tasks.reduce((total, task) => total + task.cost, 0);
  // One "launch" is one executor or reviewer process. Attempt cost folds
  // reviewer spend in, so averaging attempt cost over attempt count reported
  // roughly double the real per-launch price under a different name.
  const history = summary.tasks.flatMap((task) => task.history);
  const reviewCost = history.reduce(
    (total, item) =>
      total + (item.reviewLaunches ?? []).reduce((sum, launch) => sum + launch.usage.cost, 0),
    0
  );
  const executorCost = Math.max(0, totalCost - reviewCost);
  const billedLaunches = history.reduce((count, item) => {
    const itemReviewCost = (item.reviewLaunches ?? []).reduce(
      (sum, launch) => sum + launch.usage.cost,
      0
    );
    const billedReviews = (item.reviewLaunches ?? []).filter(
      (launch) => launch.usage.cost > 0
    ).length;
    return count + (item.cost - itemReviewCost > 0 ? 1 : 0) + billedReviews;
  }, 0);
  const averageCost = billedLaunches === 0 ? 0 : totalCost / billedLaunches;
  const models = new Set(
    summary.tasks.flatMap((task) =>
      task.history.flatMap((item) =>
        [item.model, item.reviewModel].filter((value) => value !== undefined)
      )
    )
  );
  const providers = new Set(
    summary.tasks.flatMap((task) =>
      task.history.flatMap((item) =>
        [item.provider, item.reviewProvider].filter((value) => value !== undefined)
      )
    )
  );
  const identity = [
    models.size > 0 ? `models: ${[...models].join(", ")}` : "",
    providers.size > 0 ? `providers: ${[...providers].join(", ")}` : "",
  ].filter(Boolean);

  // Task totals are board-lifetime; without the per-drive delta a no-op
  // resume re-printed the whole board's historical spend as if it just happened.
  const driveCost =
    summary.driveCost === undefined ? "" : ` · $${summary.driveCost.toFixed(4)} this drive`;
  return [
    `Drive ${summary.stoppedBecause.code} after ${summary.rounds} round(s): ${approved} approved · ${failed} failed · ${cancelled} cancelled · ${blocked} blocked`,
    `${attempts} consuming attempt${attempts === 1 ? "" : "s"} · ${launches} launch${launches === 1 ? "" : "es"} · $${totalCost.toFixed(4)} total (executor $${executorCost.toFixed(4)} · review $${reviewCost.toFixed(4)})${driveCost} · $${averageCost.toFixed(4)} avg billed launch`,
    ...identity,
    summary.stoppedBecause.message,
  ].join("\n");
}

export const DRIVE_ROUND_LIMIT = 20;

/** Consecutive genuine reviewer rejections before the drive escalates instead of retrying. */
export const REVIEW_REJECTION_LIMIT = 2;

/** Built-in tiers, cheapest first, used to recommend the next rung on escalation. */
export const TIER_LADDER = ["trivial", "standard", "complex"] as const;

/**
 * A task whose last attempt failed for a reason a rerun cannot change. The
 * classifier marks these `retryable: false`; scheduling another identical
 * attempt only bills for the same wall a second time.
 */
export function endedUnretryably(task: Task): boolean {
  if (task.status !== "failed") return false;
  return task.attempts.at(-1)?.failureReason?.retryable === false;
}

export function consumesMaxAttempt(attempt: Attempt): boolean {
  return attempt.consumesAttempt ?? !attempt.providerFailure;
}

export function snapshot(task: Task, note?: string): TaskSnapshot {
  const usage = taskUsage(task);
  const history = task.attempts.map((attempt) => {
    const item: AttemptSnapshot = {
      attempt: attempt.index,
      turns: attempt.usage.turns,
      cost: attempt.usage.cost,
      touchedFiles: [...attempt.touchedFiles],
    };
    if (attempt.model !== undefined) item.model = attempt.model;
    if (attempt.provider !== undefined) item.provider = attempt.provider;
    if (attempt.reviewModel !== undefined) item.reviewModel = attempt.reviewModel;
    if (attempt.reviewProvider !== undefined) item.reviewProvider = attempt.reviewProvider;
    if (attempt.failureReason !== undefined) item.failureReason = attempt.failureReason;
    item.consumesAttempt = consumesMaxAttempt(attempt);
    if (attempt.reviewLaunches !== undefined) {
      item.reviewLaunches = structuredClone(attempt.reviewLaunches);
    }
    if (attempt.reviewNotes !== undefined) item.reviewNotes = attempt.reviewNotes;
    return item;
  });
  const result: TaskSnapshot = {
    id: task.id,
    title: task.title,
    status: task.status,
    tier: task.tier,
    attempts: task.attempts.filter(consumesMaxAttempt).length,
    // Raw processes launched for this task: every executor attempt plus every
    // reviewer launch. Counting executors alone under-reported the work while
    // the cost figure beside it included reviewer spend.
    launches: task.attempts.reduce(
      (count, attempt) => count + 1 + (attempt.reviewLaunches?.length ?? 0),
      0
    ),
    cost: usage.cost,
    turns: usage.turns,
    history,
  };

  if (
    task.status === "failed" ||
    task.status === "cancelled" ||
    task.status === "changes_requested"
  ) {
    result.retryAction = `maestro_drive({ action: "start", taskIds: ["${task.id}"] })`;
  } else if (task.status === "ready_for_review" && task.attempts.at(-1)?.failureReason) {
    result.retryAction = `maestro_drive({ action: "start", taskIds: ["${task.id}"] })`;
  }

  const persistedReason = task.attempts.at(-1)?.failureReason?.message;
  const usefulNote =
    note ?? (task.status === "changes_requested" ? task.reviewNotes : persistedReason);
  if (usefulNote !== undefined) {
    result.note = result.retryAction ? `${usefulNote}\nRetry: ${result.retryAction}` : usefulNote;
  } else if (result.retryAction) {
    result.note = `Retry: ${result.retryAction}`;
  }
  return result;
}

export function lastReport(task: Task): string | undefined {
  return task.attempts.at(-1)?.finalReport;
}

export interface SchedulingWave {
  runnableIds: string[];
  reviewableIds: string[];
  cappedIds: string[];
  blockedIds: string[];
}

export function calculateSchedulingWave(
  board: Board,
  config: MaestroConfig,
  taskIds?: string[],
  simulateApprovedDependencies = false
): SchedulingWave {
  const selected = taskIds ? new Set(taskIds.map((id) => id.trim().toUpperCase())) : undefined;
  const tasks = board.tasks.filter(
    (task) => selected === undefined || selected.has(task.id.trim().toUpperCase())
  );
  const capped = tasks.filter(
    (task) =>
      (task.attempts.filter(consumesMaxAttempt).length >= config.maxAttempts ||
        endedUnretryably(task)) &&
      task.status !== "approved"
  );
  const runnable = tasks.filter(
    (task) =>
      !capped.includes(task) &&
      task.status !== "cancelled" &&
      (simulateApprovedDependencies
        ? isRunnable(board, task, task.status === "failed")
        : isRunnableWithConfig(board, task, config, task.status === "failed"))
  );
  const reviewable = tasks.filter((task) => task.status === "ready_for_review");
  const active = new Set([...runnable, ...reviewable].map((task) => task.id));
  return {
    runnableIds: runnable.map((task) => task.id),
    reviewableIds: reviewable.map((task) => task.id),
    cappedIds: capped.map((task) => task.id),
    blockedIds: tasks
      .filter((task) => !active.has(task.id) && !["approved", "cancelled"].includes(task.status))
      .map((task) => task.id),
  };
}

export function simulatePlan(board: Board, config: MaestroConfig, taskIds?: string[]): string {
  const simulated = structuredClone(board);
  const waves: string[] = [];
  for (let index = 1; index <= Math.min(64, simulated.tasks.length * 2 + 1); index += 1) {
    const wave = calculateSchedulingWave(simulated, config, taskIds, true);
    if (wave.runnableIds.length === 0 && wave.reviewableIds.length === 0) {
      const blocked = [...wave.cappedIds, ...wave.blockedIds];
      if (blocked.length > 0) waves.push(`blocked: ${[...new Set(blocked)].join(", ")}`);
      break;
    }
    const ids = [...wave.runnableIds, ...wave.reviewableIds];
    waves.push(`wave ${index}: ${ids.slice(0, config.maxParallel).join(", ")}`);
    for (const id of wave.runnableIds) {
      const task = findTask(simulated, id);
      if (task) forceStatus(task, "ready_for_review");
    }
    for (const id of wave.reviewableIds) {
      const task = findTask(simulated, id);
      if (task) forceStatus(task, "approved");
    }
  }
  const scope = taskIds?.join(", ") ?? "whole board";
  const dependencyGaps = taskIds ? scopedDependencyGaps(board, taskIds) : [];
  return truncateText(
    [
      `Mechanical simulation (${scope}; assumes each run and review succeeds):`,
      ...(dependencyGaps.length > 0
        ? [
            `incomplete scope: ${dependencyGaps
              .map((gap) => `${gap.taskId} requires ${gap.dependencyId}`)
              .join(", ")}`,
          ]
        : []),
      ...(waves.length ? waves : ["no work"]),
      `maximum concurrency: ${config.maxParallel}`,
    ].join("\n"),
    4000
  );
}
