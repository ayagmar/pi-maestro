import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { findTask, forceStatus, loadBoard, stateDir, transition, updateTask } from "./board.js";
import { resolveTierModels } from "./config.js";
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
import { commitAll, mergeWorktree, removeWorktree, type WorktreeRef } from "./worktree.js";

const mainTreeOperationTails = new Map<string, Promise<void>>();

async function serializeMainTreeOperation<T>(cwd: string, operation: () => T): Promise<T> {
  const previous = mainTreeOperationTails.get(cwd) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => {},
    () => {}
  );
  mainTreeOperationTails.set(cwd, tail);

  try {
    return await result;
  } finally {
    if (mainTreeOperationTails.get(cwd) === tail) mainTreeOperationTails.delete(cwd);
  }
}

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

    const resolution = resolveTierModels(task.tier, tier, modelRegistry, preferredProvider);
    if (!resolution.ok) throw new Error(resolution.error);

    const resolved: TierConfig = { ...tier };
    const [primary, ...fallbacks] = resolution.modelArgs;
    if (primary === undefined) delete resolved.model;
    else resolved.model = primary;
    if (fallbacks.length === 0) delete resolved.fallbacks;
    else resolved.fallbacks = fallbacks.filter((model): model is string => model !== undefined);
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
  worktree?: WorktreeRef;
  startExecutor: StartExecutor;
  signal?: AbortSignal;
  onUpdate: WorkflowUpdate;
  trackRun: TrackRun;
}): Promise<TaskSnapshot> {
  const { cwd, board, task, tier, config, worktree, startExecutor, signal, onUpdate, trackRun } =
    options;

  const consumedAttempts = task.attempts.filter((attempt) => !attempt.providerFailure).length;
  if (consumedAttempts >= config.maxAttempts) {
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
    .map((dep) => {
      const recordedAttempt = dep.attempts.at(-1);
      const report = {
        id: dep.id,
        title: dep.title,
        report: recordedAttempt?.finalReport ?? "",
      };
      if (!recordedAttempt?.sessionFile) return report;
      return { ...report, sessionFile: recordedAttempt.sessionFile };
    });

  const models = [tier.model, ...(tier.fallbacks ?? [])];
  let updated: Task | undefined;

  for (const [modelIndex, model] of models.entries()) {
    const attemptIndex = (loadBoardAttemptCount(cwd, task.id) ?? task.attempts.length) + 1;
    const attemptTier: TierConfig = { ...tier };
    delete attemptTier.fallbacks;
    if (model === undefined) delete attemptTier.model;
    else attemptTier.model = model;

    const runOptions: Parameters<StartExecutor>[0] = {
      stateDir: stateDir(cwd),
      runId: `${task.id}-attempt-${attemptIndex}`,
      cwd: worktree?.worktreePath ?? cwd,
      prompt: buildExecutorPrompt(task, dependencyReports),
      tier: attemptTier,
      onUpdate: (update) => onUpdate(task.id, update),
    };
    if (signal) runOptions.signal = signal;
    if (config.maxCostPerTask > 0) runOptions.maxCost = config.maxCostPerTask;

    const run = startExecutor(runOptions);
    run.attempt.index = attemptIndex;
    if (worktree) {
      run.attempt.worktreePath = worktree.worktreePath;
      run.attempt.branch = worktree.branch;
    }
    const untrack = trackRun({
      taskId: task.id,
      kind: "execute",
      turns: 0,
      cost: 0,
      lastActivity: "starting…",
      handle: run,
    });

    updateTask(cwd, task.id, (fresh) => {
      transition(fresh, "running");
      fresh.attempts.push(run.attempt);
    });

    const outcome = await run.outcome;
    untrack();
    if (outcome.finalReport) run.attempt.finalReport = outcome.finalReport;
    if (outcome.model !== undefined) run.attempt.model = outcome.model;
    if (outcome.errorMessage) run.attempt.errorMessage = outcome.errorMessage;
    run.attempt.exitCode = outcome.exitCode;

    const status: TaskStatus = outcome.aborted
      ? "cancelled"
      : outcome.exitCode !== 0 || outcome.errorMessage
        ? "failed"
        : "ready_for_review";
    const providerFailure =
      status === "failed" &&
      outcome.usage.turns === 0 &&
      !outcome.aborted &&
      !outcome.errorMessage?.startsWith("cost cap exceeded:") &&
      models.length > 1;
    const canFallback = providerFailure && modelIndex < models.length - 1;
    if (providerFailure) run.attempt.providerFailure = true;

    updated = updateTask(cwd, task.id, (fresh) => {
      transition(fresh, status);
      fresh.attempts[fresh.attempts.length - 1] = run.attempt;
    });
    if (canFallback) continue;

    const note = outcome.aborted
      ? "aborted by user"
      : status === "failed"
        ? (outcome.errorMessage ?? `exit code ${outcome.exitCode}`)
        : undefined;
    return snapshot(updated ?? task, note);
  }

  return snapshot(updated ?? task);
}

function loadBoardAttemptCount(cwd: string, taskId: string): number | undefined {
  return findTask(loadBoard(cwd), taskId)?.attempts.length;
}

/** Conventional commit message for a task: orchestrator-provided, or derived from the title. */
export function taskCommitMessage(task: Task): string {
  if (task.commitMessage) return task.commitMessage;
  const title = task.title.charAt(0).toLowerCase() + task.title.slice(1);
  return `feat: ${title}`;
}

export async function reviewTask(options: {
  cwd: string;
  task: Task;
  tier: TierConfig;
  startExecutor: StartExecutor;
  autoCommit?: boolean;
  signal?: AbortSignal;
  onUpdate: WorkflowUpdate;
  trackRun: TrackRun;
}): Promise<TaskSnapshot> {
  const { cwd, task, tier, startExecutor, autoCommit, signal, onUpdate, trackRun } = options;
  const report = lastReport(task);
  if (!report) return snapshot(task, "no executor report to review");

  const reviewedAttempt = task.attempts.at(-1);
  const worktree =
    reviewedAttempt?.worktreePath && reviewedAttempt.branch
      ? { worktreePath: reviewedAttempt.worktreePath, branch: reviewedAttempt.branch }
      : undefined;
  const runOptions: Parameters<StartExecutor>[0] = {
    stateDir: stateDir(cwd),
    runId: `${task.id}-review-${task.attempts.length}`,
    cwd: worktree?.worktreePath ?? cwd,
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

  let verdict =
    outcome.aborted || outcome.exitCode !== 0 || outcome.errorMessage
      ? undefined
      : parseVerdict(outcome.finalReport);
  let mergeConflict: string | undefined;
  if (verdict?.approved && worktree) {
    const merge = await serializeMainTreeOperation(cwd, () => {
      const result = mergeWorktree(cwd, worktree, taskCommitMessage(task));
      if (result.ok) removeWorktree(cwd, worktree);
      return result;
    });
    if (!merge.ok) {
      mergeConflict = `Approved review could not be merged because of a git conflict. Recovery worktree: ${worktree.worktreePath}\nBranch: ${worktree.branch}\n${merge.error ?? "Merge failed"}`;
      verdict = { approved: false, notes: mergeConflict };
    }
  } else if (verdict?.approved && autoCommit) {
    // Main-tree run: commit this task's files so each approval lands as one
    // conventional commit. Failure must not block the approval - the work is
    // done and reviewed; committing is bookkeeping.
    const files = reviewedAttempt?.touchedFiles ?? [];
    try {
      await serializeMainTreeOperation(cwd, () =>
        commitAll(cwd, taskCommitMessage(task), files.length > 0 ? files : undefined)
      );
    } catch {
      // Not a git repo, nothing staged, or a hook rejected it - leave the tree as-is.
    }
  }

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
  if (mergeConflict) return snapshot(result, truncateText(mergeConflict, 10));
  if (verdict.approved) {
    // Show what the reviewer actually verified, not a bare "approved".
    const summary = outcome.finalReport.replace(/VERDICT:\s*APPROVE\s*$/i, "").trim();
    return snapshot(result, truncateText(summary, 10) || "approved");
  }
  return snapshot(result, truncateText(verdict.notes, 10));
}
