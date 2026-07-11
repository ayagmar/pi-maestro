import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { findTask, forceStatus, stateDir, transition, updateTask } from "./board.js";
import { resolveTierModel } from "./config.js";
import { taskUsage, truncateText } from "./format.js";
import { buildExecutorPrompt, buildReviewPrompt, parseVerdict } from "./prompts.js";
import { type ExecutorHandle, type RunUpdate } from "./runner.js";
import {
  type Board,
  type MaestroConfig,
  type Task,
  type TaskStatus,
  type TierConfig,
} from "./types.js";

export interface TaskSnapshot {
  id: string;
  title: string;
  status: TaskStatus;
  tier: string;
  attempts: number;
  cost: number;
  turns: number;
  note?: string;
}

export interface WorkflowRun {
  taskId: string;
  kind: "execute" | "review";
  turns: number;
  cost: number;
  lastActivity: string;
  handle: ExecutorHandle;
}

export type StartExecutor = typeof import("./runner.js").startExecutor;
export type WorkflowUpdate = (taskId: string, update: RunUpdate) => void;
export type TrackRun = (run: WorkflowRun) => () => void;

export function snapshot(task: Task, note?: string): TaskSnapshot {
  const usage = taskUsage(task);
  const result: TaskSnapshot = {
    id: task.id,
    title: task.title,
    status: task.status,
    tier: task.tier,
    attempts: task.attempts.length,
    cost: usage.cost,
    turns: usage.turns,
  };
  if (note !== undefined) result.note = note;
  return result;
}

export function lastReport(task: Task): string | undefined {
  return task.attempts.at(-1)?.finalReport;
}

export function preflightTaskTiers(
  tasks: Task[],
  config: MaestroConfig,
  modelRegistry: ModelRegistry,
  preferredProvider?: string
): Map<string, TierConfig> {
  const resolvedTiers = new Map<string, TierConfig>();

  for (const task of tasks) {
    if (resolvedTiers.has(task.tier)) continue;

    const tier = config.tiers[task.tier] ?? config.tiers.standard;
    if (!tier) throw new Error(`No tier config for "${task.tier}" and no standard fallback`);

    const resolution = resolveTierModel(task.tier, tier, modelRegistry, preferredProvider);
    if (!resolution.ok) throw new Error(resolution.error);

    const resolved: TierConfig = { ...tier };
    if (resolution.modelArg === undefined) delete resolved.model;
    else resolved.model = resolution.modelArg;
    resolvedTiers.set(task.tier, resolved);
  }

  return resolvedTiers;
}

export async function executeTask(options: {
  cwd: string;
  board: Board;
  task: Task;
  tier: TierConfig;
  config: MaestroConfig;
  startExecutor: StartExecutor;
  signal?: AbortSignal;
  onUpdate: WorkflowUpdate;
  trackRun: TrackRun;
}): Promise<TaskSnapshot> {
  const { cwd, board, task, tier, config, startExecutor, signal, onUpdate, trackRun } = options;

  if (task.attempts.length >= config.maxAttempts) {
    const updated = updateTask(cwd, task.id, (fresh) => {
      forceStatus(fresh, "failed");
    });
    return snapshot(
      updated ?? task,
      `attempt cap reached (${config.maxAttempts}); rewrite the brief with maestro_update or raise maxAttempts`
    );
  }

  const dependencyReports = task.dependsOn
    .map((depId) => findTask(board, depId))
    .filter((dep): dep is Task => dep !== undefined && lastReport(dep) !== undefined)
    .map((dep) => ({ id: dep.id, title: dep.title, report: lastReport(dep) ?? "" }));

  const attemptIndex = task.attempts.length + 1;
  const runOptions: Parameters<StartExecutor>[0] = {
    stateDir: stateDir(cwd),
    runId: `${task.id}-attempt-${attemptIndex}`,
    cwd,
    prompt: buildExecutorPrompt(task, dependencyReports),
    tier,
    onUpdate: (update) => onUpdate(task.id, update),
  };
  if (signal) runOptions.signal = signal;
  if (config.maxCostPerTask > 0) runOptions.maxCost = config.maxCostPerTask;

  const run = startExecutor(runOptions);
  run.attempt.index = attemptIndex;
  const untrack = trackRun({
    taskId: task.id,
    kind: "execute",
    turns: 0,
    cost: 0,
    lastActivity: "starting…",
    handle: run,
  });

  // All board writes go through updateTask (fresh load per write) because
  // parallel executors finish in arbitrary order.
  updateTask(cwd, task.id, (fresh) => {
    transition(fresh, "running");
    fresh.attempts.push(run.attempt);
  });

  const outcome = await run.outcome;
  untrack();

  if (outcome.finalReport) run.attempt.finalReport = outcome.finalReport;
  if (outcome.model !== undefined) run.attempt.model = outcome.model;

  const status: TaskStatus = outcome.aborted
    ? "cancelled"
    : outcome.exitCode !== 0 || outcome.errorMessage
      ? "failed"
      : "ready_for_review";

  const updated = updateTask(cwd, task.id, (fresh) => {
    transition(fresh, status);
    fresh.attempts[fresh.attempts.length - 1] = run.attempt;
  });

  const note = outcome.aborted
    ? "aborted by user"
    : status === "failed"
      ? (outcome.errorMessage ?? `exit code ${outcome.exitCode}`)
      : undefined;
  return snapshot(updated ?? task, note);
}

export async function reviewTask(options: {
  cwd: string;
  task: Task;
  tier: TierConfig;
  startExecutor: StartExecutor;
  signal?: AbortSignal;
  onUpdate: WorkflowUpdate;
  trackRun: TrackRun;
}): Promise<TaskSnapshot> {
  const { cwd, task, tier, startExecutor, signal, onUpdate, trackRun } = options;
  const report = lastReport(task);
  if (!report) return snapshot(task, "no executor report to review");

  const runOptions: Parameters<StartExecutor>[0] = {
    stateDir: stateDir(cwd),
    runId: `${task.id}-review-${task.attempts.length}`,
    cwd,
    prompt: buildReviewPrompt(task, report),
    tier,
    onUpdate: (update) => onUpdate(task.id, update),
  };
  if (signal) runOptions.signal = signal;

  const run = startExecutor(runOptions);
  const untrack = trackRun({
    taskId: task.id,
    kind: "review",
    turns: 0,
    cost: 0,
    lastActivity: "starting…",
    handle: run,
  });

  const outcome = await run.outcome;
  untrack();

  const verdict =
    outcome.aborted || outcome.exitCode !== 0 || outcome.errorMessage
      ? undefined
      : parseVerdict(outcome.finalReport);

  const updated = updateTask(cwd, task.id, (fresh) => {
    // Reviewer usage is billed against the task for honest per-task cost.
    const attempt = fresh.attempts.at(-1);
    if (attempt) {
      attempt.usage.input += outcome.usage.input;
      attempt.usage.output += outcome.usage.output;
      attempt.usage.cost += outcome.usage.cost;
      attempt.usage.turns += outcome.usage.turns;
      // Keep the full review report and session for post-hoc inspection.
      if (outcome.finalReport) attempt.reviewReport = outcome.finalReport;
      if (run.attempt.sessionFile) attempt.reviewSessionFile = run.attempt.sessionFile;
    }
    if (!verdict) return; // aborted/failed/no verdict: stays ready_for_review
    if (verdict.approved) {
      transition(fresh, "approved");
      delete fresh.reviewNotes;
    } else {
      transition(fresh, "changes_requested");
      fresh.reviewNotes = verdict.notes || outcome.finalReport;
    }
  });

  const result = updated ?? task;
  if (outcome.aborted) {
    return snapshot(result, "review aborted by user; task stays ready for review");
  }
  if (outcome.exitCode !== 0 || outcome.errorMessage) {
    return snapshot(result, `review failed: ${outcome.errorMessage ?? outcome.exitCode}`);
  }
  if (!verdict) {
    return snapshot(result, "reviewer gave no VERDICT line; review again or inspect manually");
  }
  if (verdict.approved) {
    // Show what the reviewer actually verified, not a bare "approved".
    const summary = outcome.finalReport.replace(/VERDICT:\s*APPROVE\s*$/i, "").trim();
    return snapshot(result, truncateText(summary, 10) || "approved");
  }
  return snapshot(result, truncateText(verdict.notes, 10));
}
