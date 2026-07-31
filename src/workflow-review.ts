import { artifactFindings, captureApprovedProvenance, taskFingerprint } from "./artifact-policy.js";
import {
  findTask,
  humanRetryEligibility,
  loadBoard,
  planValidationMessage,
  stateDir,
  transition,
  updateTask,
  validatePlan,
} from "./board.js";
import { loadConfig } from "./config.js";
import { truncateText } from "./format.js";
import { accountPromptContext, parseVerdict } from "./prompts.js";
import {
  classifyFailure,
  type ExecutorHandle,
  providerFromModel,
  type RunOutcome,
  redactFailureMessage,
  runVerification,
} from "./runner.js";
import {
  type MaestroConfig,
  type ReviewLaunch,
  type Task,
  type TierConfig,
  type VerificationProfile,
} from "./types.js";
import { claimDispatchLifecycle } from "./workflow-dispatch.js";
import { rejectedRunOutcome } from "./workflow-execution.js";
import { integrateReviewedCandidate, removeIntegratedWorktree } from "./workflow-integration.js";
import { lastReport, snapshot, type TaskSnapshot } from "./workflow-policy.js";
import {
  convergenceRecord,
  effectiveRequiredApprovals,
  findingFingerprint,
  policyReviewPrompt,
  reviewEvidence,
  selfReportedBlocker,
  sessionLabel,
  staleExecutionInputsMessage,
} from "./workflow-review-policy.js";
import { type StartExecutor, type TrackRun, type WorkflowUpdate } from "./workflow-runtime.js";
import { parkWorktree, restoreWorktree, snapshotArtifact, type WorktreeRef } from "./worktree.js";

export async function reviewTask(options: {
  cwd: string;
  task: Task;
  tier: TierConfig;
  startExecutor: StartExecutor;
  canStartExecutor?: () => boolean;
  autoCommit?: boolean;
  logEvents?: "compact" | "full" | undefined;
  maxLogBytes?: number | undefined;
  watchdogIdleSeconds?: number | undefined;
  watchdogWarningTurns?: number | undefined;
  watchdogTerminationTurns?: number | undefined;
  reviewRequiredApprovals?: number;
  maxReviewerLaunches?: number;
  /** Abort a reviewer launch once its cost (USD) exceeds this. 0 disables the cap. */
  maxCostPerLaunch?: number;
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
    watchdogIdleSeconds,
    watchdogWarningTurns,
    watchdogTerminationTurns,
    reviewRequiredApprovals = 2,
    maxReviewerLaunches = 4,
    maxCostPerLaunch = 0,
    availableTiers,
    verificationProfiles,
    signal,
    onUpdate,
    trackRun,
    humanRetry = false,
    humanRetryOwnerSession,
    onRetentionWarning,
  } = options;
  const effectiveWatchdogIdleSeconds = tier.watchdogIdleSeconds ?? watchdogIdleSeconds;
  const effectiveWatchdogWarningTurns = tier.watchdogWarningTurns ?? watchdogWarningTurns;
  const effectiveWatchdogTerminationTurns =
    tier.watchdogTerminationTurns ?? watchdogTerminationTurns;
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

  let worktree: WorktreeRef | undefined;
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
    worktree =
      latestAttempt?.worktreePath && latestAttempt.branch
        ? restoreWorktree(cwd, {
            worktreePath: latestAttempt.worktreePath,
            branch: latestAttempt.branch,
          })
        : undefined;
    const candidateCwd = worktree?.worktreePath ?? cwd;
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
    // File-backed auto-commit or worktree reviews require full provenance;
    // report-only investigations use their retained final report as evidence.
    const candidateTree = snapshotArtifact(candidateCwd, candidatePaths);
    // A no-file investigation is complete when its report is reviewed; it
    // does not need a synthetic Git commit merely because autoCommit or
    // worktrees are enabled. File changes still require authoritative
    // artifact and integration proof.
    const requiresIntegration = Boolean(
      candidateTree && (latestAttempt?.worktreePath || autoCommit)
    );
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
            effectiveRequiredApprovals(fresh, reviewPolicy, reviewRequiredApprovals),
            0,
            0,
            notes,
            "gate"
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
          projectCwd: cwd,
          prompt: reviewPrompt,
          tier: launchTier,
          sessionLabel: sessionLabel(task, "review", task.attempts.length),
          runKind: "review",
          // Reviewers were the only launch kind with no cost ceiling, so a
          // runaway reviewer could outspend the executor it was checking.
          ...(maxCostPerLaunch > 0 ? { maxCost: maxCostPerLaunch } : {}),
          ...(logEvents === undefined ? {} : { logEvents }),
          ...(maxLogBytes === undefined ? {} : { maxLogBytes }),
          ...(effectiveWatchdogIdleSeconds === undefined
            ? {}
            : { watchdogIdleSeconds: effectiveWatchdogIdleSeconds }),
          ...(effectiveWatchdogWarningTurns === undefined
            ? {}
            : { watchdogWarningTurns: effectiveWatchdogWarningTurns }),
          ...(effectiveWatchdogTerminationTurns === undefined
            ? {}
            : { watchdogTerminationTurns: effectiveWatchdogTerminationTurns }),
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
            onUpdate(task.id, update, "review");
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
        const criteriaCount = task.successCriteria?.length ?? 0;
        // Criterion corroboration is only meaningful when the task states
        // criteria to corroborate. Investigation and legacy tasks have none,
        // and demanding evidence there rejected every verdict as malformed.
        if (parsed && reviewPolicy !== "single" && criteriaCount > 0) {
          const evidence = reviewEvidence(outcome.finalReport, criteriaCount);
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
        if (reviewPolicy !== "single" && criteriaCount > 0 && !launch.criterionEvidence) {
          return {
            operationalFailure: launch.errorMessage ?? "reviewer criterion evidence invalid",
          };
        }
        return { verdict: parsed, report: outcome.finalReport };
      }
      return { operationalFailure: "reviewer launch failed" };
    };

    // Re-review of work an intact panel already approved costs one reviewer,
    // not a fresh panel. Contested work keeps the full policy.
    const requiredApprovals = effectiveRequiredApprovals(
      dispatch.task,
      reviewPolicy,
      reviewRequiredApprovals
    );
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
      const count = reviewPolicy === "confirm" ? requiredApprovals : 1;
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
    // An executor that states it is blocked has said the work is unfinished.
    // Approving over that silently marks the task done and unblocks its
    // dependents on a foundation the executor itself disclaimed.
    if (verdict?.approved) {
      const selfReported = selfReportedBlocker(report);
      if (selfReported) {
        mechanicalFailure = `The executor reported the work as unfinished ("${selfReported}"), so approval was withheld. Finish the work, or restate the report if the blocker no longer applies.`;
        verdict = { approved: false, notes: mechanicalFailure };
      }
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
    if (verdict?.approved) {
      const integration = await integrateReviewedCandidate({
        cwd,
        task,
        candidateTree,
        candidatePaths,
        worktree,
        autoCommit,
        requiresIntegration,
        configuredProfile,
        fingerprintBeforeIntegration: taskFingerprint(loadBoard(cwd), task, runtimeConfig()),
        signal,
        reviewIdentityMatches,
        runtimeConfig,
      });
      mergeConflict = integration.mergeConflict;
      integratedCommit = integration.integratedCommit;
      integratedTree = integration.integratedTree;
      integrationVerification = integration.verification;
      mechanicalFailure = integration.mechanicalFailure;
      if (mechanicalFailure) verdict = { approved: false, notes: mechanicalFailure };
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
        delete fresh.reviewStagnantRejections;
        // The approved artifact resolved every outstanding finding. Leaving
        // them open re-injects fixed feedback into later executor and reviewer
        // prompts as if it were still outstanding.
        for (const finding of fresh.findings ?? []) {
          if (finding.status === "open") finding.status = "verified";
        }
      } else {
        const notes = verdict.notes || outcome.finalReport;
        transition(fresh, "changes_requested");
        fresh.reviewNotes = notes;
        // Reviewers are contracted to a numbered findings list, but their
        // notes also carry preamble ("Static review confirms:"), section
        // headers, and sometimes the VERDICT line itself. Splitting every
        // line into a "finding" re-injected that prose into retry prompts as
        // if it were a defect. When list items exist, they are the findings.
        const noteLines = notes.split("\n");
        const listItems = noteLines.filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line));
        const messages = (listItems.length > 0 ? listItems : noteLines)
          .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
          .filter(Boolean)
          .filter((line) => !/^\**\s*verdict\s*:/i.test(line))
          .slice(0, 8);
        fresh.findings ??= [];
        const attemptIndex = attempt?.index ?? fresh.attempts.length;
        let repeatsPriorFinding = false;
        for (const message of messages) {
          const fingerprint = findingFingerprint(message);
          const existing = fresh.findings.find((finding) => finding.fingerprint === fingerprint);
          if (existing) {
            // The same defect survived an earlier attempt: this is the
            // stagnation that justifies stopping for human judgment.
            if (existing.lastAttempt < attemptIndex) repeatsPriorFinding = true;
            existing.status = "open";
            existing.lastAttempt = attemptIndex;
          } else {
            fresh.findings.push({
              fingerprint,
              message: redactFailureMessage(message).slice(0, 500),
              status: "open",
              firstAttempt: attemptIndex,
              lastAttempt: attemptIndex,
            });
          }
        }
        fresh.findings = fresh.findings.slice(-16);
        // Mechanical artifact, merge, commit, and verification failures are not
        // reviewer judgments and must not advance rejection escalation.
        if (reviewerRequestedChanges && !mechanicalFailure) {
          fresh.reviewRejections = (fresh.reviewRejections ?? 0) + 1;
          // A rejection that only raises new findings is convergence, not a
          // stuck task; escalating on it stops work that is still improving.
          // The counter is always written so a zero (nothing repeated yet) is
          // distinguishable from a legacy board that never tracked stagnation.
          fresh.reviewStagnantRejections =
            (fresh.reviewStagnantRejections ?? 0) + (repeatsPriorFinding ? 1 : 0);
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
        await removeIntegratedWorktree(cwd, worktree);
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
    if (worktree) {
      try {
        parkWorktree(cwd, worktree);
      } catch (error) {
        onRetentionWarning?.(
          `Worktree cleanup: ${worktree.worktreePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
