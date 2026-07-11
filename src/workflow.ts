import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  findTask,
  forceStatus,
  isRunnable,
  loadBoard,
  stateDir,
  transition,
  updateTask,
} from "./board.js";
import { resolveTierModels } from "./config.js";
import { runBudgetWarning, taskUsage, truncateText } from "./format.js";
import { buildExecutorPrompt, buildReviewPrompt, parseVerdict } from "./prompts.js";
import { mapWithConcurrencyLimit, type ExecutorHandle, type RunUpdate } from "./runner.js";
import {
  type Board,
  type MaestroConfig,
  type Task,
  type TaskStatus,
  type TierConfig,
} from "./types.js";
import {
  captureDiff,
  commitAll,
  createWorktree,
  mergeWorktree,
  removeWorktree,
  type WorktreeRef,
  worktreeExists,
} from "./worktree.js";

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

export type DriveStopCode =
  | "completed"
  | "aborted"
  | "plan_gate"
  | "budget_blocked"
  | "attempt_cap"
  | "blocked"
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
}

export type DriveRoundPhase = "run" | "review";
export type DriveRoundUpdate = (round: number, phase: DriveRoundPhase, taskIds: string[]) => void;

const DRIVE_ROUND_LIMIT = 20;

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

export async function driveBoard(options: {
  cwd: string;
  config: MaestroConfig;
  resolvedTiers: Map<string, TierConfig>;
  taskIds?: string[];
  startExecutor: StartExecutor;
  signal?: AbortSignal;
  onUpdate: WorkflowUpdate;
  onRoundUpdate?: DriveRoundUpdate;
  trackRun: TrackRun;
}): Promise<DriveSummary> {
  const {
    cwd,
    config,
    resolvedTiers,
    taskIds,
    startExecutor,
    signal,
    onUpdate,
    onRoundUpdate,
    trackRun,
  } = options;
  const selectedIds = taskIds ? new Set(taskIds) : undefined;
  let rounds = 0;

  const selectedTasks = (): Task[] => {
    const board = loadBoard(cwd);
    return selectedIds ? board.tasks.filter((task) => selectedIds.has(task.id)) : board.tasks;
  };
  const finish = (stoppedBecause: DriveStopReason): DriveSummary => ({
    rounds,
    tasks: loadBoard(cwd).tasks.map((task) => snapshot(task)),
    stoppedBecause,
  });

  try {
    while (rounds < DRIVE_ROUND_LIMIT) {
      if (signal?.aborted) {
        return finish({ code: "aborted", message: "drive aborted by user" });
      }

      const board = loadBoard(cwd);
      const tasks = selectedIds
        ? board.tasks.filter((task) => selectedIds.has(task.id))
        : board.tasks;
      if (tasks.every((task) => task.status === "approved")) {
        return finish({ code: "completed", message: "all selected tasks are approved" });
      }
      if (board.planPending) {
        return finish({
          code: "plan_gate",
          message: "plan approval is pending; review it with /maestro plan",
        });
      }

      rounds += 1;
      const capped = tasks.filter(
        (task) =>
          task.attempts.filter((attempt) => !attempt.providerFailure).length >=
            config.maxAttempts && task.status !== "approved"
      );
      const runnable = tasks.filter(
        (task) =>
          !capped.includes(task) &&
          task.status !== "cancelled" &&
          isRunnable(board, task, task.status === "failed")
      );
      const budgetWarning =
        runnable.length > 0 ? runBudgetWarning(board.tasks, config.maxRunCost) : undefined;

      if (runnable.length > 0 && !budgetWarning) {
        onRoundUpdate?.(
          rounds,
          "run",
          runnable.map((task) => task.id)
        );
        const worktrees = new Map<string, WorktreeRef>();
        const created: WorktreeRef[] = [];
        const isolateBatch = config.useWorktrees && runnable.length > 1;
        try {
          for (const task of runnable) {
            const previous = task.attempts.at(-1);
            const retained =
              task.status === "changes_requested" &&
              previous?.worktreePath &&
              previous.branch &&
              worktreeExists({
                worktreePath: previous.worktreePath,
                branch: previous.branch,
              })
                ? { worktreePath: previous.worktreePath, branch: previous.branch }
                : undefined;
            if (retained) {
              worktrees.set(task.id, retained);
            } else if (isolateBatch) {
              const ref = createWorktree(cwd, task.id, task.attempts.length + 1);
              created.push(ref);
              worktrees.set(task.id, ref);
            }
          }
        } catch (error) {
          for (const ref of created) removeWorktree(cwd, ref);
          throw error;
        }

        await mapWithConcurrencyLimit(runnable, config.maxParallel, (task) => {
          const tier = resolvedTiers.get(task.tier);
          if (!tier) throw new Error(`No resolved tier for "${task.tier}"`);
          const executeOptions: Parameters<typeof executeTask>[0] = {
            cwd,
            board,
            task,
            tier,
            config,
            startExecutor,
            onUpdate,
            trackRun,
          };
          const worktree = worktrees.get(task.id);
          if (worktree) executeOptions.worktree = worktree;
          if (signal) executeOptions.signal = signal;
          return executeTask(executeOptions);
        });
      }

      if (signal?.aborted) {
        return finish({ code: "aborted", message: "drive aborted by user" });
      }

      const afterRuns = loadBoard(cwd);
      const reviewable = afterRuns.tasks.filter(
        (task) => task.status === "ready_for_review" && (!selectedIds || selectedIds.has(task.id))
      );
      if (reviewable.length > 0) {
        onRoundUpdate?.(
          rounds,
          "review",
          reviewable.map((task) => task.id)
        );
        const reviewTier = resolvedTiers.get("review");
        if (!reviewTier) throw new Error('No resolved tier for "review"');
        await mapWithConcurrencyLimit(reviewable, config.maxParallel, (task) => {
          const reviewOptions: Parameters<typeof reviewTask>[0] = {
            cwd,
            task,
            tier: reviewTier,
            startExecutor,
            autoCommit: config.autoCommit,
            onUpdate,
            trackRun,
          };
          if (signal) reviewOptions.signal = signal;
          return reviewTask(reviewOptions);
        });
      }

      if (budgetWarning) {
        return finish({ code: "budget_blocked", message: budgetWarning });
      }

      const freshTasks = selectedTasks();
      if (freshTasks.every((task) => task.status === "approved")) {
        return finish({ code: "completed", message: "all selected tasks are approved" });
      }
      const attemptCapped = freshTasks.filter(
        (task) =>
          task.status !== "approved" &&
          task.attempts.filter((attempt) => !attempt.providerFailure).length >= config.maxAttempts
      );
      if (attemptCapped.length > 0) {
        return finish({
          code: "attempt_cap",
          message: `attempt cap reached (${config.maxAttempts}) for ${attemptCapped.map((task) => task.id).join(", ")}`,
          taskIds: attemptCapped.map((task) => task.id),
        });
      }

      const freshBoard = loadBoard(cwd);
      const canContinue = freshTasks.some(
        (task) =>
          task.status === "ready_for_review" ||
          (task.status !== "cancelled" && isRunnable(freshBoard, task, task.status === "failed"))
      );
      if (!canContinue) {
        const terminal = freshTasks.filter((task) => task.status !== "approved");
        return finish({
          code: "blocked",
          message: `no further tasks can run or be reviewed: ${terminal.map((task) => `${task.id} (${task.status})`).join(", ")}`,
          taskIds: terminal.map((task) => task.id),
        });
      }
    }
  } catch (error) {
    return finish({
      code: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return finish({
    code: "round_limit",
    message: `drive stopped after the hard limit of ${DRIVE_ROUND_LIMIT} rounds`,
  });
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
      sessionLabel: sessionLabel(task, "attempt", attemptIndex),
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
    run.attempt.touchedFiles = outcome.touchedFiles;

    const status: TaskStatus = outcome.aborted
      ? "cancelled"
      : outcome.exitCode !== 0 || outcome.errorMessage
        ? "failed"
        : "ready_for_review";
    // Dead on arrival (zero turns) or the provider died mid-run from an
    // exhausted quota: neither is the task's fault. Such attempts do not
    // consume maxAttempts budget and fall back to the next model when one
    // is configured — retrying the same exhausted provider is pointless.
    const quotaFailure =
      outcome.usage.turns > 0 &&
      /usage limit|rate limit|quota|too many requests|resource.?exhausted/i.test(
        outcome.errorMessage ?? ""
      );
    const providerFailure =
      status === "failed" &&
      (outcome.usage.turns === 0 || quotaFailure) &&
      !outcome.aborted &&
      !outcome.errorMessage?.startsWith("cost cap exceeded:") &&
      models.length > 1;
    const canFallback = providerFailure && modelIndex < models.length - 1;
    if (providerFailure) run.attempt.providerFailure = true;

    if (status === "ready_for_review") {
      try {
        const paths = worktree ? undefined : run.attempt.touchedFiles;
        const diff = captureDiff(worktree?.worktreePath ?? cwd, paths);
        if (diff) run.attempt.diff = diff;
      } catch {
        // Diff context is best-effort and must never change the executor outcome.
      }
    }

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

/** Session picker name: "T3 add replay command · attempt 2" beats "maestro T3-attempt-2". */
export function sessionLabel(task: Task, kind: "attempt" | "review", index: number): string {
  const title = task.title.length > 40 ? `${task.title.slice(0, 40)}…` : task.title;
  return `${task.id} ${title} · ${kind} ${index}`;
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
    sessionLabel: sessionLabel(task, "review", task.attempts.length),
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
