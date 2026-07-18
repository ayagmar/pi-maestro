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
import { runBudgetWarning } from "./format.js";
import { mapWithConcurrencyLimit } from "./runner.js";
import { type MaestroConfig, type Task, type TierConfig } from "./types.js";
import {
  calculateSchedulingWave,
  consumesMaxAttempt,
  DRIVE_ROUND_LIMIT,
  type DriveStopReason,
  type DriveSummary,
  snapshot,
  type TaskSnapshot,
} from "./workflow-policy.js";
import {
  escalatedTask,
  escalationReason,
  noProgressReason,
  providerBlockedReason,
  providerBlockedTask,
  scheduleTransientProviderRetry,
  terminalReviewConvergence,
} from "./workflow-stop-policy.js";

export {
  classifyProviderFailure,
  type ProviderFailureClass,
} from "./workflow-stop-policy.js";

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
        let isolateBatch = config.useWorktrees || retryEligibility?.kind === "execute";
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
        try {
          for (const task of dispatchable) {
            const previous = task.attempts.at(-1);
            const retained =
              task.id.toUpperCase() !== humanRetryId &&
              task.status === "changes_requested" &&
              previous?.worktreePath &&
              previous.branch
                ? { worktreePath: previous.worktreePath, branch: previous.branch }
                : undefined;
            if (retained) {
              worktrees.set(task.id, restoreWorktree(cwd, retained));
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
