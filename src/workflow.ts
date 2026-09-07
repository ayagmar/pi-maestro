import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completionFreshness } from "./artifact-policy.js";
import {
  humanRetryEligibility,
  humanRetryRiskToken,
  isRunnableWithConfig,
  isTaskSettled,
  loadBoard,
  planValidationMessage,
  updateTask,
  validatePlan,
} from "./board.js";
import { loadConfig, resolveTierModels } from "./config.js";
import {
  boardUsage,
  launchBudgetShortfall,
  remainingRunBudget,
  runBudgetWarning,
} from "./format.js";
import { mapWithConcurrencyLimit } from "./runner.js";
import { type DriveWait, type MaestroConfig, type Task, type TierConfig } from "./types.js";
import {
  calculateSchedulingWave,
  consumesMaxAttempt,
  DRIVE_ROUND_LIMIT,
  type DriveStopReason,
  type DriveSummary,
  continuesInterruptedAttempt,
  snapshot,
  type TaskSnapshot,
} from "./workflow-policy.js";
import {
  escalatedTask,
  escalationReason,
  noProgressReason,
  newProviderRetryState,
  planProviderRetry,
  providerBlockedReason,
  providerBlockedTask,
  resetOperationalReviewFailures,
  terminalReviewConvergence,
} from "./workflow-stop-policy.js";

export {
  classifyProviderFailure,
  type ProviderFailureClass,
} from "./workflow-stop-policy.js";

import { createQuotaStatusResolver, type QuotaStatusResolver } from "./provider-quota.js";
import { executeTask } from "./workflow-execution.js";
import { reviewTask } from "./workflow-review.js";
import { type StartExecutor, type TrackRun, type WorkflowUpdate } from "./workflow-runtime.js";
import {
  createWorktree,
  inspectGit,
  parkInactiveWorktrees,
  removeUnreferencedCleanWorktree,
  removeWorktree,
  restoreWorktree,
  uncommittedPathsInvisibleToWorktrees,
  type WorktreeRef,
} from "./worktree.js";

export { executeTask } from "./workflow-execution.js";
export {
  type AttemptSnapshot,
  calculateSchedulingWave,
  type DriveStopCode,
  type DriveStopReason,
  type DriveSummary,
  formatDriveSummary,
  lastReport,
  type SchedulingWave,
  simulatePlan,
  snapshot,
  type TaskSnapshot,
} from "./workflow-policy.js";
export { reviewTask } from "./workflow-review.js";
export type {
  StartExecutor,
  TrackRun,
  WorkflowRun,
  WorkflowUpdate,
} from "./workflow-runtime.js";

export type DriveRoundPhase = "run" | "review";
export type DriveRoundUpdate = (round: number, phase: DriveRoundPhase, taskIds: string[]) => void;

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
  isLive?: (taskId: string) => boolean;
  onRetentionWarning?: (warning: string) => void;
  /** Operational notices (isolation escalation, serialization) surfaced to the user. */
  onNotice?: (message: string) => void;
  /** Multiplier on provider retry/quota-probe delays; tests pass 0. Defaults to 1. */
  retryDelayScale?: number;
  /** Provider usage-window lookup; defaults to the Codex usage endpoint. */
  quotaStatus?: QuotaStatusResolver;
  /** Called when the drive starts (wait) and ends (undefined) a deliberate sleep. */
  onWait?: (wait: DriveWait | undefined) => void;
  /** Live run-budget source so mid-drive raises apply at the next boundary. Defaults to the captured config. */
  liveMaxRunCost?: () => number;
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
  let warnedInvisiblePaths = false;
  const providerRetries = newProviderRetryState();
  const quotaWaitMinutes = config.providerQuotaWaitMinutes ?? 360;
  const quotaStatus = options.quotaStatus ?? createQuotaStatusResolver();
  /**
   * Provider-failed tasks either get another automatic launch after a delay
   * (transient hiccup, exhausted quota window) or stop the drive. The wait is
   * abortable and honours a pause request so an operator is never stuck
   * behind a sleeping drive.
   */
  const retryProviderFailures = async (tasks: Task[]): Promise<DriveStopReason | undefined> => {
    const plan = await planProviderRetry(tasks, providerRetries, quotaWaitMinutes, quotaStatus);
    if (plan.kind === "stop") {
      return providerBlockedReason(tasks, providerRetries, quotaWaitMinutes);
    }
    resetOperationalReviewFailures(cwd, tasks);
    options.onNotice?.(`${tasks.map((task) => task.id).join(", ")}: ${plan.note}`);
    const delayMs = plan.delayMs * (options.retryDelayScale ?? 1);
    options.onWait?.({
      until: Date.now() + delayMs,
      reason: plan.note,
      taskIds: tasks.map((task) => task.id),
    });
    let interrupted: Awaited<ReturnType<typeof waitUnlessStopped>>;
    try {
      interrupted = await waitUnlessStopped(delayMs, signal, shouldPause);
    } finally {
      options.onWait?.(undefined);
    }
    if (interrupted === "aborted") return { code: "aborted", message: "drive aborted by user" };
    if (interrupted === "paused") {
      return { code: "paused", message: "drive paused while waiting for provider capacity" };
    }
    return undefined;
  };
  const currentFingerprintConfig = (): MaestroConfig => loadConfig(cwd);
  // The run budget is re-read every time it is consulted, so raising it with
  // /maestro config budget while a drive is running takes effect at the next
  // boundary instead of silently waiting for a restart. Injected by the
  // extension runtime; library and test callers keep the captured config.
  const liveMaxRunCost = options.liveMaxRunCost ?? ((): number => config.maxRunCost);
  let budgetNearlyConsumedWarned = false;
  const humanRetryId = humanRetryTaskId?.trim().toUpperCase();
  const boundedStartExecutor: StartExecutor = (startOptions) => {
    if (rawLaunches >= config.maxTotalLaunchesPerRun) {
      throw new Error(`workflow raw launch limit reached (${config.maxTotalLaunchesPerRun})`);
    }
    rawLaunches += 1;
    return startExecutor(startOptions);
  };

  const selectedTasks = (): Task[] => loadBoard(cwd).tasks.filter(isSelected);
  // Task totals in the summary are board-lifetime; the per-drive delta keeps
  // a no-op resume from re-reporting historical spend as fresh cost.
  const boardCostAtStart = boardUsage(loadBoard(cwd).tasks).cost;
  const finish = (stoppedBecause: DriveStopReason): DriveSummary => ({
    rounds,
    tasks: selectedTasks().map((task) => snapshot(task)),
    stoppedBecause,
    driveCost: Math.max(0, boardUsage(loadBoard(cwd).tasks).cost - boardCostAtStart),
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
      if (!humanRetryTask && tasks.every(isTaskSettled)) {
        return finish({ code: "completed", message: "all selected tasks are settled" });
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
        (task) =>
          task.id.toUpperCase() !== humanRetryId && escalatedTask(task, config.reviewRejectionLimit)
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
      const roundMaxRunCost = liveMaxRunCost();
      const budgetWarning =
        runnable.length > 0
          ? (runBudgetWarning(board.tasks, roundMaxRunCost) ??
            launchBudgetShortfall(board.tasks, {
              maxRunCost: roundMaxRunCost,
              maxCostPerTask: config.maxCostPerTask,
            }))
          : undefined;
      // One advance warning before the wall: the budget stop is never a surprise.
      if (!budgetNearlyConsumedWarned && roundMaxRunCost > 0) {
        const spent = boardUsage(board.tasks).cost;
        if (spent >= roundMaxRunCost * 0.8 && spent <= roundMaxRunCost) {
          budgetNearlyConsumedWarned = true;
          options.onNotice?.(
            `Run budget ${Math.round((spent / roundMaxRunCost) * 100)}% consumed ($${spent.toFixed(2)} of $${roundMaxRunCost}); the drive stops at the cap. Raise it early with /maestro config budget <usd> to avoid the wall.`
          );
        }
      }

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
        let isolateBatch =
          config.useWorktrees ||
          (config.detachedExecutors === true && inspectGit(cwd).ok) ||
          retryEligibility?.kind === "execute";
        // Parallel executors sharing one Git working tree cross-attribute
        // each other's file changes: sibling A's edits land in sibling B's
        // baseline diff, candidate tree, and review scope. Auto-isolate
        // parallel batches in per-task worktrees. Non-Git projects have no
        // content attribution (or worktrees) at all, so they keep the
        // legacy tool-event-only behavior.
        if (
          !isolateBatch &&
          dispatchable.length > 1 &&
          config.maxParallel > 1 &&
          inspectGit(cwd).ok
        ) {
          isolateBatch = true;
          options.onNotice?.(
            `Parallel batch of ${dispatchable.length} tasks isolated in per-task worktrees to keep change attribution exact (useWorktrees is off).`
          );
        }
        // An isolated checkout only contains committed content. Uncommitted
        // files a brief points at (plans, specs, notes) are invisible there,
        // and the executor reports itself blocked on a file the user can see.
        if (isolateBatch && !warnedInvisiblePaths) {
          const invisible = uncommittedPathsInvisibleToWorktrees(cwd);
          if (invisible.length > 0) {
            warnedInvisiblePaths = true;
            const shown = invisible.slice(0, 10).join(", ");
            options.onNotice?.(
              `${invisible.length} uncommitted path(s) are invisible to isolated task checkouts and executors cannot read them: ${shown}${invisible.length > 10 ? `, +${invisible.length - 10} more` : ""}. Commit or stash them if a task brief depends on them.`
            );
          }
        }
        try {
          for (const task of dispatchable) {
            const previous = task.attempts.at(-1);
            // Rejected work, a cost-capped attempt, and an attempt the provider
            // cut off all continue in their own checkout: the edits are there,
            // and a fresh checkout from HEAD would silently discard them.
            const continues =
              task.status === "changes_requested" ||
              (task.status === "failed" && continuesInterruptedAttempt(previous));
            const retained =
              task.id.toUpperCase() !== humanRetryId &&
              continues &&
              previous?.worktreePath &&
              previous.branch
                ? { worktreePath: previous.worktreePath, branch: previous.branch }
                : undefined;
            if (retained) {
              // A checkout the user (or an outside Git command) removed must
              // not abort the whole drive: only this task loses its retained
              // recovery state, and it starts from a fresh baseline instead.
              try {
                worktrees.set(task.id, restoreWorktree(cwd, retained));
              } catch (error) {
                options.onNotice?.(
                  `${task.id}: retained recovery checkout could not be restored (${error instanceof Error ? error.message : String(error)}); starting a fresh attempt from HEAD.`
                );
                if (isolateBatch) {
                  const ref = createWorktree(cwd, task.id, task.attempts.length + 1);
                  created.push(ref);
                  worktrees.set(task.id, ref);
                }
              }
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

        // A launch that starts with less run budget than its per-attempt cap
        // must stop at the budget, not sail past it: the run cap is otherwise
        // only enforced between rounds, after the money is spent.
        const executeBudget = remainingRunBudget(loadBoard(cwd).tasks, liveMaxRunCost());
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
            if (executeBudget !== undefined) executeOptions.remainingRunBudget = executeBudget;
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
        afterRuns.tasks.some((task) => isSelected(task) && !isTaskSettled(task))
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
        const stop = await retryProviderFailures(blockedAfterRuns);
        if (stop) return finish(stop);
        continue;
      }
      const reviewMaxRunCost = liveMaxRunCost();
      const currentBudgetWarning =
        runBudgetWarning(afterRuns.tasks, reviewMaxRunCost) ??
        launchBudgetShortfall(afterRuns.tasks, {
          maxRunCost: reviewMaxRunCost,
          maxCostPerTask: config.maxCostPerTask,
        });
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
        // Reviews on hard tiers can cost nearly as much as the attempts they
        // judge; maxCostPerReview lets an operator cap that separately, and the
        // remaining run budget bounds the launch either way.
        const reviewCostCap =
          config.maxCostPerReview && config.maxCostPerReview > 0
            ? config.maxCostPerReview
            : config.maxCostPerTask;
        const reviewCapSource =
          config.maxCostPerReview && config.maxCostPerReview > 0
            ? "maxCostPerReview"
            : "maxCostPerTask";
        const reviewBudget = remainingRunBudget(afterRuns.tasks, reviewMaxRunCost);
        const reviewLaunchCaps = [reviewCostCap, reviewBudget].filter(
          (cap): cap is number => cap !== undefined && cap > 0
        );
        const reviewLaunchCapSource =
          reviewBudget !== undefined &&
          reviewBudget > 0 &&
          (reviewCostCap <= 0 || reviewBudget < reviewCostCap)
            ? "remaining run budget (maxRunCost)"
            : reviewCapSource;
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
              maxCostPerLaunch: reviewLaunchCaps.length > 0 ? Math.min(...reviewLaunchCaps) : 0,
              maxCostPerLaunchSource: reviewLaunchCapSource,
              availableTiers: Object.keys(config.tiers),
              onUpdate,
              trackRun,
              isLive,
              humanRetry: task.id.toUpperCase() === humanRetryId,
            };
            if (task.id.toUpperCase() === humanRetryId && humanRetryOwnerSession) {
              reviewOptions.humanRetryOwnerSession = humanRetryOwnerSession;
            }
            if (config.pushOnIntegration) reviewOptions.pushOnIntegration = true;
            if (config.verificationProfiles)
              reviewOptions.verificationProfiles = config.verificationProfiles;
            if (config.logEvents !== undefined) reviewOptions.logEvents = config.logEvents;
            if (config.maxLogBytesPerRun !== undefined)
              reviewOptions.maxLogBytes = config.maxLogBytesPerRun;
            reviewOptions.watchdogIdleSeconds = config.watchdogIdleSeconds;
            reviewOptions.watchdogWarningTurns = config.watchdogWarningTurns;
            reviewOptions.watchdogTerminationTurns = config.watchdogTerminationTurns;
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
      if (freshTasks.every(isTaskSettled)) {
        return finish({ code: "completed", message: "all selected tasks are settled" });
      }
      if (rawLaunches >= config.maxTotalLaunchesPerRun) {
        return finish({
          code: "launch_limit",
          message: `raw launch limit reached (${config.maxTotalLaunchesPerRun}); inspect retained launch evidence before starting another drive`,
        });
      }
      const providerBlocked = freshTasks.filter(providerBlockedTask);
      if (providerBlocked.length > 0) {
        const stop = await retryProviderFailures(providerBlocked);
        if (stop) return finish(stop);
        continue;
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
        // A pre-review artifact gate (nothing attributable, contract changed
        // mid-flight, trusted verification failed) is not a reviewer problem.
        // Reporting it as "review operation failed" sent an operator hunting
        // through reviewer evidence that did not exist and then rewriting the
        // review policy, when the cause was printed in the gate notes.
        const gateNotes = reviewerFailures.flatMap((task) => {
          const convergence = task.attempts.at(-1)?.reviewConvergence;
          return convergence?.cause === "gate"
            ? [`${task.id}: ${convergence.summary.split("\n")[0]?.slice(0, 300) ?? ""}`]
            : [];
        });
        return finish({
          code: "reviewer_failure",
          message:
            gateNotes.length === reviewerFailures.length
              ? `artifact gate failed before any reviewer ran — ${gateNotes.join("; ")}`
              : `review operation failed for ${reviewerFailures.map((task) => task.id).join(", ")}; inspect the retained launch evidence before resuming`,
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
          !isTaskSettled(task) &&
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
        const terminal = freshTasks.filter((task) => !isTaskSettled(task));
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
  } finally {
    const liveTaskIds = new Set(
      selectedTasks()
        .filter((task) => isLive(task.id))
        .map((task) => task.id)
    );
    const parking = parkInactiveWorktrees(cwd, loadBoard(cwd), liveTaskIds);
    for (const warning of parking.warnings)
      options.onRetentionWarning?.(`Worktree cleanup: ${warning}`);
  }

  return finish({
    code: "round_limit",
    message: `drive stopped after the hard limit of ${DRIVE_ROUND_LIMIT} rounds`,
  });
}

export { artifactFindings } from "./artifact-policy.js";
export { sessionLabel, taskCommitMessage } from "./workflow-review-policy.js";

/**
 * Sleep that ends early on abort or a pause request (polled every second, the
 * granularity at which operators expect a pause to take effect).
 */
export async function waitUnlessStopped(
  delayMs: number,
  signal: AbortSignal | undefined,
  shouldPause: (() => boolean) | undefined
): Promise<"elapsed" | "aborted" | "paused"> {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return "aborted";
    if (shouldPause?.()) return "paused";
    await new Promise<void>((resolve) => {
      const remaining = Math.min(1_000, deadline - Date.now());
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.max(0, remaining)
      );
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  if (signal?.aborted) return "aborted";
  return shouldPause?.() ? "paused" : "elapsed";
}
