import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  artifactFindings,
  captureApprovedProvenance,
  completionFreshness,
  taskFingerprint,
} from "./artifact-policy.js";
import {
  claimTaskDispatch,
  findTask,
  forceStatus,
  humanRetryEligibility,
  humanRetryRiskToken,
  isRunnable,
  isRunnableWithConfig,
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
import { loadConfig, resolveTierModels } from "./config.js";
import { DISCOVERY_TOOLS, discoveryInstructions } from "./discovery.js";
import { runBudgetWarning, taskUsage, truncateText } from "./format.js";
import {
  accountPromptContext,
  buildExecutorPrompt,
  buildReviewPrompt,
  parseVerdict,
} from "./prompts.js";
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
  type ReviewPolicy,
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
  mainTreeIdentityMatches,
  prepareWorktreeIntegration,
  promotePreparedIntegration,
  removePreparedIntegration,
  removeUnreferencedCleanWorktree,
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
  taskIds?: string[],
  simulateApprovedDependencies = false
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
  humanRetryTaskId?: string;
  humanRetryExpectedRiskToken?: string;
  humanRetryOwnerSession?: string;
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
    humanRetryTaskId,
    humanRetryExpectedRiskToken,
    humanRetryOwnerSession,
  } = options;
  // Task ids are matched case-insensitively (see findTask), so normalize both
  // the requested ids and each task id before comparing. Comparing raw ids here
  // would silently drop lowercase/whitespace variants and dispatch nothing.
  const selectedIds = taskIds ? new Set(taskIds.map((id) => id.trim().toUpperCase())) : undefined;
  const isSelected = (task: Task): boolean =>
    selectedIds === undefined || selectedIds.has(task.id.trim().toUpperCase());
  let rounds = 0;
  let rawLaunches = 0;
  let humanExecuteDispatched = false;
  const transientProviderRetries = new Set<string>();
  const currentFingerprintConfig = (): MaestroConfig => loadConfig(cwd);
  const humanRetryId = humanRetryTaskId?.trim().toUpperCase();
  const boundedStartExecutor: StartExecutor = (startOptions) => {
    if (rawLaunches >= config.maxTotalLaunchesPerRun) {
      throw new Error(`workflow raw launch limit reached (${config.maxTotalLaunchesPerRun})`);
    }
    rawLaunches += 1;
    return startExecutor(startOptions);
  };

  const selectedTasks = (): Task[] => loadBoard(cwd).tasks.filter(isSelected);
  const finish = (stoppedBecause: DriveStopReason): DriveSummary => ({
    rounds,
    tasks: selectedTasks().map((task) => snapshot(task)),
    stoppedBecause,
  });

  // A new, explicit drive invocation is the retry boundary for an operational
  // reviewer failure. Disagreement requires a deliberate task-policy edit.
  for (const task of selectedTasks()) {
    if (task.id.toUpperCase() === humanRetryId) continue;
    if (terminalReviewConvergence(task) !== "operational_failure") continue;
    updateTask(cwd, task.id, (fresh) => {
      const attempt = fresh.attempts.at(-1);
      if (attempt?.reviewConvergence?.status === "operational_failure") {
        delete attempt.reviewConvergence;
      }
    });
  }

  try {
    while (rounds < DRIVE_ROUND_LIMIT) {
      if (signal?.aborted) {
        return finish({ code: "aborted", message: "drive aborted by user" });
      }

      const board = loadBoard(cwd);
      const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
      if (validationError) return finish({ code: "error", message: validationError });

      const tasks = board.tasks.filter(isSelected);
      const humanRetryTask = humanRetryId
        ? tasks.find((task) => task.id.toUpperCase() === humanRetryId)
        : undefined;
      if (humanRetryId && !humanRetryExpectedRiskToken) {
        return finish({
          code: "blocked",
          message: "Human retry confirmation evidence is missing; request the retry again.",
        });
      }
      const retryEligibility = humanRetryTask
        ? humanRetryEligibility(board, humanRetryTask.id, {
            maxAttempts: config.maxAttempts,
            config: currentFingerprintConfig(),
            isLive,
            ...(humanRetryOwnerSession ? { ownerSession: humanRetryOwnerSession } : {}),
          })
        : undefined;
      if (humanRetryId && (!humanRetryTask || !retryEligibility?.eligible)) {
        return finish({
          code: "blocked",
          message: retryEligibility?.message ?? `Unknown task id: ${humanRetryTaskId}`,
          ...(humanRetryTask ? { taskIds: [humanRetryTask.id] } : {}),
        });
      }
      if (
        humanRetryTask &&
        humanRetryExpectedRiskToken &&
        humanRetryRiskToken(humanRetryTask) !== humanRetryExpectedRiskToken
      ) {
        return finish({
          code: "blocked",
          message: `${humanRetryTask.id} acceptance or integration evidence changed; confirm the retry again.`,
          taskIds: [humanRetryTask.id],
        });
      }
      const staleApproved = tasks.filter(
        (task) =>
          task.status === "approved" &&
          completionFreshness(board, task, currentFingerprintConfig()).state !== "fresh"
      );
      if (!humanRetryTask && staleApproved.length > 0) {
        return finish({
          code: "stale_completion",
          message: `approved completion is not reusable for ${staleApproved.map((task) => task.id).join(", ")}; retry it or create a successor after inspecting retained evidence`,
          taskIds: staleApproved.map((task) => task.id),
        });
      }
      if (!humanRetryTask && tasks.every((task) => task.status === "approved")) {
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
      const escalated = tasks.filter(
        (task) => task.id.toUpperCase() !== humanRetryId && escalatedTask(task)
      );
      if (escalated.length > 0) return finish(escalationReason(escalated, config));

      const roundNumber = rounds + 1;
      const roundStartLaunches = rawLaunches;
      const roundStartStatuses = new Map(tasks.map((task) => [task.id, task.status]));
      const dispatchResults: TaskSnapshot[] = [];
      let roundCounted = false;
      const countRoundIfLaunched = (): void => {
        if (roundCounted || rawLaunches === roundStartLaunches) return;
        rounds += 1;
        roundCounted = true;
      };
      const wave = calculateSchedulingWave(board, currentFingerprintConfig(), taskIds);
      const runnable = tasks.filter(
        (task) =>
          wave.runnableIds.includes(task.id) ||
          (task.id.toUpperCase() === humanRetryId && retryEligibility?.kind === "execute")
      );
      const budgetWarning =
        runnable.length > 0 ? runBudgetWarning(board.tasks, config.maxRunCost) : undefined;

      if (runnable.length > 0 && !budgetWarning) {
        const dispatchable = runnable.slice(
          0,
          Math.max(0, config.maxTotalLaunchesPerRun - rawLaunches)
        );
        if (dispatchable.some((task) => task.id.toUpperCase() === humanRetryId)) {
          humanExecuteDispatched = true;
        }
        onRoundUpdate?.(
          roundNumber,
          "run",
          dispatchable.map((task) => task.id)
        );
        const worktrees = new Map<string, WorktreeRef>();
        const created: WorktreeRef[] = [];
        const isolateBatch = config.useWorktrees || retryEligibility?.kind === "execute";
        try {
          for (const task of dispatchable) {
            const previous = task.attempts.at(-1);
            const retained =
              task.id.toUpperCase() !== humanRetryId &&
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

        const executeResults = await mapWithConcurrencyLimit(
          dispatchable,
          config.maxParallel,
          (task) => {
            const tier = resolvedTiers.get(task.tier);
            if (!tier) throw new Error(`No resolved tier for "${task.tier}"`);
            const executeOptions: Parameters<typeof executeTask>[0] = {
              cwd,
              board,
              task,
              tier,
              config,
              startExecutor: boundedStartExecutor,
              canStartExecutor: () => rawLaunches < config.maxTotalLaunchesPerRun,
              humanRetry: task.id.toUpperCase() === humanRetryId,
              onUpdate,
              trackRun,
            };
            const worktree = worktrees.get(task.id);
            if (worktree) executeOptions.worktree = worktree;
            if (signal) executeOptions.signal = signal;
            if (task.id.toUpperCase() === humanRetryId && humanRetryExpectedRiskToken) {
              executeOptions.humanRetryExpectedRiskToken = humanRetryExpectedRiskToken;
            }
            if (task.id.toUpperCase() === humanRetryId && humanRetryOwnerSession) {
              executeOptions.humanRetryOwnerSession = humanRetryOwnerSession;
            }
            return executeTask(executeOptions);
          }
        );
        dispatchResults.push(...executeResults);
        countRoundIfLaunched();
        const freshBoard = loadBoard(cwd);
        for (const ref of created) removeUnreferencedCleanWorktree(cwd, freshBoard, ref);
        const freshHumanRetry = humanRetryId
          ? freshBoard.tasks.find((task) => task.id.toUpperCase() === humanRetryId)
          : undefined;
        if (
          freshHumanRetry &&
          humanRetryExpectedRiskToken &&
          humanRetryRiskToken(freshHumanRetry) !== humanRetryExpectedRiskToken
        ) {
          return finish({
            code: "blocked",
            message: `${freshHumanRetry.id} acceptance or integration evidence changed; confirm the retry again.`,
            taskIds: [freshHumanRetry.id],
          });
        }
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
      const stoppedHumanRetry = humanExecuteDispatched
        ? afterRuns.tasks.find((task) => task.id.toUpperCase() === humanRetryId)
        : undefined;
      if (
        stoppedHumanRetry &&
        (stoppedHumanRetry.status === "failed" || stoppedHumanRetry.status === "cancelled")
      ) {
        return finish({
          code: "blocked",
          message: `Human retry stopped after one execution attempt for ${stoppedHumanRetry.id}; retained recovery evidence is available for inspection.`,
          taskIds: [stoppedHumanRetry.id],
        });
      }
      if (
        rawLaunches >= config.maxTotalLaunchesPerRun &&
        afterRuns.tasks.some((task) => isSelected(task) && task.status !== "approved")
      ) {
        return finish({
          code: "launch_limit",
          message: `raw launch limit reached (${config.maxTotalLaunchesPerRun}); inspect retained launch evidence before starting another drive`,
        });
      }
      // Only execute-side provider blocks stop the drive here; a stale review
      // provider failure must fall through so the review phase can re-run it.
      const blockedAfterRuns = afterRuns.tasks.filter(
        (task) => isSelected(task) && task.status === "failed" && providerBlockedTask(task)
      );
      if (blockedAfterRuns.length > 0) {
        if (scheduleTransientProviderRetry(cwd, blockedAfterRuns, transientProviderRetries)) {
          continue;
        }
        return finish(providerBlockedReason(blockedAfterRuns, transientProviderRetries));
      }
      const currentBudgetWarning = runBudgetWarning(afterRuns.tasks, config.maxRunCost);
      if (currentBudgetWarning) {
        const reviewable = afterRuns.tasks.filter(
          (task) =>
            task.status === "ready_for_review" &&
            isSelected(task) &&
            (!terminalReviewConvergence(task) || task.id.toUpperCase() === humanRetryId)
        );
        if (reviewable.length > 0) {
          return finish({
            code: "budget_blocked",
            message: `${currentBudgetWarning}; reviewer launches are blocked until the budget is addressed`,
            taskIds: reviewable.map((task) => task.id),
          });
        }
      }
      const reviewable = afterRuns.tasks.filter(
        (task) =>
          task.status === "ready_for_review" &&
          isSelected(task) &&
          (!terminalReviewConvergence(task) || task.id.toUpperCase() === humanRetryId)
      );
      if (reviewable.length > 0) {
        onRoundUpdate?.(
          roundNumber,
          "review",
          reviewable.map((task) => task.id)
        );
        const reviewTier = resolvedTiers.get("review");
        if (!reviewTier) throw new Error('No resolved tier for "review"');
        const reviewDispatchable = reviewable.slice(
          0,
          Math.max(0, config.maxTotalLaunchesPerRun - rawLaunches)
        );
        const reviewResults = await mapWithConcurrencyLimit(
          reviewDispatchable,
          config.maxParallel,
          (task) => {
            const reviewOptions: Parameters<typeof reviewTask>[0] = {
              cwd,
              task,
              tier: reviewTier,
              startExecutor: boundedStartExecutor,
              canStartExecutor: () => rawLaunches < config.maxTotalLaunchesPerRun,
              autoCommit: config.autoCommit,
              reviewRequiredApprovals: config.reviewRequiredApprovals ?? 2,
              maxReviewerLaunches: config.maxReviewerLaunches ?? 4,
              availableTiers: Object.keys(config.tiers),
              onUpdate,
              trackRun,
              isLive,
              humanRetry: task.id.toUpperCase() === humanRetryId,
            };
            if (task.id.toUpperCase() === humanRetryId && humanRetryOwnerSession) {
              reviewOptions.humanRetryOwnerSession = humanRetryOwnerSession;
            }
            if (config.verificationProfiles)
              reviewOptions.verificationProfiles = config.verificationProfiles;
            if (config.logEvents !== undefined) reviewOptions.logEvents = config.logEvents;
            if (config.maxLogBytesPerRun !== undefined)
              reviewOptions.maxLogBytes = config.maxLogBytesPerRun;
            if (options.onRetentionWarning)
              reviewOptions.onRetentionWarning = options.onRetentionWarning;
            if (signal) reviewOptions.signal = signal;
            return reviewTask(reviewOptions);
          }
        );
        dispatchResults.push(...reviewResults);
        countRoundIfLaunched();
      }

      if (signal?.aborted) {
        return finish({ code: "aborted", message: "drive aborted by user" });
      }

      const freshTasks = selectedTasks();
      const freshBoardAfterRound = loadBoard(cwd);
      const staleAfterRound = freshTasks.filter(
        (task) =>
          task.status === "approved" &&
          completionFreshness(freshBoardAfterRound, task, currentFingerprintConfig()).state !==
            "fresh"
      );
      if (staleAfterRound.length > 0) {
        return finish({
          code: "stale_completion",
          message: `approved completion is not reusable for ${staleAfterRound.map((task) => task.id).join(", ")}; retry it or create a successor after inspecting retained evidence`,
          taskIds: staleAfterRound.map((task) => task.id),
        });
      }
      if (freshTasks.every((task) => task.status === "approved")) {
        return finish({ code: "completed", message: "all selected tasks are approved" });
      }
      if (rawLaunches >= config.maxTotalLaunchesPerRun) {
        return finish({
          code: "launch_limit",
          message: `raw launch limit reached (${config.maxTotalLaunchesPerRun}); inspect retained launch evidence before starting another drive`,
        });
      }
      const providerBlocked = freshTasks.filter(providerBlockedTask);
      if (providerBlocked.length > 0) {
        if (scheduleTransientProviderRetry(cwd, providerBlocked, transientProviderRetries)) {
          continue;
        }
        return finish(providerBlockedReason(providerBlocked, transientProviderRetries));
      }
      const disagreements = freshTasks.filter(
        (task) => terminalReviewConvergence(task) === "disagreement"
      );
      if (disagreements.length > 0) {
        return finish({
          code: "review_disagreement",
          message: `reviewers disagreed for ${disagreements.map((task) => task.id).join(", ")}; deliberately change the task review policy before resuming`,
          taskIds: disagreements.map((task) => task.id),
        });
      }
      const reviewerFailures = freshTasks.filter(
        (task) => terminalReviewConvergence(task) === "operational_failure"
      );
      if (reviewerFailures.length > 0) {
        return finish({
          code: "reviewer_failure",
          message: `review operation failed for ${reviewerFailures.map((task) => task.id).join(", ")}; inspect the retained launch evidence before resuming`,
          taskIds: reviewerFailures.map((task) => task.id),
        });
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
          task.attempts.filter(consumesMaxAttempt).length >= config.maxAttempts
      );
      if (attemptCapped.length > 0) {
        return finish({
          code: "attempt_cap",
          message: `attempt cap reached (${config.maxAttempts}) for ${attemptCapped.map((task) => task.id).join(", ")}`,
          taskIds: attemptCapped.map((task) => task.id),
        });
      }

      const statusChanged =
        freshTasks.length !== roundStartStatuses.size ||
        freshTasks.some((task) => roundStartStatuses.get(task.id) !== task.status);
      if (rawLaunches === roundStartLaunches && !statusChanged) {
        return finish(noProgressReason(freshTasks, dispatchResults));
      }

      const freshBoard = loadBoard(cwd);
      const canContinue = freshTasks.some(
        (task) =>
          task.status === "ready_for_review" ||
          (task.status !== "cancelled" &&
            isRunnableWithConfig(
              freshBoard,
              task,
              currentFingerprintConfig(),
              task.status === "failed"
            ))
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

function noProgressReason(tasks: Task[], dispatchResults: TaskSnapshot[]): DriveStopReason {
  const notes = new Map(
    dispatchResults.map((result) => [
      result.id,
      result.note ?? "dispatch declined without a reason",
    ])
  );
  const pending = tasks.filter((task) => !["approved", "cancelled"].includes(task.status));
  const details = pending.map(
    (task) => `${task.id} (${task.status}): ${notes.get(task.id) ?? "no dispatch was attempted"}`
  );
  return {
    code: "no_progress",
    message: `Drive stopped because no executor or reviewer launched and no selected task changed status.\n${details.join("\n")}`,
    taskIds: pending.map((task) => task.id),
  };
}

function terminalReviewConvergence(task: Task): "disagreement" | "operational_failure" | undefined {
  if (task.status !== "ready_for_review") return undefined;
  const status = task.attempts.at(-1)?.reviewConvergence?.status;
  if (status === "disagreement" || status === "operational_failure") return status;
  return undefined;
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

export type ProviderFailureClass = "transient" | "persistent";

const PROVIDER_FAILURE_PATTERNS: Record<ProviderFailureClass, readonly RegExp[]> = {
  persistent: [
    /\b(?:auth(?:entication|orization)?|unauthenticated|unauthorized)\b/i,
    /\b(?:invalid|missing|expired|revoked)\s+(?:api[ -]?)?key\b/i,
    /\b(?:quota|billing|payment|credit|usage limit)\b/i,
    /\bmodel(?:[-_ ]not[-_ ]found|\s+does not exist|\s+unavailable for)\b/i,
    /\b(?:permission|forbidden)\b/i,
    /\b(?:401|403)\b/,
  ],
  transient: [
    /\b(?:timeout|timed out|etimedout)\b/i,
    /\b(?:econnreset|econnrefused|connection resets?|connection refused|network error)\b/i,
    /\b(?:http\s*)?429\b/i,
    /\b(?:http\s*)?5\d\d\b/i,
    /\b(?:overloaded|rate limit|service unavailable|temporarily unavailable)\b/i,
  ],
};

export function classifyProviderFailure(message: string | undefined): ProviderFailureClass {
  const evidence = message ?? "";
  for (const pattern of PROVIDER_FAILURE_PATTERNS.persistent) {
    if (pattern.test(evidence)) return "persistent";
  }
  for (const pattern of PROVIDER_FAILURE_PATTERNS.transient) {
    if (pattern.test(evidence)) return "transient";
  }
  return "persistent";
}

function providerFailureMessage(task: Task): string | undefined {
  const attempt = task.attempts.at(-1);
  return attempt?.reviewLaunches?.at(-1)?.failureReason?.message ?? attempt?.failureReason?.message;
}

function scheduleTransientProviderRetry(
  cwd: string,
  tasks: Task[],
  retriedTaskIds: Set<string>
): boolean {
  if (
    tasks.some((task) => classifyProviderFailure(providerFailureMessage(task)) === "persistent")
  ) {
    return false;
  }

  const retryable = tasks.filter((task) => !retriedTaskIds.has(task.id));
  if (retryable.length === 0) return false;
  for (const task of retryable) {
    retriedTaskIds.add(task.id);
    if (task.status !== "ready_for_review") continue;
    updateTask(cwd, task.id, (fresh) => {
      const attempt = fresh.attempts.at(-1);
      if (attempt?.reviewConvergence?.status === "operational_failure") {
        delete attempt.reviewConvergence;
      }
    });
  }
  return true;
}

function providerBlockedTask(task: Task): boolean {
  const latest = task.attempts.at(-1);
  if (!latest) return false;
  if (task.status === "failed") return !consumesMaxAttempt(latest);
  if (task.status !== "ready_for_review") return false;
  return latest.reviewLaunches?.at(-1)?.failureReason?.kind === "provider_failure";
}

function providerBlockedReason(
  tasks: Task[],
  transientProviderRetries: ReadonlySet<string>
): DriveStopReason {
  const details = tasks.map((task) => {
    const attempt = task.attempts.at(-1);
    const reviewFailure = attempt?.reviewLaunches?.at(-1);
    const model = reviewFailure?.model ?? attempt?.model ?? "configured model";
    const provider = reviewFailure?.provider ?? attempt?.provider;
    const identity = provider ? `${model} (${provider})` : model;
    const message = reviewFailure?.failureReason?.message ?? attempt?.failureReason?.message;
    const failureClass = classifyProviderFailure(message);
    const retry =
      failureClass === "transient" && transientProviderRetries.has(task.id)
        ? "; auto-retried once and failed again"
        : "";
    return `${task.id} [${failureClass}${retry}]: ${identity}${message ? ` — ${redactFailureMessage(message)}` : ""}`;
  });
  return {
    code: "provider_blocked",
    message: `Provider access blocked; autonomous retries stopped. ${details.join("; ")}\nPersistent failures require provider configuration; transient failures reach this decision only after one automatic retry. Check provider quota/authentication or configure another fallback in /maestro config, then use /maestro resume (or explicitly retry the task).`,
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
  canStartExecutor?: () => boolean;
  humanRetry?: boolean;
  humanRetryExpectedRiskToken?: string;
  humanRetryOwnerSession?: string;
  signal?: AbortSignal;
  onUpdate: WorkflowUpdate;
  trackRun: TrackRun;
}): Promise<TaskSnapshot> {
  const {
    cwd,
    board,
    task,
    tier,
    config,
    worktree,
    startExecutor,
    canStartExecutor = () => true,
    humanRetry = false,
    humanRetryExpectedRiskToken,
    humanRetryOwnerSession,
    signal,
    onUpdate,
    trackRun,
  } = options;

  const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
  if (validationError) throw new Error(validationError);
  if (board.planPending) throw new Error("Plan approval is pending.");

  const consumedAttempts = task.attempts.filter(consumesMaxAttempt).length;
  if (consumedAttempts >= config.maxAttempts) {
    const updated = updateTask(cwd, task.id, (fresh) => {
      forceStatus(fresh, "failed");
    });
    const recoveryGuidance = `attempt cap reached (${config.maxAttempts}); create a narrowly scoped successor with maestro_plan and set supersedesTaskId to ${task.id} so Maestro atomically cancels this predecessor and rewires downstream dependencies, then start maestro_drive for the successor and rewired dependents`;
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
    if (!canStartExecutor()) {
      return snapshot(
        findTask(loadBoard(cwd), task.id) ?? updated ?? task,
        "workflow raw launch limit reached"
      );
    }
    let executionFingerprint: string | undefined;
    let executionComponentHashes: Attempt["executionComponentHashes"];
    const lifecycle = claimDispatchLifecycle(cwd, task.id, "execute", (freshBoard, freshTask) => {
      const fp = taskFingerprint(freshBoard, freshTask, loadConfig(cwd));
      executionFingerprint = fp?.fingerprint;
      executionComponentHashes = fp?.componentHashes;
      if (!executionFingerprint) return false;
      if (!humanRetry) return isRunnableWithConfig(freshBoard, freshTask, loadConfig(cwd), true);
      const eligibility = humanRetryEligibility(freshBoard, freshTask.id, {
        maxAttempts: config.maxAttempts,
        config: loadConfig(cwd),
        isLive: () => false,
        ...(humanRetryOwnerSession ? { ownerSession: humanRetryOwnerSession } : {}),
      });
      if (!eligibility.eligible || eligibility.kind !== "execute") return false;
      if (
        humanRetryExpectedRiskToken &&
        humanRetryRiskToken(freshTask) !== humanRetryExpectedRiskToken
      ) {
        return false;
      }
      if (freshTask.status === "approved" || freshTask.status === "cancelled") {
        forceStatus(freshTask, "failed");
      }
      return true;
    });
    const { dispatch } = lifecycle;
    if (!dispatch?.claimed || dispatch.attemptIndex === undefined || !lifecycle.release) {
      return snapshot(dispatch?.task ?? task, dispatch?.note ?? "execute dispatch declined");
    }
    const attemptIndex = dispatch.attemptIndex;
    updateTask(cwd, task.id, (fresh) => {
      if (fresh.dispatchClaim?.id !== dispatch.claimId) return;
      const attempt = fresh.attempts.find((candidate) => candidate.index === attemptIndex);
      if (attempt && executionFingerprint) attempt.executionFingerprint = executionFingerprint;
      if (attempt && executionComponentHashes) {
        attempt.executionComponentHashes = executionComponentHashes;
      }
    });
    const attemptTier: TierConfig = { ...tier };
    delete attemptTier.fallbacks;
    if (model === undefined) delete attemptTier.model;
    else attemptTier.model = model;
    if (task.discovery) attemptTier.tools = DISCOVERY_TOOLS;

    const basePrompt = buildExecutorPrompt(task, dependencyReports);
    const prompt = task.discovery
      ? `${basePrompt}\n\n${discoveryInstructions(task.discovery.allowedWritePaths)}`
      : basePrompt;
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
    if (executionFingerprint) run.attempt.executionFingerprint = executionFingerprint;
    if (executionComponentHashes) run.attempt.executionComponentHashes = executionComponentHashes;
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

type CriterionEvidence = NonNullable<ReviewLaunch["criterionEvidence"]>;

function reviewEvidence(report: string, criteriaCount: number): CriterionEvidence | undefined {
  const matches = [...report.matchAll(/^CRITERION\s+(\d+):\s*(PASS|FAIL)\s*(?:—|-)\s*(.+)$/gim)];
  if (matches.length !== criteriaCount) return undefined;
  const evidence = matches.map((match) => ({
    criterion: Number(match[1]),
    passed: match[2]?.toUpperCase() === "PASS",
    evidence: redactFailureMessage(match[3] ?? "").slice(0, 500),
  }));
  const numbers = new Set(evidence.map((entry) => entry.criterion));
  if (numbers.size !== criteriaCount) return undefined;
  if (evidence.some((entry) => entry.criterion < 1 || entry.criterion > criteriaCount)) {
    return undefined;
  }
  return evidence.sort((left, right) => left.criterion - right.criterion);
}

function policyReviewPrompt(
  task: Task,
  report: string,
  policy: ReviewPolicy,
  role: NonNullable<ReviewLaunch["role"]>,
  finderReport?: string
): string {
  const base = buildReviewPrompt(task, report);
  if (policy === "single") return base;
  const criteria = (task.successCriteria ?? [])
    .map((_criterion, index) => `CRITERION ${index + 1}: PASS|FAIL — bounded concrete evidence`)
    .join("\n");
  const roleText =
    role === "finder"
      ? "Act as the finding reviewer. Try to identify a concrete reason to reject the artifact."
      : role === "refuter"
        ? `Act as an independent confirmer/refuter. Assess the artifact yourself, then evaluate only this bounded finder evidence:\n${finderReport?.slice(0, 4_000) ?? "(none)"}`
        : "Act as an independent confirmer. Do not assume another reviewer approved the artifact.";
  return `${base}\n\n${roleText}\nReport every criterion exactly once using these lines:\n${criteria}\nThe VERDICT must agree with the criterion lines.`;
}

function convergenceRecord(
  policy: ReviewPolicy,
  status: NonNullable<Attempt["reviewConvergence"]>["status"],
  requiredApprovals: number,
  actualApprovals: number,
  reviewerCount: number,
  summary: string
): NonNullable<Attempt["reviewConvergence"]> {
  return {
    policy,
    status,
    requiredApprovals,
    actualApprovals,
    reviewerCount,
    summary: redactFailureMessage(summary).slice(0, 2_000),
    decidedAt: Date.now(),
  };
}

const STALE_COMPONENT_LABELS: Record<keyof Attempt["executionComponentHashes"] & string, string> = {
  contract: "Task contract (brief/criteria/policy)",
  execution: "Execution configuration (tier/review policy)",
  verification: "Verification profile",
  dependencies: "Dependency artifacts",
};

function staleExecutionInputsMessage(
  latestAttempt: Attempt,
  currentFingerprint: ReturnType<typeof taskFingerprint>
): string {
  const before = latestAttempt.executionComponentHashes;
  const after = currentFingerprint?.componentHashes;
  const changedLabels = before
    ? (Object.keys(STALE_COMPONENT_LABELS) as Array<keyof typeof STALE_COMPONENT_LABELS>)
        .filter((component) => before[component] !== after?.[component])
        .map((component) => STALE_COMPONENT_LABELS[component])
    : [];
  const subject =
    changedLabels.length > 0
      ? changedLabels.join(", ")
      : "Task, configured execution, verification, or dependency inputs";
  return `${subject} changed after execution — the attempt ran under the old contract. Retry the task to re-execute under the current one.`;
}

export async function reviewTask(options: {
  cwd: string;
  task: Task;
  tier: TierConfig;
  startExecutor: StartExecutor;
  canStartExecutor?: () => boolean;
  autoCommit?: boolean;
  logEvents?: "compact" | "full" | undefined;
  maxLogBytes?: number | undefined;
  reviewRequiredApprovals?: number;
  maxReviewerLaunches?: number;
  availableTiers?: Iterable<string>;
  verificationProfiles?: Record<string, VerificationProfile>;
  signal?: AbortSignal;
  onUpdate: WorkflowUpdate;
  trackRun: TrackRun;
  isLive?: (taskId: string) => boolean;
  humanRetry?: boolean;
  humanRetryOwnerSession?: string;
  onRetentionWarning?: (warning: string) => void;
}): Promise<TaskSnapshot> {
  const {
    cwd,
    task,
    tier,
    startExecutor,
    canStartExecutor = () => true,
    autoCommit,
    logEvents,
    maxLogBytes,
    reviewRequiredApprovals = 2,
    maxReviewerLaunches = 4,
    availableTiers,
    verificationProfiles,
    signal,
    onUpdate,
    trackRun,
    humanRetry = false,
    humanRetryOwnerSession,
  } = options;
  const board = loadBoard(cwd);
  const validationError = planValidationMessage(validatePlan(board, availableTiers));
  if (validationError) throw new Error(validationError);
  if (board.planPending) throw new Error("Plan approval is pending.");

  const lifecycle = claimDispatchLifecycle(cwd, task.id, "review", (freshBoard, freshTask) => {
    if (!humanRetry) return freshTask.status === "ready_for_review";
    const eligibility = humanRetryEligibility(freshBoard, freshTask.id, {
      maxAttempts: Number.MAX_SAFE_INTEGER,
      config: loadConfig(cwd),
      isLive: () => false,
      ...(humanRetryOwnerSession ? { ownerSession: humanRetryOwnerSession } : {}),
    });
    if (!eligibility.eligible || eligibility.kind !== "review") return false;
    const attempt = freshTask.attempts.at(-1);
    if (attempt?.reviewConvergence?.status === "operational_failure") {
      attempt.reviewConvergenceHistory = [
        ...(attempt.reviewConvergenceHistory ?? []),
        structuredClone(attempt.reviewConvergence),
      ];
      delete attempt.reviewConvergence;
    }
    if (
      attempt &&
      attempt.reviewLaunches === undefined &&
      (attempt.reviewReport !== undefined ||
        attempt.reviewSessionFile !== undefined ||
        attempt.reviewModel !== undefined ||
        attempt.reviewProvider !== undefined ||
        attempt.reviewUsage !== undefined)
    ) {
      const verdict = attempt.reviewReport ? parseVerdict(attempt.reviewReport) : undefined;
      attempt.reviewLaunches = [
        {
          id: `legacy-${freshTask.id.toLowerCase()}-review-${attempt.index}`,
          reviewerIndex: 1,
          role: "single",
          startedAt: attempt.endedAt ?? attempt.startedAt,
          ...(attempt.endedAt === undefined ? {} : { endedAt: attempt.endedAt }),
          ...(verdict === undefined
            ? {}
            : { verdict: verdict.approved ? ("approve" as const) : ("request_changes" as const) }),
          ...(attempt.reviewModel === undefined ? {} : { model: attempt.reviewModel }),
          ...(attempt.reviewProvider === undefined ? {} : { provider: attempt.reviewProvider }),
          ...(attempt.reviewSessionFile === undefined
            ? {}
            : { sessionFile: attempt.reviewSessionFile }),
          usage: structuredClone(attempt.reviewUsage ?? { input: 0, output: 0, cost: 0, turns: 0 }),
          ...(attempt.reviewReport === undefined ? {} : { finalReport: attempt.reviewReport }),
        },
      ];
    }
    return true;
  });
  const { dispatch } = lifecycle;
  if (!dispatch?.claimed || !lifecycle.release) {
    return snapshot(dispatch?.task ?? task, dispatch?.note ?? "review dispatch declined");
  }

  try {
    const task = dispatch.task;
    const report = lastReport(task);
    if (!report) return snapshot(task, "no executor report to review");
    const reviewPolicy = task.reviewPolicy ?? "single";
    const latestAttempt = task.attempts.at(-1);
    const runtimeConfig = (): MaestroConfig => {
      const loaded = loadConfig(cwd);
      if (verificationProfiles) loaded.verificationProfiles = verificationProfiles;
      return loaded;
    };
    const effectiveProfileName =
      task.verificationProfile ?? runtimeConfig().defaultVerificationProfile;
    const configuredProfile = effectiveProfileName
      ? runtimeConfig().verificationProfiles?.[effectiveProfileName]
      : undefined;
    if (effectiveProfileName && !configuredProfile) {
      throw new Error(`Unknown verification profile: ${effectiveProfileName}`);
    }
    const candidatePaths = latestAttempt?.touchedFiles ?? [];
    const candidateCwd = latestAttempt?.worktreePath ?? cwd;
    const claimedAttemptIndex = latestAttempt?.index;
    const claimedTaskContract = JSON.stringify({
      title: task.title,
      brief: task.brief,
      tier: task.tier,
      dependsOn: task.dependsOn,
      writePaths: task.writePaths ?? [],
      successCriteria: task.successCriteria ?? [],
      verificationProfile: task.verificationProfile,
      reviewPolicy,
      commitMessage: task.commitMessage,
    });
    const reviewIdentityMatches = (fresh: Task): boolean =>
      fresh.status === "ready_for_review" &&
      fresh.dispatchClaim?.id === dispatch.claimId &&
      fresh.attempts.at(-1)?.index === claimedAttemptIndex &&
      lastReport(fresh) === report &&
      JSON.stringify({
        title: fresh.title,
        brief: fresh.brief,
        tier: fresh.tier,
        dependsOn: fresh.dependsOn,
        writePaths: fresh.writePaths ?? [],
        successCriteria: fresh.successCriteria ?? [],
        verificationProfile: fresh.verificationProfile,
        reviewPolicy: fresh.reviewPolicy ?? "single",
        commitMessage: fresh.commitMessage,
      }) === claimedTaskContract;
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
    const currentExecutionFingerprint = taskFingerprint(loadBoard(cwd), task, runtimeConfig());
    if (
      !latestAttempt?.executionFingerprint ||
      latestAttempt.executionFingerprint !== currentExecutionFingerprint?.fingerprint
    ) {
      gateFindings.push({
        fingerprint: "execution-inputs-changed",
        message: latestAttempt?.executionFingerprint
          ? staleExecutionInputsMessage(latestAttempt, currentExecutionFingerprint)
          : "Execution has no versioned input fingerprint; use explicit manual acceptance for migration.",
        status: "open",
        firstAttempt: latestAttempt?.index ?? task.attempts.length,
        lastAttempt: latestAttempt?.index ?? task.attempts.length,
      });
    }
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
        fresh.reviewNotes = notes;
        const attempt = fresh.attempts.at(-1);
        if (attempt) {
          attempt.reviewConvergence = convergenceRecord(
            reviewPolicy,
            "operational_failure",
            reviewPolicy === "confirm"
              ? reviewRequiredApprovals
              : reviewPolicy === "find-and-refute"
                ? 2
                : 1,
            0,
            0,
            notes
          );
          attempt.failureReason = {
            kind: "reviewer_failure",
            message: redactFailureMessage(notes),
            retryable: true,
          };
        }
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
    const priorReviewLaunchCount = reviewedAttempt?.reviewLaunches?.length ?? 0;
    let rawLaunchCount = 0;
    let lastRun: ExecutorHandle | undefined;
    let outcome: RunOutcome = {
      exitCode: 1,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      finalReport: "",
      touchedFiles: [],
      aborted: false,
    };

    const launchReviewer = async (
      reviewerIndex: number,
      role: NonNullable<ReviewLaunch["role"]>,
      finderReport?: string
    ): Promise<
      | { verdict: { approved: boolean; notes: string }; report: string }
      | { operationalFailure: string }
      | { launchLimit: true }
    > => {
      if (candidateTree && snapshotArtifact(candidateCwd, candidatePaths) !== candidateTree) {
        return { operationalFailure: "candidate artifact changed between logical reviewers" };
      }
      for (const [modelIndex, model] of models.entries()) {
        if (!canStartExecutor()) return { launchLimit: true };
        if (rawLaunchCount >= maxReviewerLaunches) {
          return { operationalFailure: `review launch cap reached (${maxReviewerLaunches})` };
        }
        rawLaunchCount += 1;
        const launchTier: TierConfig = { ...tier };
        delete launchTier.fallbacks;
        if (model === undefined) delete launchTier.model;
        else launchTier.model = model;
        const reviewPrompt = policyReviewPrompt(task, report, reviewPolicy, role, finderReport);
        const promptContext = accountPromptContext(reviewPrompt);
        const launchId = `${task.id}-review-${task.attempts.length}-${reviewerIndex}-${priorReviewLaunchCount + rawLaunchCount}`;
        const placeholder: ReviewLaunch = {
          id: launchId,
          reviewerIndex,
          role,
          startedAt: Date.now(),
          usage: { input: 0, output: 0, cost: 0, turns: 0 },
          promptCharacters: promptContext.characters,
          promptApproximateTokens: promptContext.approximateTokens,
          promptSections: promptContext.sections,
        };
        updateTask(cwd, task.id, (fresh) => {
          const attempt = fresh.attempts.at(-1);
          if (attempt) attempt.reviewLaunches = [...(attempt.reviewLaunches ?? []), placeholder];
        });

        const runOptions: Parameters<StartExecutor>[0] = {
          stateDir: stateDir(cwd),
          runId: launchId,
          cwd: worktree?.worktreePath ?? cwd,
          prompt: reviewPrompt,
          tier: launchTier,
          sessionLabel: sessionLabel(task, "review", task.attempts.length),
          ...(logEvents === undefined ? {} : { logEvents }),
          ...(maxLogBytes === undefined ? {} : { maxLogBytes }),
          onUpdate: (update) => {
            const sessionFile = update.sessionFile;
            if (sessionFile) {
              updateTask(cwd, task.id, (fresh) => {
                const launch = fresh.attempts
                  .at(-1)
                  ?.reviewLaunches?.find((candidate) => candidate.id === launchId);
                if (launch) launch.sessionFile = sessionFile;
              });
            }
            onUpdate(task.id, update);
          },
        };
        if (signal) runOptions.signal = signal;

        let run: ExecutorHandle;
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
              startedAt: placeholder.startedAt,
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
            followUp: () => {},
            abort: () => {},
          };
        }
        lastRun = run;
        if (run.attempt.model === undefined && model !== undefined) run.attempt.model = model;
        updateTask(cwd, task.id, (fresh) => {
          const launch = fresh.attempts
            .at(-1)
            ?.reviewLaunches?.find((candidate) => candidate.id === launchId);
          if (!launch) return;
          launch.logFile = run.attempt.logFile;
          if (run.attempt.sessionFile) launch.sessionFile = run.attempt.sessionFile;
        });
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
          ...placeholder,
          logFile: run.attempt.logFile,
          usage: { ...outcome.usage },
          exitCode: outcome.exitCode,
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

        const parsed =
          outcome.aborted || outcome.exitCode !== 0 || outcome.errorMessage
            ? undefined
            : parseVerdict(outcome.finalReport);
        if (parsed && reviewPolicy !== "single") {
          const evidence = reviewEvidence(outcome.finalReport, task.successCriteria?.length ?? 0);
          if (!evidence || parsed.approved !== evidence.every((entry) => entry.passed)) {
            launch.errorMessage = "reviewer returned malformed or inconsistent criterion evidence";
          } else {
            launch.criterionEvidence = evidence;
            launch.verdict = parsed.approved ? "approve" : "request_changes";
          }
        } else if (parsed) {
          launch.verdict = parsed.approved ? "approve" : "request_changes";
        }
        updateTask(cwd, task.id, (fresh) => {
          const launches = fresh.attempts.at(-1)?.reviewLaunches;
          const index = launches?.findIndex((candidate) => candidate.id === launchId) ?? -1;
          if (launches && index >= 0) launches[index] = launch;
        });
        reviewLaunches.push(launch);

        const canFallback =
          failureReason?.kind === "provider_failure" && modelIndex < models.length - 1;
        if (canFallback) continue;
        if (failureReason) return { operationalFailure: failureReason.message };
        if (!parsed) return { operationalFailure: "reviewer gave no VERDICT line" };
        if (reviewPolicy !== "single" && !launch.criterionEvidence) {
          return {
            operationalFailure: launch.errorMessage ?? "reviewer criterion evidence invalid",
          };
        }
        return { verdict: parsed, report: outcome.finalReport };
      }
      return { operationalFailure: "reviewer launch failed" };
    };

    const requiredApprovals =
      reviewPolicy === "confirm"
        ? reviewRequiredApprovals
        : reviewPolicy === "find-and-refute"
          ? 2
          : 1;
    const logicalResults: Array<{ verdict: { approved: boolean; notes: string }; report: string }> =
      [];
    let operationalFailure: string | undefined;
    let launchLimitReached = false;
    if (reviewPolicy === "find-and-refute") {
      const finder = await launchReviewer(1, "finder");
      if ("launchLimit" in finder) launchLimitReached = true;
      else if ("operationalFailure" in finder) operationalFailure = finder.operationalFailure;
      else {
        logicalResults.push(finder);
        const refuter = await launchReviewer(2, "refuter", finder.report);
        if ("launchLimit" in refuter) launchLimitReached = true;
        else if ("operationalFailure" in refuter) operationalFailure = refuter.operationalFailure;
        else logicalResults.push(refuter);
      }
    } else {
      const count = reviewPolicy === "confirm" ? reviewRequiredApprovals : 1;
      for (let index = 1; index <= count; index += 1) {
        const result = await launchReviewer(
          index,
          reviewPolicy === "single" ? "single" : "confirmer"
        );
        if ("launchLimit" in result) {
          launchLimitReached = true;
          break;
        }
        if ("operationalFailure" in result) {
          operationalFailure = result.operationalFailure;
          break;
        }
        logicalResults.push(result);
        if (!result.verdict.approved) break;
      }
    }

    if (launchLimitReached) {
      return snapshot(
        findTask(loadBoard(cwd), task.id) ?? task,
        "workflow raw launch limit reached"
      );
    }

    const approvals = logicalResults.filter((result) => result.verdict.approved).length;
    const reviewerCount = new Set(reviewLaunches.map((launch) => launch.reviewerIndex)).size;
    const disagreement =
      reviewPolicy === "find-and-refute" &&
      logicalResults.length === 2 &&
      logicalResults[0]?.verdict.approved !== logicalResults[1]?.verdict.approved;
    let verdict = operationalFailure || disagreement ? undefined : logicalResults.at(-1)?.verdict;
    let convergence = convergenceRecord(
      reviewPolicy,
      operationalFailure
        ? "operational_failure"
        : disagreement
          ? "disagreement"
          : verdict?.approved
            ? "approved"
            : "changes_requested",
      requiredApprovals,
      approvals,
      reviewerCount,
      operationalFailure ??
        (disagreement
          ? "finder and refuter reached conflicting verdicts"
          : verdict?.notes || outcome.finalReport)
    );
    const reviewerRequestedChanges = convergence.status === "changes_requested";
    let mechanicalFailure: string | undefined;
    if (candidateTree && snapshotArtifact(candidateCwd, candidatePaths) !== candidateTree) {
      mechanicalFailure = "Candidate files changed while under review; integration was skipped.";
      verdict = { approved: false, notes: mechanicalFailure };
    }
    let integrationAuthorized = false;
    updateTask(cwd, task.id, (fresh) => {
      integrationAuthorized = reviewIdentityMatches(fresh);
    });
    if (!integrationAuthorized) {
      mechanicalFailure = "Review identity changed before integration; integration was skipped.";
      convergence = convergenceRecord(
        reviewPolicy,
        "operational_failure",
        requiredApprovals,
        approvals,
        reviewerCount,
        mechanicalFailure
      );
      verdict = undefined;
    }
    let mergeConflict: string | undefined;
    let integratedCommit: string | undefined;
    let integratedTree: string | undefined;
    let integrationVerification: Awaited<ReturnType<typeof runVerification>> | undefined;
    const fingerprintBeforeIntegration = verdict?.approved
      ? taskFingerprint(loadBoard(cwd), task, runtimeConfig())
      : undefined;
    if (verdict?.approved && !fingerprintBeforeIntegration) {
      mechanicalFailure = "Approved completion fingerprint inputs are unavailable.";
      verdict = undefined;
    }
    if (verdict?.approved && worktree) {
      const verificationStateDir = mkdtempSync(join(tmpdir(), "maestro-verification-"));
      try {
        await serializeMainTreeOperation(cwd, async () => {
          const prepared = prepareWorktreeIntegration(cwd, worktree, taskCommitMessage(task));
          try {
            if (
              !candidateTree ||
              !artifactMatchesCommit(
                prepared.tempRef.worktreePath,
                candidateTree,
                prepared.integratedCommit,
                candidatePaths
              )
            ) {
              throw new Error("prepared integration does not contain the reviewed candidate tree");
            }
            const heldTask = findTask(loadBoard(cwd), task.id);
            if (!heldTask || !reviewIdentityMatches(heldTask)) {
              throw new Error("review identity changed before prepared integration verification");
            }
            if (configuredProfile) {
              integrationVerification = await runVerification({
                cwd: prepared.tempRef.worktreePath,
                stateDir: verificationStateDir,
                name: `${task.id}-integrated`,
                command: configuredProfile.command,
                timeoutSeconds: configuredProfile.timeoutSeconds,
                ...(signal ? { signal } : {}),
              });
            }
            if (
              headCommit(prepared.tempRef.worktreePath) !== prepared.integratedCommit ||
              changedPaths(prepared.tempRef.worktreePath).length > 0
            ) {
              throw new Error("post-integration verification mutated the prepared checkout");
            }
            if (integrationVerification && !integrationVerification.ok) {
              throw new Error(
                `post-integration verification ${task.verificationProfile} failed or was interrupted`
              );
            }
            const currentTask = findTask(loadBoard(cwd), task.id);
            if (!currentTask || !reviewIdentityMatches(currentTask)) {
              throw new Error("review identity changed before integration promotion");
            }
            const currentFingerprint = taskFingerprint(
              loadBoard(cwd),
              currentTask,
              runtimeConfig()
            );
            if (
              !currentFingerprint ||
              currentFingerprint.fingerprint !== fingerprintBeforeIntegration?.fingerprint
            ) {
              throw new Error("task, config, or dependency fingerprint changed before promotion");
            }
            if (!mainTreeIdentityMatches(cwd, prepared.mainIdentity)) {
              throw new Error("main checkout changed before integration promotion");
            }
            const promoted = promotePreparedIntegration(cwd, prepared);
            if (!promoted.ok) {
              throw new Error(promoted.error ?? "prepared integration promotion failed");
            }
            integratedCommit = prepared.integratedCommit;
            integratedTree = prepared.integratedTree;
          } finally {
            removePreparedIntegration(cwd, prepared);
          }
        });
      } catch (error) {
        mergeConflict = `Approved review could not be integrated safely because of a git conflict or transaction check. Recovery worktree: ${worktree.worktreePath}\nBranch: ${worktree.branch}\n${error instanceof Error ? error.message : String(error)}`;
        mechanicalFailure = mergeConflict;
        verdict = { approved: false, notes: mergeConflict };
      } finally {
        if (integrationVerification) {
          const directory = join(stateDir(cwd), "verification");
          mkdirSync(directory, { recursive: true });
          const logFile = join(directory, basename(integrationVerification.logFile));
          copyFileSync(integrationVerification.logFile, logFile);
          integrationVerification = { ...integrationVerification, logFile };
        }
        rmSync(verificationStateDir, { recursive: true, force: true });
      }
    } else if (verdict?.approved && autoCommit) {
      const files = reviewedAttempt?.touchedFiles ?? [];
      try {
        if (configuredProfile) {
          const verificationStateDir = mkdtempSync(join(tmpdir(), "maestro-verification-"));
          try {
            integrationVerification = await runVerification({
              cwd,
              stateDir: verificationStateDir,
              name: `${task.id}-candidate`,
              command: configuredProfile.command,
              timeoutSeconds: configuredProfile.timeoutSeconds,
              ...(signal ? { signal } : {}),
            });
          } finally {
            rmSync(verificationStateDir, { recursive: true, force: true });
          }
          if (!integrationVerification.ok) {
            mechanicalFailure = `Pre-commit verification ${task.verificationProfile} failed; no integration commit was created.`;
          }
        }
        if (mechanicalFailure) throw new Error(mechanicalFailure);
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

    if (verdict?.approved && requiresIntegration && (!candidateTree || !integratedCommit)) {
      mechanicalFailure =
        "Automated approval requires an authoritative Git artifact and proven integration.";
      verdict = { approved: false, notes: mechanicalFailure };
    }
    if (mechanicalFailure) {
      convergence = convergenceRecord(
        reviewPolicy,
        "operational_failure",
        requiredApprovals,
        approvals,
        reviewerCount,
        mechanicalFailure
      );
      verdict = undefined;
    }

    const approvedProvenance = verdict?.approved
      ? (() => {
          const board = loadBoard(cwd);
          const currentTask = findTask(board, task.id);
          return currentTask
            ? captureApprovedProvenance(board, currentTask, runtimeConfig())
            : undefined;
        })()
      : undefined;
    if (verdict?.approved && !approvedProvenance) {
      mechanicalFailure = "Approved completion proof became unavailable before settlement.";
      convergence = convergenceRecord(
        reviewPolicy,
        "operational_failure",
        requiredApprovals,
        approvals,
        reviewerCount,
        mechanicalFailure
      );
      verdict = undefined;
    }

    let finalMutationApplied = false;
    let settlementProvenance = approvedProvenance;
    const updated = updateTask(cwd, task.id, (fresh, freshBoard) => {
      if (!reviewIdentityMatches(fresh)) return;
      if (verdict?.approved) {
        const liveProvenance = captureApprovedProvenance(
          freshBoard,
          fresh,
          runtimeConfig(),
          approvedProvenance?.approvedAt
        );
        if (
          !liveProvenance ||
          !approvedProvenance ||
          JSON.stringify({ ...liveProvenance, approvedAt: 0 }) !==
            JSON.stringify({ ...approvedProvenance, approvedAt: 0 })
        ) {
          settlementProvenance = undefined;
          return;
        }
        settlementProvenance = liveProvenance;
      }
      finalMutationApplied = true;
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
        const previousReviewUsage = attempt.reviewUsage ?? {
          input: 0,
          output: 0,
          cost: 0,
          turns: 0,
        };
        attempt.reviewUsage = {
          input: previousReviewUsage.input + reviewUsage.input,
          output: previousReviewUsage.output + reviewUsage.output,
          cost: previousReviewUsage.cost + reviewUsage.cost,
          turns: previousReviewUsage.turns + reviewUsage.turns,
        };
        const latestLaunch = reviewLaunches.at(-1);
        if (latestLaunch?.model !== undefined) attempt.reviewModel = latestLaunch.model;
        if (latestLaunch?.provider !== undefined) attempt.reviewProvider = latestLaunch.provider;
        // Keep the full review report and session for post-hoc inspection.
        if (outcome.finalReport) attempt.reviewReport = outcome.finalReport;
        if (lastRun?.attempt.sessionFile) attempt.reviewSessionFile = lastRun.attempt.sessionFile;
        attempt.reviewConvergence = convergence;

        const reviewFailure =
          latestLaunch?.failureReason ??
          (convergence.status === "operational_failure"
            ? {
                kind: "reviewer_failure" as const,
                message: convergence.summary,
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
      if (!verdict) {
        fresh.reviewNotes = convergence.summary;
        return;
      }
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
        if (settlementProvenance) fresh.approvedProvenance = settlementProvenance;
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
    if (!finalMutationApplied) {
      return snapshot(
        result,
        "Review identity changed before settlement; retained review evidence was not applied."
      );
    }
    if (result.status === "approved") {
      if (worktree) {
        await serializeMainTreeOperation(cwd, () => removeWorktree(cwd, worktree));
      }
    }
    if (outcome.aborted) {
      return snapshot(result, "review aborted by user; task stays ready for review");
    }
    if (outcome.exitCode !== 0 || outcome.errorMessage) {
      return snapshot(result, `review failed: ${outcome.errorMessage ?? outcome.exitCode}`);
    }
    if (convergence.status === "disagreement") {
      return snapshot(result, convergence.summary);
    }
    if (convergence.status === "operational_failure") {
      return snapshot(result, convergence.summary);
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
