import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  findTask,
  forceStatus,
  isRunnable,
  loadBoard,
  planValidationMessage,
  stateDir,
  transition,
  updateTask,
  validatePlan,
} from "./board.js";
import { resolveTierModels } from "./config.js";
import { runBudgetWarning, taskUsage, truncateText } from "./format.js";
import { buildExecutorPrompt, buildReviewPrompt, parseVerdict } from "./prompts.js";
import {
  classifyFailure,
  type ExecutorHandle,
  mapWithConcurrencyLimit,
  providerFromModel,
  type RunOutcome,
  type RunUpdate,
  redactFailureMessage,
} from "./runner.js";
import {
  type Attempt,
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
  reviewNotes?: string;
}

export interface TaskSnapshot {
  id: string;
  title: string;
  status: TaskStatus;
  tier: string;
  attempts: number;
  cost: number;
  turns: number;
  history: AttemptSnapshot[];
  retryAction?: string;
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
  | "paused"
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

export function formatDriveSummary(summary: DriveSummary): string {
  const approved = summary.tasks.filter((task) => task.status === "approved").length;
  const failed = summary.tasks.filter((task) => task.status === "failed").length;
  const cancelled = summary.tasks.filter((task) => task.status === "cancelled").length;
  const blocked = summary.tasks.length - approved - failed - cancelled;
  const attempts = summary.tasks.reduce((total, task) => total + task.attempts, 0);
  const totalCost = summary.tasks.reduce((total, task) => total + task.cost, 0);
  const billedAttempts = summary.tasks
    .flatMap((task) => task.history)
    .filter((item) => item.cost > 0);
  const averageCost =
    billedAttempts.length === 0
      ? 0
      : billedAttempts.reduce((total, item) => total + item.cost, 0) / billedAttempts.length;
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

  return [
    `Drive ${summary.stoppedBecause.code} after ${summary.rounds} round(s): ${approved} approved · ${failed} failed · ${cancelled} cancelled · ${blocked} blocked`,
    `${attempts} attempt${attempts === 1 ? "" : "s"} · $${totalCost.toFixed(4)} total · $${averageCost.toFixed(4)} avg billed attempt`,
    ...identity,
    summary.stoppedBecause.message,
  ].join("\n");
}

export type DriveRoundPhase = "run" | "review";
export type DriveRoundUpdate = (round: number, phase: DriveRoundPhase, taskIds: string[]) => void;

const DRIVE_ROUND_LIMIT = 20;

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
    if (attempt.reviewNotes !== undefined) item.reviewNotes = attempt.reviewNotes;
    return item;
  });
  const result: TaskSnapshot = {
    id: task.id,
    title: task.title,
    status: task.status,
    tier: task.tier,
    attempts: task.attempts.length,
    cost: usage.cost,
    turns: usage.turns,
    history,
  };

  if (
    task.status === "failed" ||
    task.status === "cancelled" ||
    task.status === "changes_requested"
  ) {
    result.retryAction = `maestro_run ["${task.id}"]`;
  } else if (task.status === "ready_for_review" && task.attempts.at(-1)?.failureReason) {
    result.retryAction = `maestro_review ["${task.id}"]`;
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
  shouldPause?: () => boolean;
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
    shouldPause,
    onUpdate,
    onRoundUpdate,
    trackRun,
  } = options;
  // Task ids are matched case-insensitively (see findTask), so normalize both
  // the requested ids and each task id before comparing. Comparing raw ids here
  // would silently drop lowercase/whitespace variants and dispatch nothing.
  const selectedIds = taskIds ? new Set(taskIds.map((id) => id.trim().toUpperCase())) : undefined;
  const isSelected = (task: Task): boolean =>
    selectedIds === undefined || selectedIds.has(task.id.trim().toUpperCase());
  let rounds = 0;

  const selectedTasks = (): Task[] => loadBoard(cwd).tasks.filter(isSelected);
  const finish = (stoppedBecause: DriveStopReason): DriveSummary => ({
    rounds,
    tasks: selectedTasks().map((task) => snapshot(task)),
    stoppedBecause,
  });

  try {
    while (rounds < DRIVE_ROUND_LIMIT) {
      if (signal?.aborted) {
        return finish({ code: "aborted", message: "drive aborted by user" });
      }

      const board = loadBoard(cwd);
      const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
      if (validationError) return finish({ code: "error", message: validationError });

      const tasks = board.tasks.filter(isSelected);
      if (tasks.every((task) => task.status === "approved")) {
        return finish({ code: "completed", message: "all selected tasks are approved" });
      }
      if (board.planPending) {
        return finish({
          code: "plan_gate",
          message: "plan approval is pending; review it with /maestro plan",
        });
      }
      if (shouldPause?.()) {
        return finish({
          code: "paused",
          message: "drive paused before starting the next executor batch",
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
      if (shouldPause?.()) {
        return finish({
          code: "paused",
          message: "drive paused after active executors finished",
        });
      }

      const afterRuns = loadBoard(cwd);
      const reviewable = afterRuns.tasks.filter(
        (task) => task.status === "ready_for_review" && isSelected(task)
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
            availableTiers: Object.keys(config.tiers),
            onUpdate,
            trackRun,
          };
          if (signal) reviewOptions.signal = signal;
          return reviewTask(reviewOptions);
        });
      }

      if (signal?.aborted) {
        return finish({ code: "aborted", message: "drive aborted by user" });
      }

      const freshTasks = selectedTasks();
      if (freshTasks.every((task) => task.status === "approved")) {
        return finish({ code: "completed", message: "all selected tasks are approved" });
      }
      if (shouldPause?.()) {
        return finish({
          code: "paused",
          message: "drive paused after active executors finished",
        });
      }
      if (budgetWarning) {
        return finish({ code: "budget_blocked", message: budgetWarning });
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

  const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
  if (validationError) throw new Error(validationError);
  if (board.planPending) throw new Error("Plan approval is pending.");

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
    if (run.attempt.model === undefined && model !== undefined) run.attempt.model = model;
    const selectedProvider = providerFromModel(run.attempt.model);
    if (run.attempt.provider === undefined && selectedProvider !== undefined) {
      run.attempt.provider = selectedProvider;
    }
    if (run.attempt.model === undefined && model !== undefined) run.attempt.model = model;
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

    let outcome: RunOutcome;
    try {
      outcome = await run.outcome;
    } catch (error) {
      outcome = rejectedRunOutcome(run, error);
      run.attempt.endedAt = Date.now();
    } finally {
      untrack();
    }
    if (outcome.finalReport) run.attempt.finalReport = outcome.finalReport;
    if (outcome.model !== undefined) run.attempt.model = outcome.model;
    const provider = providerFromModel(run.attempt.model);
    if (provider !== undefined) run.attempt.provider = provider;
    if (outcome.errorMessage) run.attempt.errorMessage = redactFailureMessage(outcome.errorMessage);
    run.attempt.exitCode = outcome.exitCode;
    run.attempt.usage = { ...outcome.usage };
    run.attempt.touchedFiles = [...outcome.touchedFiles];

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
    // Zero-turn failures keep the historical fallback/max-attempt accounting,
    // but an explicit process cause must remain an executor failure in history.
    const outcomeForClassification =
      providerFailure && outcome.failureCause === undefined
        ? { ...outcome, failureCause: "provider" as const }
        : outcome;
    const failureReason = classifyFailure(outcomeForClassification);
    if (failureReason) run.attempt.failureReason = failureReason;

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

    const note =
      status === "failed" || outcome.aborted ? run.attempt.failureReason?.message : undefined;
    return snapshot(updated ?? task, note);
  }

  return snapshot(updated ?? task);
}

function rejectedRunOutcome(run: ExecutorHandle, error: unknown): RunOutcome {
  const message = redactFailureMessage(error instanceof Error ? error.message : String(error));
  const outcome: RunOutcome = {
    exitCode: 1,
    usage: { ...run.attempt.usage },
    finalReport: run.attempt.finalReport ?? "",
    touchedFiles: [...run.attempt.touchedFiles],
    aborted: false,
    errorMessage: message,
    failureCause: "process",
  };
  if (run.attempt.model !== undefined) outcome.model = run.attempt.model;
  const failureReason = classifyFailure(outcome);
  if (failureReason) outcome.failureReason = failureReason;
  return outcome;
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
  availableTiers?: Iterable<string>;
  signal?: AbortSignal;
  onUpdate: WorkflowUpdate;
  trackRun: TrackRun;
}): Promise<TaskSnapshot> {
  const { cwd, task, tier, startExecutor, autoCommit, availableTiers, signal, onUpdate, trackRun } =
    options;
  const board = loadBoard(cwd);
  const validationError = planValidationMessage(validatePlan(board, availableTiers));
  if (validationError) throw new Error(validationError);
  if (board.planPending) throw new Error("Plan approval is pending.");

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
  if (run.attempt.model === undefined && tier.model !== undefined) run.attempt.model = tier.model;
  const untrack = trackRun({
    taskId: task.id,
    kind: "review",
    turns: 0,
    cost: 0,
    lastActivity: "starting…",
    handle: run,
  });

  let outcome: RunOutcome;
  try {
    outcome = await run.outcome;
  } catch (error) {
    outcome = rejectedRunOutcome(run, error);
    run.attempt.endedAt = Date.now();
  } finally {
    untrack();
  }

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
      attempt.reviewUsage = { ...outcome.usage };
      const reviewModel = outcome.model ?? run.attempt.model;
      if (reviewModel !== undefined) {
        attempt.reviewModel = reviewModel;
        const reviewProvider = providerFromModel(reviewModel);
        if (reviewProvider !== undefined) attempt.reviewProvider = reviewProvider;
      }
      // Keep the full review report and session for post-hoc inspection.
      if (outcome.finalReport) attempt.reviewReport = outcome.finalReport;
      if (run.attempt.sessionFile) attempt.reviewSessionFile = run.attempt.sessionFile;

      // startExecutor classifies its own process failures in executor terms.
      // Reclassify from the raw outcome here so the persisted reason reflects
      // that this run was a review, while preserving provider/abort/cap causes.
      const reviewFailure =
        classifyFailure(outcome, "review") ??
        outcome.failureReason ??
        (!verdict
          ? {
              kind: "reviewer_failure" as const,
              message: "reviewer gave no VERDICT line",
              retryable: true,
            }
          : undefined);
      if (reviewFailure) attempt.failureReason = reviewFailure;
    }
    if (!verdict) return; // aborted/failed/no verdict: stays ready_for_review
    if (verdict.approved) {
      transition(fresh, "approved");
      delete fresh.reviewNotes;
    } else {
      const notes = verdict.notes || outcome.finalReport;
      transition(fresh, "changes_requested");
      fresh.reviewNotes = notes;
      if (attempt) {
        attempt.reviewNotes = notes;
        attempt.failureReason = {
          kind: "reviewer_rejection",
          message: redactFailureMessage(notes),
          retryable: true,
        };
      }
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
