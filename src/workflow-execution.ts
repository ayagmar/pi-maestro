import { taskFingerprint } from "./artifact-policy.js";
import {
  DETACHED_DISPATCH_LEASE_MS,
  findTask,
  forceStatus,
  humanRetryEligibility,
  humanRetryRiskToken,
  isReadOnlyTask,
  isRunnableWithConfig,
  loadBoard,
  planValidationMessage,
  releaseTaskDispatch,
  stateDir,
  transition,
  updateTask,
  validatePlan,
} from "./board.js";
import { loadConfig } from "./config.js";
import { MAX_DISCOVERY_REPORT_BYTES } from "./constants.js";
import { DISCOVERY_TOOLS, discoveryInstructions } from "./discovery.js";
import { accountPromptContext, buildExecutorPrompt } from "./prompts.js";
import {
  classifyFailure,
  type ExecutorHandle,
  providerFromModel,
  type RunOutcome,
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
import { claimDispatchLifecycle } from "./workflow-dispatch.js";
import {
  consumesMaxAttempt,
  endedUnretryably,
  lastReport,
  snapshot,
  type TaskSnapshot,
} from "./workflow-policy.js";
import { sessionLabel } from "./workflow-review-policy.js";
import { type StartExecutor, type TrackRun, type WorkflowUpdate } from "./workflow-runtime.js";
import {
  captureChangeBaseline,
  captureDiff,
  changedPaths,
  changedPathsSinceBaseline,
  type WorktreeRef,
  worktreeExists,
} from "./worktree.js";

export async function executeTask(options: {
  cwd: string;
  board: Board;
  task: Task;
  tier: TierConfig;
  config: MaestroConfig;
  worktree?: WorktreeRef;
  startExecutor: StartExecutor;
  canStartExecutor?: () => boolean;
  /** USD left before the run budget blocks the drive; bounds this launch's cost cap. */
  remainingRunBudget?: number;
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
    remainingRunBudget,
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

  // A cost cap is not a defect in the work: the attempt was cut off mid-flight
  // with its edits intact. Sending the user to write a successor brief hides
  // that the fix is usually one number.
  const terminal = endedUnretryably(task) ? task.attempts.at(-1)?.failureReason : undefined;
  if (terminal?.kind === "cost_cap") {
    const updated = updateTask(cwd, task.id, (fresh) => {
      forceStatus(fresh, "failed");
    });
    const spent = task.attempts.at(-1)?.usage.cost ?? 0;
    const guidance = `stopped by the per-attempt cost cap at $${spent.toFixed(2)} (maxCostPerTask $${config.maxCostPerTask}); its edits are kept. Raise maxCostPerTask for a task this size, or split it into smaller tasks. Retrying unchanged stops at the same point.`;
    const result = snapshot(updated ?? task, guidance);
    delete result.retryAction;
    result.note = guidance;
    return result;
  }

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
    const watchdogIdleSeconds = tier.watchdogIdleSeconds ?? config.watchdogIdleSeconds;
    const watchdogWarningTurns = tier.watchdogWarningTurns ?? config.watchdogWarningTurns;
    const watchdogTerminationTurns =
      tier.watchdogTerminationTurns ?? config.watchdogTerminationTurns;
    // Without a worktree the executor mutates the shared checkout directly.
    // Tool events under-report bash mutations (sed -i, git apply, codegen),
    // so attribute changes by content against a pre-run Git baseline instead.
    const changeBaseline = worktree ? undefined : captureChangeBaseline(cwd);
    const runOptions: Parameters<StartExecutor>[0] = {
      stateDir: stateDir(cwd),
      runId: `${task.id}-attempt-${attemptIndex}`,
      cwd: worktree?.worktreePath ?? cwd,
      projectCwd: cwd,
      prompt,
      tier: attemptTier,
      sessionLabel: sessionLabel(task, "attempt", attemptIndex),
      ...(config.logEvents === undefined ? {} : { logEvents: config.logEvents }),
      ...(config.maxLogBytesPerRun === undefined ? {} : { maxLogBytes: config.maxLogBytesPerRun }),
      ...(watchdogIdleSeconds === undefined ? {} : { watchdogIdleSeconds }),
      ...(watchdogWarningTurns === undefined ? {} : { watchdogWarningTurns }),
      ...(watchdogTerminationTurns === undefined ? {} : { watchdogTerminationTurns }),
      runKind: isReadOnlyTask(task) ? "investigation" : "implementation",
      ...(task.discovery
        ? { maxReportChars: MAX_DISCOVERY_REPORT_BYTES, maxReportBytes: MAX_DISCOVERY_REPORT_BYTES }
        : {}),
      ...(config.detachedExecutors ? { detached: true } : {}),
      onUpdate: (update) => {
        const sessionFile = update.sessionFile;
        if (sessionFile) {
          updateTask(cwd, task.id, (fresh) => {
            const attempt = fresh.attempts.find((candidate) => candidate.index === attemptIndex);
            if (attempt) attempt.sessionFile = sessionFile;
          });
        }
        onUpdate(task.id, update, "execute");
      },
    };
    if (signal) runOptions.signal = signal;
    // The per-attempt cap and the remaining run budget both bound this launch;
    // without the run-budget bound, a launch dispatched just under the run cap
    // could overshoot it by a full attempt before the next between-round check.
    const launchCostCaps = [config.maxCostPerTask, remainingRunBudget].filter(
      (cap): cap is number => cap !== undefined && cap > 0
    );
    if (launchCostCaps.length > 0) runOptions.maxCost = Math.min(...launchCostCaps);

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
    if (run.attempt.detached) {
      lifecycle.extendLease?.(DETACHED_DISPATCH_LEASE_MS);
    }

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
    const priorWorktreeFiles =
      worktree && task.attempts.at(-1)?.branch === worktree.branch
        ? (task.attempts.at(-1)?.touchedFiles ?? [])
        : [];
    const baselineChanges = changeBaseline
      ? changedPathsSinceBaseline(cwd, changeBaseline)
      : undefined;
    run.attempt.touchedFiles =
      worktree && worktreeExists(worktree)
        ? [...new Set([...priorWorktreeFiles, ...changedPaths(worktree.worktreePath)])].sort()
        : [...new Set([...outcome.touchedFiles, ...(baselineChanges ?? [])])].sort();

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

export function settleReattachedDetachedAttempt(
  cwd: string,
  taskId: string,
  claimId: string,
  attempt: Attempt,
  outcome: RunOutcome
): Task | undefined {
  attempt.usage = { ...outcome.usage };
  attempt.finalReport = outcome.finalReport;
  attempt.exitCode = outcome.exitCode;
  attempt.endedAt ??= Date.now();
  if (outcome.model) attempt.model = outcome.model;
  if (outcome.errorMessage) attempt.errorMessage = redactFailureMessage(outcome.errorMessage);
  const failureReason = classifyFailure(outcome);
  if (failureReason) attempt.failureReason = failureReason;
  if (
    attempt.worktreePath &&
    worktreeExists({
      worktreePath: attempt.worktreePath,
      branch: attempt.branch ?? "",
    })
  ) {
    attempt.touchedFiles = changedPaths(attempt.worktreePath);
  } else {
    attempt.touchedFiles = [...outcome.touchedFiles];
  }
  const status: TaskStatus = outcome.aborted
    ? "cancelled"
    : outcome.exitCode === 0 && !outcome.errorMessage
      ? "ready_for_review"
      : "failed";
  if (status === "ready_for_review") {
    try {
      const diff = captureDiff(
        attempt.worktreePath ?? cwd,
        attempt.worktreePath ? undefined : attempt.touchedFiles
      );
      if (diff) attempt.diff = diff;
    } catch {
      // Display diff remains best-effort; the worktree is the authoritative candidate.
    }
  }
  const updated = updateTask(cwd, taskId, (task) => {
    if (task.dispatchClaim?.id !== claimId) return;
    transition(task, status);
    const index = task.attempts.findIndex((candidate) => candidate.index === attempt.index);
    if (index >= 0) task.attempts[index] = attempt;
  });
  releaseTaskDispatch(cwd, taskId, claimId);
  return updated;
}

export function rejectedRunOutcome(run: ExecutorHandle, error: unknown): RunOutcome {
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
