import { createHash } from "node:crypto";
import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { artifactFindings } from "./artifact-policy.js";
import {
  claimTaskDispatch,
  findTask,
  forceStatus,
  isRunnable,
  loadBoard,
  planValidationMessage,
  releaseTaskDispatch,
  renewTaskDispatch,
  scopedDependencyGaps,
  stateDir,
  transition,
  updateTask,
  validatePlan,
} from "./board.js";
import { resolveTierModels } from "./config.js";
import { runBudgetWarning, taskUsage, truncateText } from "./format.js";
import {
  accountPromptContext,
  buildExecutorPrompt,
  buildReviewPrompt,
  parseVerdict,
} from "./prompts.js";
import { pruneTaskLogs } from "./retention.js";
import {
  classifyFailure,
  type ExecutorHandle,
  mapWithConcurrencyLimit,
  providerFromModel,
  type RunOutcome,
  type RunUpdate,
  redactFailureMessage,
  runVerification,
} from "./runner.js";
import {
  type Attempt,
  type Board,
  type MaestroConfig,
  type ReviewLaunch,
  type Task,
  type TaskStatus,
  type TierConfig,
  type VerificationProfile,
} from "./types.js";
import {
  artifactMatchesCommit,
  captureDiff,
  changedPaths,
  commitAll,
  commitTree,
  createWorktree,
  headCommit,
  mergeWorktree,
  removeWorktree,
  snapshotArtifact,
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

type DispatchKind = "execute" | "review";

function claimDispatchLifecycle(
  cwd: string,
  taskId: string,
  kind: DispatchKind,
  dispatchable: Parameters<typeof claimTaskDispatch>[3]
) {
  const dispatch = claimTaskDispatch(cwd, taskId, kind, dispatchable);
  if (!dispatch?.claimed) return { dispatch };

  const renewal = setInterval(() => {
    renewTaskDispatch(cwd, taskId, dispatch.claimId);
  }, 10_000);
  renewal.unref();
  let closed = false;

  return {
    dispatch,
    release: () => {
      if (closed) return;
      closed = true;
      clearInterval(renewal);
      releaseTaskDispatch(cwd, taskId, dispatch.claimId);
    },
  };
}

export type DriveStopCode =
  | "completed"
  | "aborted"
  | "paused"
  | "plan_gate"
  | "budget_blocked"
  | "provider_blocked"
  | "escalation_required"
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
  const launches = summary.tasks.reduce(
    (total, task) => total + (task.launches ?? task.history.length),
    0
  );
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
    `${attempts} consuming attempt${attempts === 1 ? "" : "s"} · ${launches} launch${launches === 1 ? "" : "es"} · $${totalCost.toFixed(4)} total · $${averageCost.toFixed(4)} avg billed launch`,
    ...identity,
    summary.stoppedBecause.message,
  ].join("\n");
}

export type DriveRoundPhase = "run" | "review";
export type DriveRoundUpdate = (round: number, phase: DriveRoundPhase, taskIds: string[]) => void;

const DRIVE_ROUND_LIMIT = 20;

/** Consecutive genuine reviewer rejections before the drive escalates instead of retrying. */
const REVIEW_REJECTION_LIMIT = 2;

/** Built-in tiers, cheapest first, used to recommend the next rung on escalation. */
const TIER_LADDER = ["trivial", "standard", "complex"] as const;

function consumesMaxAttempt(attempt: Attempt): boolean {
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
    launches: task.attempts.length,
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

export interface SchedulingWave {
  runnableIds: string[];
  reviewableIds: string[];
  cappedIds: string[];
  blockedIds: string[];
}

export function calculateSchedulingWave(
  board: Board,
  config: MaestroConfig,
  taskIds?: string[]
): SchedulingWave {
  const selected = taskIds ? new Set(taskIds.map((id) => id.trim().toUpperCase())) : undefined;
  const tasks = board.tasks.filter(
    (task) => selected === undefined || selected.has(task.id.trim().toUpperCase())
  );
  const capped = tasks.filter(
    (task) =>
      task.attempts.filter(consumesMaxAttempt).length >= config.maxAttempts &&
      task.status !== "approved"
  );
  const runnable = tasks.filter(
    (task) =>
      !capped.includes(task) &&
      task.status !== "cancelled" &&
      isRunnable(board, task, task.status === "failed")
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
    const wave = calculateSchedulingWave(simulated, config, taskIds);
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
  isLive?: (taskId: string) => boolean;
  onRetentionWarning?: (warning: string) => void;
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
    isLive = () => false,
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
      // Stop before re-dispatching a task the reviewer has rejected twice; a
      // fresh drive or /maestro resume only continues after the orchestrator
      // changes the brief/tier (which resets the counter) or retries explicitly.
      const escalated = tasks.filter(escalatedTask);
      if (escalated.length > 0) return finish(escalationReason(escalated, config));

      rounds += 1;
      const wave = calculateSchedulingWave(board, config, taskIds);
      const runnable = tasks.filter((task) => wave.runnableIds.includes(task.id));
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
        const isolateBatch = config.useWorktrees;
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
      // Only execute-side provider blocks stop the drive here; a stale review
      // provider failure must fall through so the review phase can re-run it.
      const blockedAfterRuns = afterRuns.tasks.filter(
        (task) => isSelected(task) && task.status === "failed" && providerBlockedTask(task)
      );
      if (blockedAfterRuns.length > 0) {
        return finish(providerBlockedReason(blockedAfterRuns));
      }
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
            isLive,
          };
          if (config.verificationProfiles)
            reviewOptions.verificationProfiles = config.verificationProfiles;
          if (config.logEvents !== undefined) reviewOptions.logEvents = config.logEvents;
          if (config.maxLogBytesPerRun !== undefined)
            reviewOptions.maxLogBytes = config.maxLogBytesPerRun;
          if (options.onRetentionWarning)
            reviewOptions.onRetentionWarning = options.onRetentionWarning;
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
      const providerBlocked = freshTasks.filter(providerBlockedTask);
      if (providerBlocked.length > 0) {
        return finish(providerBlockedReason(providerBlocked));
      }

      const attemptCapped = freshTasks.filter(
        (task) =>
          task.status !== "approved" &&
          task.attempts.filter(consumesMaxAttempt).length >= config.maxAttempts
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

function escalatedTask(task: Task): boolean {
  return (
    task.status === "changes_requested" && (task.reviewRejections ?? 0) >= REVIEW_REJECTION_LIMIT
  );
}

function escalationReason(tasks: Task[], config: MaestroConfig): DriveStopReason {
  const details = tasks.map((task) => {
    const notes = task.reviewNotes ?? task.attempts.at(-1)?.reviewNotes;
    const evidence = notes
      ? redactFailureMessage(truncateText(notes, 3))
      : "no reviewer notes recorded";
    const rung = TIER_LADDER.indexOf(task.tier as (typeof TIER_LADDER)[number]);
    const nextTier =
      rung >= 0 ? TIER_LADDER.slice(rung + 1).find((name) => config.tiers[name]) : undefined;
    const action = nextTier
      ? `raise the tier to "${nextTier}" with maestro_update`
      : "rewrite, split, or cancel the brief with maestro_update and apply orchestrator judgment";
    return `${task.id} [tier ${task.tier}]: ${evidence}\n  → ${action}`;
  });
  return {
    code: "escalation_required",
    message: `Reviewer rejected the same work ${REVIEW_REJECTION_LIMIT} times; autonomous retries stopped for orchestrator intervention.\n${details.join("\n")}\nAfter changing the brief/tier (which resets the counter) or an explicit scoped maestro_drive, use /maestro resume.`,
    taskIds: tasks.map((task) => task.id),
  };
}

function providerBlockedTask(task: Task): boolean {
  const latest = task.attempts.at(-1);
  if (!latest) return false;
  if (task.status === "failed") return !consumesMaxAttempt(latest);
  if (task.status !== "ready_for_review") return false;
  return latest.reviewLaunches?.at(-1)?.failureReason?.kind === "provider_failure";
}

function providerBlockedReason(tasks: Task[]): DriveStopReason {
  const details = tasks.map((task) => {
    const attempt = task.attempts.at(-1);
    const reviewFailure = attempt?.reviewLaunches?.at(-1);
    const model = reviewFailure?.model ?? attempt?.model ?? "configured model";
    const provider = reviewFailure?.provider ?? attempt?.provider;
    const identity = provider ? `${model} (${provider})` : model;
    const message = reviewFailure?.failureReason?.message ?? attempt?.failureReason?.message;
    return `${task.id}: ${identity}${message ? ` — ${redactFailureMessage(message)}` : ""}`;
  });
  return {
    code: "provider_blocked",
    message: `Provider access blocked; autonomous retries stopped. ${details.join("; ")}\nCheck provider quota/authentication, configure another fallback in /maestro config, then use /maestro resume (or explicitly retry the task).`,
    taskIds: tasks.map((task) => task.id),
  };
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

  const consumedAttempts = task.attempts.filter(consumesMaxAttempt).length;
  if (consumedAttempts >= config.maxAttempts) {
    const updated = updateTask(cwd, task.id, (fresh) => {
      forceStatus(fresh, "failed");
    });
    const recoveryGuidance = `attempt cap reached (${config.maxAttempts}); create a narrowly scoped successor with maestro_plan, use maestro_update to rewire every downstream dependency to it, then start maestro_drive with an explicit taskIds list containing the successor and every rewired dependent while excluding this capped predecessor`;
    const result = snapshot(updated ?? task, recoveryGuidance);
    delete result.retryAction;
    result.note = recoveryGuidance;
    return result;
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
    const lifecycle = claimDispatchLifecycle(cwd, task.id, "execute", (freshBoard, freshTask) =>
      isRunnable(freshBoard, freshTask, true)
    );
    const { dispatch } = lifecycle;
    if (!dispatch?.claimed || dispatch.attemptIndex === undefined || !lifecycle.release) {
      return snapshot(dispatch?.task ?? task, dispatch?.note ?? "execute dispatch declined");
    }
    const attemptIndex = dispatch.attemptIndex;
    const attemptTier: TierConfig = { ...tier };
    delete attemptTier.fallbacks;
    if (model === undefined) delete attemptTier.model;
    else attemptTier.model = model;

    const prompt = buildExecutorPrompt(task, dependencyReports);
    const promptContext = accountPromptContext(prompt);
    const runOptions: Parameters<StartExecutor>[0] = {
      stateDir: stateDir(cwd),
      runId: `${task.id}-attempt-${attemptIndex}`,
      cwd: worktree?.worktreePath ?? cwd,
      prompt,
      tier: attemptTier,
      sessionLabel: sessionLabel(task, "attempt", attemptIndex),
      ...(config.logEvents === undefined ? {} : { logEvents: config.logEvents }),
      ...(config.maxLogBytesPerRun === undefined ? {} : { maxLogBytes: config.maxLogBytesPerRun }),
      ...(config.watchdogIdleSeconds === undefined
        ? {}
        : { watchdogIdleSeconds: config.watchdogIdleSeconds }),
      ...(config.watchdogWarningTurns === undefined
        ? {}
        : { watchdogWarningTurns: config.watchdogWarningTurns }),
      ...(config.watchdogTerminationTurns === undefined
        ? {}
        : { watchdogTerminationTurns: config.watchdogTerminationTurns }),
      onUpdate: (update) => {
        const sessionFile = update.sessionFile;
        if (sessionFile) {
          updateTask(cwd, task.id, (fresh) => {
            const attempt = fresh.attempts.find((candidate) => candidate.index === attemptIndex);
            if (attempt) attempt.sessionFile = sessionFile;
          });
        }
        onUpdate(task.id, update);
      },
    };
    if (signal) runOptions.signal = signal;
    if (config.maxCostPerTask > 0) runOptions.maxCost = config.maxCostPerTask;

    let run: ExecutorHandle;
    try {
      run = startExecutor(runOptions);
    } catch (error) {
      const message = redactFailureMessage(error instanceof Error ? error.message : String(error));
      const failed = updateTask(cwd, task.id, (fresh) => {
        const attempt = fresh.attempts.find((candidate) => candidate.index === attemptIndex);
        if (attempt) {
          attempt.endedAt = Date.now();
          attempt.exitCode = 1;
          attempt.errorMessage = message;
          attempt.consumesAttempt = true;
          attempt.failureReason = { kind: "executor_failure", message, retryable: true };
        }
        forceStatus(fresh, "failed");
      });
      lifecycle.release();
      return snapshot(failed ?? task, message);
    }
    run.attempt.index = attemptIndex;
    run.attempt.promptCharacters = promptContext.characters;
    run.attempt.promptApproximateTokens = promptContext.approximateTokens;
    run.attempt.promptSections = promptContext.sections;
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
      const reserved = fresh.attempts.findIndex((attempt) => attempt.index === attemptIndex);
      if (reserved >= 0) fresh.attempts[reserved] = run.attempt;
    });

    let outcome: RunOutcome;
    try {
      outcome = await run.outcome;
    } catch (error) {
      outcome = rejectedRunOutcome(run, error);
      run.attempt.endedAt = Date.now();
    } finally {
      lifecycle.release();
      untrack();
    }
    if (outcome.finalReport) run.attempt.finalReport = outcome.finalReport;
    if (outcome.model !== undefined) run.attempt.model = outcome.model;
    const provider = providerFromModel(run.attempt.model);
    if (provider !== undefined) run.attempt.provider = provider;
    if (outcome.errorMessage) run.attempt.errorMessage = redactFailureMessage(outcome.errorMessage);
    run.attempt.exitCode = outcome.exitCode;
    run.attempt.usage = { ...outcome.usage };
    run.attempt.touchedFiles =
      worktree && worktreeExists(worktree)
        ? changedPaths(worktree.worktreePath)
        : [...outcome.touchedFiles];

    const status: TaskStatus = outcome.aborted
      ? "cancelled"
      : outcome.exitCode !== 0 || outcome.errorMessage
        ? "failed"
        : "ready_for_review";
    const classifiedFailure = classifyFailure(outcome);
    // Legacy/test executors may omit failureCause. A zero-turn launch is still
    // treated as provider setup failure unless it carries an explicit process cause.
    const inferredProviderFailure =
      status === "failed" &&
      outcome.usage.turns === 0 &&
      outcome.failureCause === undefined &&
      classifiedFailure?.kind === "executor_failure";
    const providerFailure =
      status === "failed" &&
      !outcome.aborted &&
      (classifiedFailure?.kind === "provider_failure" || inferredProviderFailure);
    const canFallback = providerFailure && modelIndex < models.length - 1;
    run.attempt.consumesAttempt = !providerFailure;
    if (providerFailure) run.attempt.providerFailure = true;
    const failureReason = inferredProviderFailure
      ? classifyFailure({ ...outcome, failureCause: "provider" })
      : classifiedFailure;
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

export { artifactFindings } from "./artifact-policy.js";

export async function reviewTask(options: {
  cwd: string;
  task: Task;
  tier: TierConfig;
  startExecutor: StartExecutor;
  autoCommit?: boolean;
  logEvents?: "compact" | "full" | undefined;
  maxLogBytes?: number | undefined;
  availableTiers?: Iterable<string>;
  verificationProfiles?: Record<string, VerificationProfile>;
  signal?: AbortSignal;
  onUpdate: WorkflowUpdate;
  trackRun: TrackRun;
  isLive?: (taskId: string) => boolean;
  onRetentionWarning?: (warning: string) => void;
}): Promise<TaskSnapshot> {
  const {
    cwd,
    task,
    tier,
    startExecutor,
    autoCommit,
    logEvents,
    maxLogBytes,
    availableTiers,
    verificationProfiles,
    signal,
    onUpdate,
    trackRun,
    isLive = () => false,
  } = options;
  const board = loadBoard(cwd);
  const validationError = planValidationMessage(validatePlan(board, availableTiers));
  if (validationError) throw new Error(validationError);
  if (board.planPending) throw new Error("Plan approval is pending.");

  const report = lastReport(task);
  if (!report) return snapshot(task, "no executor report to review");
  const latestAttempt = task.attempts.at(-1);
  const configuredProfile = task.verificationProfile
    ? verificationProfiles?.[task.verificationProfile]
    : undefined;
  if (task.verificationProfile && !configuredProfile) {
    throw new Error(`Unknown verification profile: ${task.verificationProfile}`);
  }

  const lifecycle = claimDispatchLifecycle(
    cwd,
    task.id,
    "review",
    (_freshBoard, freshTask) => freshTask.status === "ready_for_review"
  );
  const { dispatch } = lifecycle;
  if (!dispatch?.claimed || !lifecycle.release) {
    return snapshot(dispatch?.task ?? task, dispatch?.note ?? "review dispatch declined");
  }

  try {
    const candidatePaths = latestAttempt?.touchedFiles ?? [];
    const candidateCwd = latestAttempt?.worktreePath ?? cwd;
    // Legacy/injected workflow harnesses may not provide a Git integration surface.
    // Every production auto-commit or worktree review requires full provenance.
    const requiresIntegration = Boolean(latestAttempt?.worktreePath || autoCommit);
    const candidateTree = snapshotArtifact(candidateCwd, candidatePaths);
    if (candidateTree) {
      const capturedAt = Date.now();
      task.provenance = { candidateTree, capturedAt };
      updateTask(cwd, task.id, (fresh) => {
        fresh.provenance = { candidateTree, capturedAt };
      });
    }

    let candidateVerification: Awaited<ReturnType<typeof runVerification>> | undefined;
    if (configuredProfile) {
      candidateVerification = await runVerification({
        cwd: latestAttempt?.worktreePath ?? cwd,
        stateDir: stateDir(cwd),
        name: `${task.id}-candidate`,
        command: configuredProfile.command,
        timeoutSeconds: configuredProfile.timeoutSeconds,
        ...(signal ? { signal } : {}),
      });
    }
    const gateFindings = latestAttempt ? (artifactFindings(task, latestAttempt) ?? []) : [];
    if (requiresIntegration && !candidateTree) {
      gateFindings.push({
        fingerprint: "artifact-snapshot-failed",
        message: "No authoritative Git artifact could be captured for review.",
        status: "open",
        firstAttempt: latestAttempt?.index ?? task.attempts.length,
        lastAttempt: latestAttempt?.index ?? task.attempts.length,
      });
    } else if (snapshotArtifact(candidateCwd, candidatePaths) !== candidateTree) {
      gateFindings.push({
        fingerprint: "artifact-changed",
        message: "Candidate files changed during trusted verification.",
        status: "open",
        firstAttempt: latestAttempt?.index ?? task.attempts.length,
        lastAttempt: latestAttempt?.index ?? task.attempts.length,
      });
    }
    if (candidateVerification && !candidateVerification.ok && latestAttempt) {
      gateFindings?.push({
        fingerprint: "verification-failed",
        message: truncateText(
          `Verification ${task.verificationProfile} failed (exit ${candidateVerification.exitCode}${candidateVerification.timedOut ? ", timeout" : ""}): ${candidateVerification.outputTail}`,
          500
        ),
        status: "open",
        firstAttempt: latestAttempt.index,
        lastAttempt: latestAttempt.index,
      });
    }
    if (gateFindings && gateFindings.length > 0) {
      const notes = gateFindings.map((finding) => finding.message).join("\n");
      const updated = updateTask(cwd, task.id, (fresh) => {
        transition(fresh, "changes_requested");
        fresh.reviewNotes = notes;
        const fingerprints = new Set(gateFindings.map((finding) => finding.fingerprint));
        fresh.findings = [
          ...(fresh.findings ?? []).filter((finding) => !fingerprints.has(finding.fingerprint)),
          ...gateFindings,
        ];
      });
      return snapshot(updated ?? task, notes);
    }
    const reviewedAttempt = task.attempts.at(-1);
    const worktree =
      reviewedAttempt?.worktreePath && reviewedAttempt.branch
        ? { worktreePath: reviewedAttempt.worktreePath, branch: reviewedAttempt.branch }
        : undefined;
    const models = [tier.model, ...(tier.fallbacks ?? [])];
    const reviewLaunches: ReviewLaunch[] = [];
    let run!: ExecutorHandle;
    let outcome!: RunOutcome;

    for (const [modelIndex, model] of models.entries()) {
      const launchTier: TierConfig = { ...tier };
      delete launchTier.fallbacks;
      if (model === undefined) delete launchTier.model;
      else launchTier.model = model;
      const reviewPrompt = buildReviewPrompt(task, report);
      const reviewPromptContext = accountPromptContext(reviewPrompt);
      const runOptions: Parameters<StartExecutor>[0] = {
        stateDir: stateDir(cwd),
        runId: `${task.id}-review-${task.attempts.length}-launch-${modelIndex + 1}`,
        cwd: worktree?.worktreePath ?? cwd,
        prompt: reviewPrompt,
        tier: launchTier,
        sessionLabel: sessionLabel(task, "review", task.attempts.length),
        ...(logEvents === undefined ? {} : { logEvents }),
        ...(maxLogBytes === undefined ? {} : { maxLogBytes }),
        onUpdate: (update) => onUpdate(task.id, update),
      };
      if (signal) runOptions.signal = signal;

      try {
        run = startExecutor(runOptions);
      } catch (error) {
        const message = redactFailureMessage(
          error instanceof Error ? error.message : String(error)
        );
        run = {
          attempt: {
            index: task.attempts.length,
            logFile: "spawn-failed",
            thinking: launchTier.thinking,
            startedAt: Date.now(),
            endedAt: Date.now(),
            usage: { input: 0, output: 0, cost: 0, turns: 0 },
            touchedFiles: [],
            errorMessage: message,
          },
          outcome: Promise.resolve({
            exitCode: 1,
            usage: { input: 0, output: 0, cost: 0, turns: 0 },
            finalReport: "",
            touchedFiles: [],
            aborted: false,
            errorMessage: message,
            failureCause: "process",
          }),
          steer: () => {},
          abort: () => {},
        };
      }
      if (run.attempt.model === undefined && model !== undefined) run.attempt.model = model;
      const untrack = trackRun({
        taskId: task.id,
        kind: "review",
        turns: 0,
        cost: 0,
        lastActivity: "starting…",
        handle: run,
      });

      try {
        outcome = await run.outcome;
      } catch (error) {
        outcome = rejectedRunOutcome(run, error);
        run.attempt.endedAt = Date.now();
      } finally {
        untrack();
      }

      const failureReason = classifyFailure(outcome, "review") ?? outcome.failureReason;
      const launch: ReviewLaunch = {
        startedAt: run.attempt.startedAt,
        usage: { ...outcome.usage },
        exitCode: outcome.exitCode,
        promptCharacters: reviewPromptContext.characters,
        promptApproximateTokens: reviewPromptContext.approximateTokens,
        promptSections: reviewPromptContext.sections,
      };
      const reviewModel = outcome.model ?? run.attempt.model;
      if (reviewModel !== undefined) {
        launch.model = reviewModel;
        const provider = providerFromModel(reviewModel);
        if (provider !== undefined) launch.provider = provider;
      }
      if (run.attempt.endedAt !== undefined) launch.endedAt = run.attempt.endedAt;
      if (run.attempt.sessionFile !== undefined) launch.sessionFile = run.attempt.sessionFile;
      if (outcome.errorMessage) launch.errorMessage = redactFailureMessage(outcome.errorMessage);
      if (failureReason) launch.failureReason = failureReason;
      if (outcome.finalReport) launch.finalReport = outcome.finalReport;
      reviewLaunches.push(launch);

      const canFallback =
        failureReason?.kind === "provider_failure" && modelIndex < models.length - 1;
      if (!canFallback) break;
    }

    let verdict =
      outcome.aborted || outcome.exitCode !== 0 || outcome.errorMessage
        ? undefined
        : parseVerdict(outcome.finalReport);
    const reviewerRequestedChanges = verdict?.approved === false;
    let mechanicalFailure: string | undefined;
    if (candidateTree && snapshotArtifact(candidateCwd, candidatePaths) !== candidateTree) {
      mechanicalFailure = "Candidate files changed while under review; integration was skipped.";
      verdict = { approved: false, notes: mechanicalFailure };
    }
    let mergeConflict: string | undefined;
    let integratedCommit: string | undefined;
    if (verdict?.approved && worktree) {
      const merge = await serializeMainTreeOperation(cwd, () => {
        const result = mergeWorktree(cwd, worktree, taskCommitMessage(task));
        if (result.ok) integratedCommit = headCommit(cwd);
        return result;
      });
      if (!merge.ok) {
        mergeConflict = `Approved review could not be merged because of a git conflict. Recovery worktree: ${worktree.worktreePath}\nBranch: ${worktree.branch}\n${merge.error ?? "Merge failed"}`;
        mechanicalFailure = mergeConflict;
        verdict = { approved: false, notes: mergeConflict };
      }
    } else if (verdict?.approved && autoCommit) {
      const files = reviewedAttempt?.touchedFiles ?? [];
      try {
        const committed = await serializeMainTreeOperation(cwd, () =>
          commitAll(cwd, taskCommitMessage(task), files)
        );
        if (committed) integratedCommit = headCommit(cwd);
        else mechanicalFailure = "The reviewed artifact could not be committed.";
      } catch (error) {
        mechanicalFailure = `The reviewed artifact could not be committed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (mechanicalFailure) verdict = { approved: false, notes: mechanicalFailure };
    } else if (verdict?.approved && requiresIntegration) {
      mechanicalFailure = "Automated approval requires a proven integration commit.";
      verdict = { approved: false, notes: mechanicalFailure };
    }

    let integratedTree: string | undefined;
    if (verdict?.approved && integratedCommit) {
      integratedTree = commitTree(cwd, integratedCommit);
      if (
        candidateTree &&
        !artifactMatchesCommit(cwd, candidateTree, integratedCommit, candidatePaths)
      ) {
        mechanicalFailure = "Integrated commit does not contain the reviewed candidate tree.";
        verdict = { approved: false, notes: mechanicalFailure };
      }
    }

    let integrationVerification: Awaited<ReturnType<typeof runVerification>> | undefined;
    if (verdict?.approved && integratedCommit && configuredProfile) {
      integrationVerification = await runVerification({
        cwd,
        stateDir: stateDir(cwd),
        name: `${task.id}-integrated`,
        command: configuredProfile.command,
        timeoutSeconds: configuredProfile.timeoutSeconds,
        ...(signal ? { signal } : {}),
      });
      if (!integrationVerification.ok) {
        mechanicalFailure = `Post-integration verification ${task.verificationProfile} failed; artifact remains recoverable.`;
        verdict = { approved: false, notes: mechanicalFailure };
      }
    }
    if (verdict?.approved && requiresIntegration && (!candidateTree || !integratedCommit)) {
      mechanicalFailure =
        "Automated approval requires an authoritative Git artifact and proven integration.";
      verdict = { approved: false, notes: mechanicalFailure };
    }

    const updated = updateTask(cwd, task.id, (fresh) => {
      // Reviewer usage is billed against the task for honest per-task cost.
      const attempt = fresh.attempts.at(-1);
      if (attempt) {
        const reviewUsage = reviewLaunches.reduce(
          (total, launch) => ({
            input: total.input + launch.usage.input,
            output: total.output + launch.usage.output,
            cost: total.cost + launch.usage.cost,
            turns: total.turns + launch.usage.turns,
          }),
          { input: 0, output: 0, cost: 0, turns: 0 }
        );
        attempt.usage.input += reviewUsage.input;
        attempt.usage.output += reviewUsage.output;
        attempt.usage.cost += reviewUsage.cost;
        attempt.usage.turns += reviewUsage.turns;
        attempt.reviewUsage = reviewUsage;
        attempt.reviewLaunches = [...(attempt.reviewLaunches ?? []), ...reviewLaunches];
        const latestLaunch = reviewLaunches.at(-1);
        if (latestLaunch?.model !== undefined) attempt.reviewModel = latestLaunch.model;
        if (latestLaunch?.provider !== undefined) attempt.reviewProvider = latestLaunch.provider;
        // Keep the full review report and session for post-hoc inspection.
        if (outcome.finalReport) attempt.reviewReport = outcome.finalReport;
        if (run.attempt.sessionFile) attempt.reviewSessionFile = run.attempt.sessionFile;

        const reviewFailure =
          latestLaunch?.failureReason ??
          (!verdict
            ? {
                kind: "reviewer_failure" as const,
                message: "reviewer gave no VERDICT line",
                retryable: true,
              }
            : undefined);
        if (reviewFailure) attempt.failureReason = reviewFailure;
        else delete attempt.failureReason;
      }
      if (candidateTree && fresh.provenance && integratedCommit) {
        fresh.provenance.integratedCommit = integratedCommit;
        if (integratedTree) fresh.provenance.integratedTree = integratedTree;
      }
      if (!verdict) return; // aborted/failed/no verdict: stays ready_for_review
      if (verdict.approved) {
        transition(fresh, "approved");
        fresh.approvalKind = "reviewed";
        fresh.verificationSummary = configuredProfile
          ? `${task.verificationProfile} passed candidate verification${integrationVerification ? " and post-integration verification" : ""}`
          : integratedCommit
            ? "reviewer approved the integrated artifact"
            : "reviewer approved an unintegrated working-tree artifact";
        delete fresh.reviewedPatchHash;
        if (candidateTree && fresh.provenance) {
          fresh.provenance.reviewedAt = Date.now();
          if (integratedCommit) fresh.provenance.integratedCommit = integratedCommit;
          if (integratedTree) fresh.provenance.integratedTree = integratedTree;
          if (integrationVerification?.ok || (configuredProfile && candidateVerification?.ok)) {
            fresh.provenance.verifiedAt = Date.now();
            if (task.verificationProfile) {
              fresh.provenance.verificationProfile = task.verificationProfile;
            }
          }
        }
        if (integratedCommit) fresh.integratedCommit = integratedCommit;
        else delete fresh.integratedCommit;
        delete fresh.reviewNotes;
        // A chosen intervention succeeded; let a later retry start fresh.
        delete fresh.reviewRejections;
      } else {
        const notes = verdict.notes || outcome.finalReport;
        transition(fresh, "changes_requested");
        fresh.reviewNotes = notes;
        const messages = notes
          .split("\n")
          .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
          .filter(Boolean)
          .slice(0, 8);
        fresh.findings ??= [];
        for (const message of messages) {
          const criterion = message.match(/^criterion\s+(\d+)\s*:/i)?.[1];
          const fingerprint = criterion
            ? `criterion-${criterion}`
            : createHash("sha256")
                .update(message.toLowerCase().replace(/\s+/g, " "))
                .digest("hex")
                .slice(0, 12);
          const existing = fresh.findings.find((finding) => finding.fingerprint === fingerprint);
          if (existing) {
            existing.status = "open";
            existing.lastAttempt = attempt?.index ?? fresh.attempts.length;
          } else {
            fresh.findings.push({
              fingerprint,
              message: redactFailureMessage(message).slice(0, 500),
              status: "open",
              firstAttempt: attempt?.index ?? fresh.attempts.length,
              lastAttempt: attempt?.index ?? fresh.attempts.length,
            });
          }
        }
        fresh.findings = fresh.findings.slice(-16);
        // Mechanical artifact, merge, commit, and verification failures are not
        // reviewer judgments and must not advance rejection escalation.
        if (reviewerRequestedChanges && !mechanicalFailure) {
          fresh.reviewRejections = (fresh.reviewRejections ?? 0) + 1;
        }
        if (attempt) {
          attempt.reviewNotes = notes;
          attempt.failureReason = mechanicalFailure
            ? { kind: "reviewer_failure", message: redactFailureMessage(notes), retryable: true }
            : {
                kind: "reviewer_rejection",
                message: redactFailureMessage(notes),
                retryable: true,
              };
        }
      }
    });

    const result = updated ?? task;
    if (result.status === "approved") {
      if (worktree) {
        await serializeMainTreeOperation(cwd, () => removeWorktree(cwd, worktree));
      }
      const cleanup = pruneTaskLogs(cwd, result.id, () => loadBoard(cwd), isLive);
      for (const warning of cleanup.warnings) options.onRetentionWarning?.(warning);
    }
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
  } finally {
    lifecycle.release();
  }
}
