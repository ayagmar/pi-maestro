import { basename } from "node:path";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completionFreshness } from "./artifact-policy.js";
import {
  archiveBoard,
  findTask,
  humanRetryEligibility,
  humanRetryRiskToken,
  isTaskSettled,
  listArchivedBoards,
  loadBoard,
  planValidationMessage,
  updateBoard,
  validatePlan,
} from "./board.js";
import { loadConfig, resolveTierModels } from "./config.js";
import { confirmDriveScale, validateDriveStart } from "./drive-preflight.js";
import { formatDrivePulse, unexpectedDriveSummary } from "./drive-summary.js";
import { truncateText } from "./format.js";
import { preflightWorkflow } from "./preflight.js";
import {
  type startExecutor as defaultStartExecutor,
  type ExecutorHandle,
  type RunUpdate,
} from "./runner.js";
import { assertKnownTaskIds } from "./session-control.js";
import {
  type ActiveDriveState,
  type DriveDecision,
  type PausedDriveState,
  type Task,
  type TaskStatus,
  type TierConfig,
} from "./types.js";
import { driveBoard, preflightTaskTiers } from "./workflow.js";
import { type DriveSummary, formatDriveSummary } from "./workflow-policy.js";
import { type WorkflowRun } from "./workflow-runtime.js";

export interface LiveRun {
  taskId: string;
  kind: "execute" | "review";
  turns: number;
  cost: number;
  lastActivity: string;
  handle: ExecutorHandle;
}

export interface ActiveDriveControl {
  id: string;
  cwd: string;
  ownerSession?: string;
  taskIds?: string[];
  pauseRequested: boolean;
  abortController: AbortController;
}

export interface BackgroundDrive {
  promise: Promise<void>;
  summary?: DriveSummary;
  error?: string;
  ownerSession?: string;
  lastPulseStatuses?: Map<string, TaskStatus>;
}

export interface DriveRuntimeServices {
  startExecutor: typeof defaultStartExecutor;
  isRuntimeActive(): boolean;
  adoptBoard(ctx: ExtensionContext): void;
  refreshUI(ctx: ExtensionContext): void;
  /** Throttled refresh for high-frequency executor events. Defaults to refreshUI. */
  refreshUIOnEvent?(ctx: ExtensionContext): void;
  notify(ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error"): void;
  sendDecision(evidence: string, decisionId: string): void;
  onRunStarted(): void;
}

const DELIVERY_CLAIM_STALE_MS = 30_000;

export class DriveRuntimeController {
  private active: ActiveDriveControl | undefined;
  private background: BackgroundDrive | undefined;
  private readonly liveRuns = new Set<LiveRun>();

  hasActive(): boolean {
    return this.active !== undefined;
  }

  activeOwner(): Pick<ActiveDriveControl, "id" | "cwd" | "ownerSession" | "taskIds"> | undefined {
    if (!this.active) return undefined;
    return {
      cwd: this.active.cwd,
      id: this.active.id,
      ...(this.active.ownerSession ? { ownerSession: this.active.ownerSession } : {}),
      ...(this.active.taskIds ? { taskIds: this.active.taskIds } : {}),
    };
  }

  requestPause(): boolean {
    if (!this.active) return false;
    this.active.pauseRequested = true;
    return true;
  }

  abort(): boolean {
    if (!this.active) return false;
    this.active.abortController.abort();
    return true;
  }

  begin(control: ActiveDriveControl): void {
    if (this.active) throw new Error("An autonomous drive is already active.");
    this.active = control;
  }

  finish(control: ActiveDriveControl): void {
    if (this.active === control) this.active = undefined;
  }

  setBackground(operation: BackgroundDrive): void {
    this.background = operation;
  }

  getBackground(): BackgroundDrive | undefined {
    return this.background;
  }

  registerLiveRun(run: LiveRun): void {
    this.liveRuns.add(run);
  }

  removeLiveRun(run: LiveRun): void {
    this.liveRuns.delete(run);
  }

  liveRunCount(): number {
    return this.liveRuns.size;
  }

  liveTaskIds(): Set<string> {
    return new Set([...this.liveRuns].map((run) => run.taskId));
  }

  liveRunKinds(): Map<string, LiveRun["kind"]> {
    return new Map([...this.liveRuns].map((run) => [run.taskId, run.kind] as const));
  }

  isTaskLive(taskId: string): boolean {
    return [...this.liveRuns].some((run) => run.taskId === taskId);
  }

  getLiveRun(taskId: string, kind?: LiveRun["kind"]): LiveRun | undefined {
    let match: LiveRun | undefined;
    for (const run of this.liveRuns) {
      if (run.taskId === taskId && (kind === undefined || run.kind === kind)) match = run;
    }
    return match;
  }

  liveRunValues(): IterableIterator<LiveRun> {
    return this.liveRuns.values();
  }

  clearLiveRuns(): void {
    this.liveRuns.clear();
  }

  startBackgroundDrive(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    services: DriveRuntimeServices,
    signal?: AbortSignal,
    reportProgress: (message: string) => void = () => {},
    humanRetryTaskId?: string,
    humanRetryExpectedRiskToken?: string,
    /**
     * The caller awaits this drive and reports the outcome itself (the
     * maestro_drive tool). Waking the same conversation with a decision
     * message would duplicate that outcome, so the decision is marked
     * delivered instead of sent.
     */
    settleDecisionWithoutWaking = false
  ): BackgroundDrive {
    if (this.hasActive()) throw new Error("An autonomous drive is already active.");
    validateDriveStart(ctx, taskIds);

    const operation: BackgroundDrive = { promise: Promise.resolve() };
    const ownerSession = ctx.sessionManager.getSessionFile();
    if (ownerSession) operation.ownerSession = ownerSession;
    const driveId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const control: ActiveDriveControl = {
      id: driveId,
      cwd: ctx.cwd,
      pauseRequested: false,
      abortController: new AbortController(),
    };
    if (ownerSession) control.ownerSession = ownerSession;
    if (taskIds) control.taskIds = taskIds;

    const reserved = persistActiveDrive(ctx.cwd, {
      id: driveId,
      ...(ownerSession ? { ownerSession } : {}),
      ...(taskIds ? { taskIds } : {}),
      startedAt: Date.now(),
    });
    if (!reserved) throw new Error("Another session already owns an active or paused drive.");

    try {
      this.begin(control);
    } catch (error) {
      const summary = unexpectedDriveSummary(ctx.cwd, taskIds, error);
      persistDriveDecision(ctx.cwd, ownerSession, summary, formatDrivePulse(summary), driveId);
      throw error;
    }

    this.setBackground(operation);
    const statusRefresh = setInterval(() => {
      if (services.isRuntimeActive()) services.refreshUI(ctx);
    }, 1_000);
    statusRefresh.unref();
    operation.promise = this.runControlledDrive(
      ctx,
      control,
      services,
      signal,
      reportProgress,
      humanRetryTaskId,
      humanRetryExpectedRiskToken,
      ownerSession
    )
      .then((summary) => {
        operation.summary = summary;
        const message = formatDrivePulse(summary).slice(0, 4000);
        const persisted = persistDriveDecision(ctx.cwd, ownerSession, summary, message, driveId);
        if (persisted && summary.stoppedBecause.code === "completed") {
          cleanupCompletedBoard(ctx.cwd);
          try {
            const archive = listArchivedBoards(ctx.cwd)[0];
            if (archive && loadBoard(ctx.cwd).tasks.length === 0) {
              services.notify(
                ctx,
                `Run complete — board archived to ${basename(archive.file)}. /maestro replay to revisit, /maestro start <goal> for a new run.`
              );
            }
          } catch {
            // The completion decision is durable; stale session UI must not turn it into an error.
          }
        }
        if (persisted && services.isRuntimeActive()) {
          deliverPendingDecision(
            ctx.cwd,
            ownerSession,
            settleDecisionWithoutWaking ? () => {} : services.sendDecision
          );
        }
      })
      .catch((error) => {
        operation.error = error instanceof Error ? error.message : String(error);
        try {
          const summary = unexpectedDriveSummary(ctx.cwd, taskIds, operation.error);
          const persisted = persistDriveDecision(
            ctx.cwd,
            ownerSession,
            summary,
            formatDrivePulse(summary),
            driveId
          );
          if (persisted && services.isRuntimeActive()) {
            deliverPendingDecision(
              ctx.cwd,
              ownerSession,
              settleDecisionWithoutWaking ? () => {} : services.sendDecision
            );
          }
        } catch (persistenceError) {
          operation.error = `${operation.error}; could not persist internal error: ${String(persistenceError)}`;
        }
      })
      .finally(() => {
        this.finish(control);
        clearInterval(statusRefresh);
        if (services.isRuntimeActive()) services.refreshUI(ctx);
      });
    return this.getBackground() ?? operation;
  }

  savePausedDrive(cwd: string, pausedDrive: PausedDriveState | undefined): void {
    updateBoard(cwd, (board) => {
      if (pausedDrive) board.pausedDrive = pausedDrive;
      else delete board.pausedDrive;
      return true;
    });
  }

  async requestHumanRetry(
    ctx: ExtensionContext,
    requestedTaskId: string,
    services: DriveRuntimeServices
  ): Promise<void> {
    if (this.hasActive() || this.liveRunCount() > 0) {
      services.notify(
        ctx,
        "Retry not started: an autonomous drive or executor is already running.",
        "warning"
      );
      return;
    }
    const previewBoard = loadBoard(ctx.cwd);
    const task = findTask(previewBoard, requestedTaskId);
    const ownerSession = ctx.sessionManager.getSessionFile();
    const eligibility = humanRetryEligibility(previewBoard, requestedTaskId, {
      maxAttempts: loadConfig(ctx.cwd).maxAttempts,
      config: loadConfig(ctx.cwd),
      isLive: (id) => this.isTaskLive(id),
      ...(ownerSession ? { ownerSession } : {}),
    });
    if (!eligibility.eligible || !task) {
      services.notify(ctx, `Retry not started: ${eligibility.message}`, "warning");
      return;
    }

    const riskEvidence = humanRetryRiskToken(task);
    if (eligibility.requiresConfirmation) {
      if (!ctx.hasUI) {
        services.notify(ctx, `Retry not started: ${eligibility.message}`, "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Retry accepted or integrated work?",
        `${task.id} will run in a fresh isolated worktree. Existing attempts and recovery evidence will be preserved.`
      );
      if (!confirmed) {
        services.notify(ctx, "Retry cancelled; accepted work was not changed.", "warning");
        return;
      }
      const currentBoard = loadBoard(ctx.cwd);
      const currentTask = findTask(currentBoard, task.id);
      const currentEligibility = humanRetryEligibility(currentBoard, task.id, {
        maxAttempts: loadConfig(ctx.cwd).maxAttempts,
        config: loadConfig(ctx.cwd),
        isLive: (id) => this.isTaskLive(id),
        ...(ownerSession ? { ownerSession } : {}),
      });
      if (
        !currentTask ||
        !currentEligibility.eligible ||
        humanRetryRiskToken(currentTask) !== riskEvidence
      ) {
        services.notify(
          ctx,
          "Retry not started: task acceptance or integration evidence changed during confirmation.",
          "warning"
        );
        return;
      }
    }
    if (!(await confirmDriveScale(ctx, [task.id]))) {
      services.notify(ctx, "Retry not started: workflow scale was not confirmed.", "warning");
      return;
    }
    const confirmedTask = findTask(loadBoard(ctx.cwd), task.id);
    if (!confirmedTask || humanRetryRiskToken(confirmedTask) !== riskEvidence) {
      services.notify(
        ctx,
        "Retry not started: task acceptance or integration evidence changed; confirm it again.",
        "warning"
      );
      return;
    }

    services.notify(ctx, `Retrying ${task.id} in isolated recovery mode…`);
    const operation = this.startBackgroundDrive(
      ctx,
      [task.id],
      services,
      undefined,
      (message) => services.notify(ctx, message),
      task.id,
      riskEvidence
    );
    void operation.promise.then(() => {
      if (!services.isRuntimeActive()) return;
      if (operation.summary) {
        services.notify(
          ctx,
          formatDriveSummary(operation.summary),
          operation.summary.stoppedBecause.code === "completed" ? "info" : "warning"
        );
      } else if (operation.error) {
        services.notify(ctx, operation.error, "error");
      }
    });
  }

  private async runControlledDrive(
    ctx: ExtensionContext,
    control: ActiveDriveControl,
    services: DriveRuntimeServices,
    signal: AbortSignal | undefined,
    reportProgress: (message: string) => void,
    humanRetryTaskId?: string,
    humanRetryExpectedRiskToken?: string,
    humanRetryOwnerSession?: string
  ): Promise<DriveSummary> {
    const taskIds = control.taskIds;
    const combinedSignal = signal
      ? AbortSignal.any([signal, control.abortController.signal])
      : control.abortController.signal;
    const summary = await this.runDriveWorkflow(
      ctx,
      taskIds,
      services,
      combinedSignal,
      reportProgress,
      () => control.pauseRequested,
      humanRetryTaskId,
      humanRetryExpectedRiskToken,
      humanRetryOwnerSession
    );

    if (
      summary.stoppedBecause.code === "paused" ||
      summary.stoppedBecause.code === "provider_blocked" ||
      summary.stoppedBecause.code === "escalation_required"
    ) {
      const paused: PausedDriveState = {};
      if (taskIds) paused.taskIds = taskIds;
      if (control.ownerSession) paused.ownerSession = control.ownerSession;
      this.savePausedDrive(ctx.cwd, paused);
    }
    return summary;
  }

  private async runDriveWorkflow(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    services: DriveRuntimeServices,
    signal: AbortSignal | undefined,
    reportProgress: (message: string) => void,
    shouldPause?: () => boolean,
    humanRetryTaskId?: string,
    humanRetryExpectedRiskToken?: string,
    humanRetryOwnerSession?: string
  ): Promise<DriveSummary> {
    const config = loadConfig(ctx.cwd);
    const board = loadBoard(ctx.cwd);
    const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
    if (validationError) throw new Error(validationError);
    assertKnownTaskIds(board, taskIds);
    const workflowPreflight = preflightWorkflow(board, config, taskIds);
    if (
      workflowPreflight.requiresConfirmation &&
      board.scaleApproval?.signature !== workflowPreflight.signature
    ) {
      throw new Error(`Workflow scale confirmation is required (${workflowPreflight.signature}).`);
    }
    services.adoptBoard(ctx);

    const selected = taskIds
      ? taskIds.map((id) => findTask(board, id)).filter((task): task is Task => task !== undefined)
      : board.tasks;
    const unresolved = selected.filter(
      (task) => task.status !== "approved" || task.id === humanRetryTaskId
    );
    const resolvedTiers = board.planPending
      ? new Map<string, TierConfig>()
      : preflightTaskTiers(unresolved, config, ctx.modelRegistry, ctx.model?.provider);

    if (!board.planPending && unresolved.length > 0) {
      const reviewTier: TierConfig = {
        ...(config.tiers.review ?? { thinking: "high", tools: "read,grep,find,ls" }),
      };
      const resolution = resolveTierModels(
        "review",
        reviewTier,
        ctx.modelRegistry,
        ctx.model?.provider
      );
      if (!resolution.ok) throw new Error(resolution.error);
      const [primary, ...fallbacks] = resolution.modelArgs;
      if (primary === undefined) delete reviewTier.model;
      else reviewTier.model = primary;
      if (fallbacks.length === 0) delete reviewTier.fallbacks;
      else reviewTier.fallbacks = fallbacks.filter((model): model is string => model !== undefined);
      resolvedTiers.set("review", reviewTier);
    }

    const driveOptions: Parameters<typeof driveBoard>[0] = {
      cwd: ctx.cwd,
      config,
      resolvedTiers,
      startExecutor: services.startExecutor,
      onUpdate: (taskId, update, kind) => this.applyUpdate(ctx, taskId, update, kind, services),
      onRoundUpdate: (round, phase, ids) => {
        const board = loadBoard(ctx.cwd);
        const titles = ids.map((id) => {
          const task = findTask(board, id);
          return task ? `${id} ${task.title.slice(0, 60)}` : id;
        });
        reportProgress(
          `Round ${round} · ${phase === "review" ? "reviewing" : "executing"} ${ids.length} task(s): ${titles.join(" · ")}`
        );
      },
      trackRun: (run) => this.trackRun(ctx, run, services),
      isLive: (taskId) => this.isTaskLive(taskId),
      onRetentionWarning: (warning) =>
        services.notify(ctx, `Log cleanup warning: ${warning}`, "warning"),
      onNotice: (message) => services.notify(ctx, message, "warning"),
    };
    if (taskIds) driveOptions.taskIds = taskIds;
    if (signal) driveOptions.signal = signal;
    if (shouldPause) driveOptions.shouldPause = shouldPause;
    if (humanRetryTaskId) driveOptions.humanRetryTaskId = humanRetryTaskId;
    if (humanRetryExpectedRiskToken) {
      driveOptions.humanRetryExpectedRiskToken = humanRetryExpectedRiskToken;
    }
    if (humanRetryOwnerSession) driveOptions.humanRetryOwnerSession = humanRetryOwnerSession;
    return driveBoard(driveOptions);
  }

  private applyUpdate(
    ctx: ExtensionContext,
    taskId: string,
    update: RunUpdate,
    kind: LiveRun["kind"],
    services: DriveRuntimeServices
  ): void {
    const live = this.getLiveRun(taskId, kind);
    if (live) {
      live.turns = update.turns;
      live.cost = update.cost;
      live.lastActivity = update.lastActivity;
    }
    if (services.isRuntimeActive()) {
      (services.refreshUIOnEvent ?? services.refreshUI)(ctx);
    }
  }

  private trackRun(
    ctx: ExtensionContext,
    run: WorkflowRun,
    services: DriveRuntimeServices
  ): () => void {
    services.onRunStarted();
    this.registerLiveRun(run);
    if (services.isRuntimeActive()) services.refreshUI(ctx);
    queueMicrotask(() => {
      if (services.isRuntimeActive()) services.refreshUI(ctx);
    });
    return () => {
      this.removeLiveRun(run);
      if (services.isRuntimeActive()) services.refreshUI(ctx);
    };
  }

  shutdown(): void {
    // Detached executor transports intentionally outlive the owning Pi
    // runtime. Regular children are still stopped immediately.
    for (const run of this.liveRuns) {
      if (!run.handle.survivesShutdown) run.handle.abort();
    }
    this.liveRuns.clear();
  }
}

export function persistDriveDecision(
  cwd: string,
  ownerSession: string | undefined,
  summary: DriveSummary,
  evidence: string,
  driveId?: string
): boolean {
  return updateBoard(cwd, (board) => {
    if (driveId && board.activeDrive?.id !== driveId) return false;
    board.activeDecision = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...(ownerSession ? { ownerSession } : {}),
      kind: summary.stoppedBecause.code,
      taskIds: (summary.stoppedBecause.taskIds ?? summary.tasks.map((task) => task.id)).slice(
        0,
        64
      ),
      evidence: truncateText(evidence, 4000),
      allowedInterventions: summary.stoppedBecause.code === "completed" ? [] : ["handoff", "abort"],
      createdAt: Date.now(),
    };
    if (driveId) delete board.activeDrive;
    return true;
  });
}

export function resolveDriveDecision(
  cwd: string,
  decisionId: string,
  currentSession: string | undefined,
  intervention: "handoff" | "abort" | "steer"
): DriveDecision {
  return updateBoard(cwd, (board) => {
    const decision = board.activeDecision;
    if (!decision || decision.id !== decisionId || decision.resolution) {
      throw new Error("Decision is stale or already resolved");
    }
    if (decision.ownerSession && decision.ownerSession !== currentSession) {
      throw new Error("Only the decision owner may resolve it");
    }
    const resumesCorrectedBoard =
      intervention === "steer" &&
      (decision.kind === "escalation_required" || decision.kind === "stale_completion");
    if (!decision.allowedInterventions.includes(intervention) && !resumesCorrectedBoard) {
      throw new Error(`${intervention} is not allowed for this decision`);
    }

    decision.resolution = {
      intervention: resumesCorrectedBoard ? "resume" : intervention,
      resolvedAt: Date.now(),
    };
    delete decision.deliveryClaim;
    return decision;
  });
}

export function deliverPendingDecision(
  cwd: string,
  currentSession: string | undefined,
  send: (evidence: string, decisionId: string) => void
): void {
  const claimId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let evidence: string | undefined;
  let decisionId: string | undefined;
  updateBoard(cwd, (board) => {
    const decision = board.activeDecision;
    if (!decision || decision.deliveredAt || decision.resolution) return false;
    if (decision.ownerSession && decision.ownerSession !== currentSession) return false;

    const claim = decision.deliveryClaim;
    if (claim && Date.now() - claim.claimedAt <= DELIVERY_CLAIM_STALE_MS) return false;

    decision.deliveryClaim = { id: claimId, claimedAt: Date.now() };
    evidence = decision.evidence;
    decisionId = decision.id;
    return true;
  });
  if (evidence === undefined) return;

  try {
    send(evidence, decisionId as string);
  } catch {
    updateBoard(cwd, (board) => {
      const decision = board.activeDecision;
      if (!decision || decision.deliveryClaim?.id !== claimId || decision.deliveredAt) return false;
      delete decision.deliveryClaim;
      return true;
    });
    return;
  }

  updateBoard(cwd, (board) => {
    const decision = board.activeDecision;
    if (!decision || decision.deliveryClaim?.id !== claimId || decision.deliveredAt) return false;
    decision.deliveredAt = Date.now();
    delete decision.deliveryClaim;
    return true;
  });
}

export function acknowledgeDeliveredDecision(cwd: string, decisionId: string): boolean {
  return updateBoard(cwd, (board) => {
    const decision = board.activeDecision;
    if (!decision || decision.id !== decisionId || decision.resolution) return false;
    if (decision.deliveredAt) return false;
    decision.deliveredAt = Date.now();
    delete decision.deliveryClaim;
    return true;
  });
}

export function persistActiveDrive(cwd: string, activeDrive: ActiveDriveState): boolean {
  let persisted = false;
  updateBoard(cwd, (board) => {
    if (board.activeDrive && board.activeDrive.id !== activeDrive.id) return false;
    if (board.pausedDrive && board.pausedDrive.ownerSession !== activeDrive.ownerSession) {
      return false;
    }
    if (board.activeDecision && !board.activeDecision.resolution) {
      if (board.activeDecision.ownerSession !== activeDrive.ownerSession) return false;
      if (board.activeDecision.kind !== "stale_completion") {
        board.activeDecision.resolution = { intervention: "resume", resolvedAt: Date.now() };
        delete board.activeDecision.deliveryClaim;
      }
    }
    delete board.pausedDrive;
    board.activeDrive = activeDrive;
    persisted = true;
    return true;
  });
  return persisted;
}

export function clearActiveDrive(cwd: string, driveId: string): boolean {
  let cleared = false;
  updateBoard(cwd, (board) => {
    if (board.activeDrive?.id !== driveId) return false;
    delete board.activeDrive;
    cleared = true;
    return true;
  });
  return cleared;
}

export function cleanupCompletedBoard(cwd: string): void {
  const config = loadConfig(cwd);
  if (!(config.cleanupCompletedTasks ?? true)) return;

  updateBoard(cwd, (board) => {
    if (
      board.tasks.length === 0 ||
      board.tasks.some(
        (task) =>
          !isTaskSettled(task) ||
          (task.status === "approved" && completionFreshness(board, task, config).state !== "fresh")
      )
    ) {
      return false;
    }

    archiveBoard(cwd);
    board.nextTaskNumber = 1;
    board.tasks = [];
    delete board.goal;
    delete board.planPending;
    delete board.pausedDrive;
    return true;
  });
}
