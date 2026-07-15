import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  type OverlayHandle,
  type SelectItem,
  Text,
} from "@earendil-works/pi-tui";
import { completionFreshness } from "./artifact-policy.js";
import {
  assertTaskNotDispatched,
  consumeQuarantineNotice,
  findTask,
  forceStatus,
  humanRetryEligibility,
  humanRetryRiskToken,
  latestArchiveFile,
  listArchivedBoards,
  loadArchivedBoard,
  loadBoard,
  loadStatusHistory,
  planValidationMessage,
  replaceBoard,
  replaceBoardWithArchive,
  restoreArchivedBoard,
  restoreQuarantineNotice,
  sweepDispatchState,
  updateBoard,
  updateTask,
  validatePlan,
} from "./board.js";
import { MaestroCommandCompletions } from "./command-completions.js";
import { handleDiscoveryCommand, handleRecipeCommand } from "./command-recipes.js";
import { pickFromList } from "./command-ui.js";
import { parseCommand, registerMaestroCommand } from "./commands.js";
import {
  describeConfig,
  describeTiersForPlanning,
  loadConfig,
  resolveTierModels,
} from "./config.js";
import { COMMAND, CONTEXT_NUDGE_PERCENT, MESSAGE_TYPE } from "./constants.js";
import {
  Dashboard,
  type DashboardTaskAction,
  LivePaneComponent,
  type LivePaneLaunch,
} from "./dashboard.js";
import { buildDoctorReport } from "./diagnostics.js";
import {
  type ActiveDriveControl,
  acknowledgeDeliveredDecision,
  type BackgroundDrive,
  cleanupCompletedBoard,
  DriveRuntimeController,
  deliverPendingDecision,
  persistActiveDrive,
  persistDriveDecision,
} from "./drive-controller.js";
import { confirmDriveScale, validateDriveStart } from "./drive-preflight.js";
import { formatDrivePulse, unexpectedDriveSummary } from "./drive-summary.js";
import {
  boardUsage,
  formatBoardProgress,
  formatCostSummary,
  formatStatusHistory,
} from "./format.js";
import { notify, runHandoff } from "./handoff.js";
import { collectLivePaneLaunches } from "./live-pane-launches.js";
import { manuallyApproveTask } from "./manual-approval.js";
import { showPlanReview } from "./plan-review-controller.js";
import {
  comparePlans,
  exportPlan,
  formatPlanComparison,
  importPlan,
} from "./plan-serialization.js";
import { preflightWorkflow } from "./preflight.js";
import { buildOrchestratorBriefing, buildSupervisorBriefing } from "./prompts.js";
import {
  captureBoardLogs,
  cleanupStaleLogs,
  inspectLogRetention,
  pruneStaleLogs,
  pruneTaskLogs,
} from "./retention.js";
import {
  startExecutor as defaultStartExecutor,
  findSessionFile,
  type RunUpdate,
} from "./runner.js";
import {
  assertKnownTaskIds,
  canonicalTaskIds,
  maestroBoardCwd,
  previousBoardSession,
  sessionCanControlDrive,
  sessionSwitchBlocked,
} from "./session-control.js";
import { SessionNavigator } from "./session-navigator.js";
import { showSettings } from "./settings-ui.js";
import { projectStatus } from "./status.js";
import { showTaskBrowser } from "./task-browser.js";
import { deriveRunTimeline, formatRunTimeline } from "./timeline.js";

export {
  assertKnownTaskIds,
  maestroBoardCwd,
  previousBoardSession,
  sessionCanControlDrive,
  sessionSwitchBlocked,
} from "./session-control.js";

import { registerMaestroTools } from "./tools.js";
import { type Board, type PausedDriveState, type Task, type TierConfig } from "./types.js";
import {
  type DriveSummary,
  driveBoard,
  formatDriveSummary,
  lastReport,
  preflightTaskTiers,
  simulatePlan,
  type WorkflowRun,
} from "./workflow.js";
import { showWorkflowBrowser } from "./workflow-browser.js";
import {
  cleanupManagedWorktrees,
  inspectGit,
  inspectManagedWorktrees,
  sweepWorktrees,
  worktreeExists,
} from "./worktree.js";

export { formatPlanReviewMarkdown } from "./plan-review.js";
export { scrollableTextOffset } from "./scrollable-viewer.js";

export interface MaestroDependencies {
  startExecutor: typeof defaultStartExecutor;
}

interface LivePaneRuntime {
  handle?: OverlayHandle;
  component?: LivePaneComponent;
  done?: () => void;
  isResponsiveVisible?: () => boolean;
  closing: boolean;
}

const livePaneResponsiveVisibility = (width: number): boolean => width >= 100;

export default function maestro(
  pi: ExtensionAPI,
  dependencies: MaestroDependencies = { startExecutor: defaultStartExecutor }
) {
  // Inside a spawned executor the extension must be inert: no recursive
  // orchestration, and no session_start crash-recovery fighting the parent
  // over the shared board file.
  if (process.env.PI_MAESTRO_EXECUTOR === "1") return;

  const liveRuns = new Map<string, WorkflowRun>();
  const driveController = new DriveRuntimeController();
  const sessionNavigator = new SessionNavigator({
    hasActiveDrive: () => driveController.hasActive(),
    liveRunCount: () => liveRuns.size,
    isTaskLive: (taskId) => liveRuns.has(taskId),
  });
  let runtimeActive = true;
  let contextNudgeShown = false;
  const commandCompletions = new MaestroCommandCompletions(process.cwd());
  let livePane: LivePaneRuntime | undefined;
  let suppressedAutoPaneDriveId: string | undefined;

  function sessionOwnsBoard(ctx: ExtensionContext, board: Board): boolean {
    if (!board.ownerSessions || board.ownerSessions.length === 0) return true; // legacy board
    const current = ctx.sessionManager.getSessionFile();
    if (!current) return true; // print/RPC mode: no session identity to scope by
    return board.ownerSessions.includes(current);
  }

  /**
   * Orchestrator sessions otherwise show up as "(no messages)" in the
   * session picker: their first entry is a custom briefing, not a user
   * message pi can derive a title from.
   */
  function nameSessionAfterGoal(ctx: ExtensionContext, goal: string, role: string): void {
    if (ctx.sessionManager.getSessionName()) return; // don't overwrite a user-chosen name
    const summary = goal.length > 48 ? `${goal.slice(0, 48)}…` : goal;
    pi.setSessionName(`${role}: ${summary}`);
  }

  /** Record the current session as an owner of the board (idempotent). */
  function adoptBoard(ctx: ExtensionContext): void {
    const current = ctx.sessionManager.getSessionFile();
    if (!current) return;
    updateBoard(ctx.cwd, (board) => {
      if (board.ownerSessions?.includes(current)) return false;
      board.ownerSessions = [...(board.ownerSessions ?? []), current];
      return true;
    });
  }

  function labelCurrentEntry(ctx: ExtensionContext, label: string): void {
    const entryId = ctx.sessionManager.getLeafId();
    if (entryId) pi.setLabel(entryId, label);
  }

  function notifyQuarantine(ctx: ExtensionContext): void {
    const quarantined = consumeQuarantineNotice();
    if (!quarantined) return;
    try {
      notify(
        ctx,
        `Board was corrupt and quarantined to ${quarantined}. Restore an archive with /maestro replay.`,
        "warning"
      );
    } catch {
      // ctx went stale mid-command (e.g. a session-switching subcommand);
      // re-stash the notice so the next live ctx can surface it.
      restoreQuarantineNotice(quarantined);
    }
  }

  function currentDriveId(): string | undefined {
    return driveController.activeOwner()?.id;
  }

  function livePaneLaunches(ctx: ExtensionContext): LivePaneLaunch[] {
    return collectLivePaneLaunches(ctx.cwd, liveRuns);
  }

  function watchedLiveRunCount(): number {
    return liveRuns.size;
  }

  function canShowLivePane(ctx: ExtensionContext): boolean {
    if (ctx.mode !== "tui") return false;
    return sessionOwnsBoard(ctx, loadBoard(ctx.cwd));
  }

  function livePaneIsVisible(_width: number): boolean {
    const pane = livePane;
    if (!pane?.handle || pane.closing || pane.handle.isHidden()) return false;
    return pane.isResponsiveVisible?.() ?? true;
  }

  function closeLivePane(): void {
    const pane = livePane;
    if (!pane || pane.closing || !pane.done) return;
    pane.closing = true;
    livePane = undefined;
    pane.done();
  }

  function openLivePane(ctx: ExtensionContext, focused: boolean): void {
    if (livePane || !canShowLivePane(ctx)) return;
    if (livePaneLaunches(ctx).length === 0) {
      if (focused)
        notify(ctx, `No Maestro agent sessions yet. Start a drive, then open /${COMMAND} agents.`);
      return;
    }

    const pane: LivePaneRuntime = { closing: false };
    livePane = pane;
    let completion: Promise<void>;
    try {
      completion = ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          pane.done = () => done(undefined);
          pane.isResponsiveVisible = () =>
            focused || livePaneResponsiveVisibility(tui.terminal.columns);
          pane.component = new LivePaneComponent(theme, {
            getLaunches: () => livePaneLaunches(ctx),
            getHeight: () => Math.max(1, Math.floor(tui.terminal.rows * 0.8)),
            requestRender: () => tui.requestRender(),
            tui,
            cwd: ctx.cwd,
            onEscape: () => {
              if (focused) closeLivePane();
              else pane.handle?.unfocus();
              refreshUI(ctx);
            },
            onCycleVisibility: () => cycleLivePane(ctx),
            onSteer: (launch, message) => {
              liveRuns.get(launch.taskId)?.handle.steer(message);
            },
            onFollowUp: (launch, message) => {
              liveRuns.get(launch.taskId)?.handle.followUp(message);
            },
            ...(isCommandContext(ctx)
              ? {
                  canOpenSession: () =>
                    !sessionSwitchBlocked(driveController.hasActive(), liveRuns.size),
                  onOpenSession: (launch: LivePaneLaunch) => {
                    if (!launch.sessionFile) return;
                    void (async () => {
                      const confirmed = await ctx.ui.confirm(
                        "Open agent session in Pi?",
                        `Switch to ${launch.taskId}'s ${launch.kind} session? Use /${COMMAND} back to return.`
                      );
                      if (!confirmed) return;
                      closeLivePane();
                      await sessionNavigator.switchWithReturn(ctx, launch.sessionFile as string);
                    })();
                  },
                }
              : {}),
          });
          return pane.component;
        },
        {
          overlay: true,
          overlayOptions: focused
            ? {
                anchor: "center",
                width: "92%",
                maxHeight: "92%",
                margin: 1,
              }
            : {
                anchor: "right-center",
                width: "45%",
                maxHeight: "80%",
                visible: livePaneResponsiveVisibility,
              },
          onHandle: (handle) => {
            pane.handle = handle;
            if (!runtimeActive || livePaneLaunches(ctx).length === 0 || !canShowLivePane(ctx)) {
              closeLivePane();
              return;
            }
            if (focused) handle.focus();
            else handle.unfocus();
            refreshUI(ctx);
          },
        }
      );
    } catch {
      pane.component?.dispose();
      if (livePane === pane) livePane = undefined;
      return;
    }

    const finish = () => {
      if (livePane === pane) livePane = undefined;
      if (runtimeActive) refreshUI(ctx);
    };
    void completion.then(finish, finish);
  }

  function syncLivePane(ctx: ExtensionContext): void {
    if (livePane && (!canShowLivePane(ctx) || livePaneLaunches(ctx).length === 0)) {
      closeLivePane();
      return;
    }
    if (
      !livePane &&
      watchedLiveRunCount() > 0 &&
      loadConfig(ctx.cwd).livePanes &&
      suppressedAutoPaneDriveId !== currentDriveId()
    ) {
      openLivePane(ctx, false);
    }
  }

  function cycleLivePane(ctx: ExtensionContext): void {
    if (!canShowLivePane(ctx)) {
      notify(
        ctx,
        "Agent sessions are available only in the owning interactive TUI session.",
        "warning"
      );
      return;
    }
    if (livePane) {
      if (!livePane.isResponsiveVisible?.()) {
        suppressedAutoPaneDriveId = currentDriveId();
        closeLivePane();
        openLivePane(ctx, true);
        refreshUI(ctx);
        return;
      }
      if (!livePane.handle?.isFocused()) {
        livePane.handle?.focus();
        refreshUI(ctx);
        return;
      }
      suppressedAutoPaneDriveId = currentDriveId();
      closeLivePane();
      refreshUI(ctx);
      return;
    }
    openLivePane(ctx, true);
  }

  function refreshUI(ctx: ExtensionContext): void {
    // Executor stdout events outlive session switches; any access on a stale
    // ctx throws. Skip — the next session's events arrive with a live ctx.
    try {
      if (!ctx.hasUI) return;
    } catch {
      return;
    }
    const board = loadBoard(ctx.cwd);
    notifyQuarantine(ctx);
    syncLivePane(ctx);

    // Sessions that never touched this board (fresh /maestro-less chats in
    // the same repo) don't get its status bar. Live runs always show:
    // this process owns them regardless of which session spawned them.
    const showBoard = sessionOwnsBoard(ctx, board) || liveRuns.size > 0;
    if (board.tasks.length === 0 || !showBoard) {
      ctx.ui.setStatus(COMMAND, undefined);
      ctx.ui.setWidget(COMMAND, undefined);
      ctx.ui.setWorkingMessage();
      return;
    }

    const progress = formatBoardProgress(board.tasks);
    const status = projectStatus(board, liveRuns.keys(), loadConfig(ctx.cwd));
    const running = status.running;
    const usage = boardUsage(board.tasks);
    const runningPart = running > 0 ? ` · ${running} running` : "";
    const reviewPart = status.reviewable > 0 ? ` · ${status.reviewable} review` : "";
    const blockedPart = status.blocked > 0 ? ` · ${status.blocked} blocked` : "";
    const pausedPart = board.pausedDrive ? " · paused" : "";
    const planPart = board.planPending ? " · plan awaiting approval" : "";
    ctx.ui.setStatus(
      COMMAND,
      ctx.ui.theme.fg(
        running > 0 || board.pausedDrive ? "warning" : "muted",
        `⚡ maestro ${status.code} · ${progress}${runningPart}${reviewPart}${blockedPart}${pausedPart}${planPart} · $${usage.cost.toFixed(4)}`
      )
    );

    if (running === 0) {
      ctx.ui.setWidget(COMMAND, undefined);
      ctx.ui.setWorkingMessage();
      return;
    }
    ctx.ui.setWorkingMessage(`maestro · ${running} executor(s) · $${usage.cost.toFixed(2)}`);
    ctx.ui.setWidget(COMMAND, (tui, theme) => {
      const lines = [...liveRuns.values()].map((run) => {
        const task = findTask(board, run.taskId);
        const title = task ? task.title : run.taskId;
        const label = run.kind === "review" ? "reviewing" : "running";
        return (
          theme.fg("warning", "◐ ") +
          theme.fg("accent", `${run.taskId} `) +
          title +
          theme.fg(
            "dim",
            ` · ${label} · ${run.turns} turns · $${run.cost.toFixed(4)} · ${run.lastActivity}`
          )
        );
      });
      return {
        render: () => (livePaneIsVisible(tui.terminal.columns) ? [] : lines),
        invalidate: () => {},
      };
    });
  }

  function applyUpdate(
    ctx: ExtensionContext,
    taskId: string,
    update: RunUpdate,
    onProgress: () => void
  ): void {
    const live = liveRuns.get(taskId);
    if (live) {
      live.turns = update.turns;
      live.cost = update.cost;
      live.lastActivity = update.lastActivity;
    }
    if (runtimeActive) refreshUI(ctx);
    onProgress();
  }

  function trackRun(ctx: ExtensionContext, run: WorkflowRun): () => void {
    if (suppressedAutoPaneDriveId !== currentDriveId()) suppressedAutoPaneDriveId = undefined;
    liveRuns.set(run.taskId, run);
    if (runtimeActive) refreshUI(ctx);
    // The workflow persists the running state immediately after registration.
    // Refresh again once that synchronous mutation has completed.
    queueMicrotask(() => {
      if (runtimeActive) refreshUI(ctx);
    });
    return () => {
      liveRuns.delete(run.taskId);
      if (runtimeActive) refreshUI(ctx);
    };
  }

  async function runDriveWorkflow(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
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
    adoptBoard(ctx);

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
        ...(config.tiers.review ?? { thinking: "high", tools: "read,bash,grep,find,ls" }),
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
      startExecutor: dependencies.startExecutor,
      onUpdate: (taskId, update) => applyUpdate(ctx, taskId, update, () => {}),
      onRoundUpdate: (round, phase, ids) => {
        reportProgress(`Round ${round}: ${phase} ${ids.join(", ")}`);
      },
      trackRun: (run) => trackRun(ctx, run),
      isLive: (taskId) => liveRuns.has(taskId),
      onRetentionWarning: (warning) => notify(ctx, `Log cleanup warning: ${warning}`, "warning"),
    };
    if (taskIds) driveOptions.taskIds = taskIds;
    if (signal) driveOptions.signal = signal;
    if (shouldPause) driveOptions.shouldPause = shouldPause;
    if (humanRetryTaskId) driveOptions.humanRetryTaskId = humanRetryTaskId;
    if (humanRetryExpectedRiskToken)
      driveOptions.humanRetryExpectedRiskToken = humanRetryExpectedRiskToken;
    if (humanRetryOwnerSession) driveOptions.humanRetryOwnerSession = humanRetryOwnerSession;
    return driveBoard(driveOptions);
  }

  function sendDecision(evidence: string, decisionId: string): void {
    if (!runtimeActive) throw new Error("Maestro session runtime is no longer active.");
    pi.sendMessage(
      { customType: MESSAGE_TYPE, content: evidence, display: true, details: { decisionId } },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  }

  function startBackgroundDrive(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    signal?: AbortSignal,
    reportProgress: (message: string) => void = () => {},
    humanRetryTaskId?: string,
    humanRetryExpectedRiskToken?: string
  ): BackgroundDrive {
    if (driveController.hasActive()) throw new Error("An autonomous drive is already active.");
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
    if (!reserved) {
      throw new Error("Another session already owns an active or paused drive.");
    }
    try {
      driveController.begin(control);
    } catch (error) {
      const summary = unexpectedDriveSummary(ctx.cwd, taskIds, error);
      persistDriveDecision(ctx.cwd, ownerSession, summary, formatDrivePulse(summary), driveId);
      throw error;
    }
    driveController.setBackground(operation);
    const statusRefresh = setInterval(() => {
      if (runtimeActive) refreshUI(ctx);
    }, 1_000);
    statusRefresh.unref();
    operation.promise = runControlledDrive(
      ctx,
      control,
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
              notify(
                ctx,
                `Run complete — board archived to ${basename(archive.file)}. /maestro replay to revisit, /maestro start <goal> for a new run.`
              );
            }
          } catch {
            // The completion decision is durable; stale session UI must not turn it into an error.
          }
        }
        if (persisted && runtimeActive) {
          deliverPendingDecision(ctx.cwd, ownerSession, sendDecision);
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
          if (persisted && runtimeActive) {
            deliverPendingDecision(ctx.cwd, ownerSession, sendDecision);
          }
        } catch (persistenceError) {
          operation.error = `${operation.error}; could not persist internal error: ${String(persistenceError)}`;
        }
      })
      .finally(() => {
        driveController.finish(control);
        clearInterval(statusRefresh);
        if (runtimeActive) refreshUI(ctx);
      });
    return driveController.getBackground() ?? operation;
  }

  function savePausedDrive(cwd: string, pausedDrive: PausedDriveState | undefined): void {
    updateBoard(cwd, (board) => {
      if (pausedDrive) board.pausedDrive = pausedDrive;
      else delete board.pausedDrive;
      return true;
    });
  }

  async function runControlledDrive(
    ctx: ExtensionContext,
    control: ActiveDriveControl,
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
    const summary = await runDriveWorkflow(
      ctx,
      taskIds,
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
      savePausedDrive(ctx.cwd, paused);
    }
    return summary;
  }

  function sessionContainsDecision(ctx: ExtensionContext, decisionId: string): boolean {
    const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
      getEntries?: () => unknown[];
    };
    if (typeof sessionManager.getEntries !== "function") return false;
    return sessionManager.getEntries().some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as unknown as Record<string, unknown>;
      const details = record.details;
      if (
        details &&
        typeof details === "object" &&
        (details as Record<string, unknown>).decisionId === decisionId
      ) {
        return true;
      }
      const message = record.message;
      if (!message || typeof message !== "object") return false;
      const messageDetails = (message as Record<string, unknown>).details;
      return (
        !!messageDetails &&
        typeof messageDetails === "object" &&
        (messageDetails as Record<string, unknown>).decisionId === decisionId
      );
    });
  }

  function launchCommandDrive(ctx: ExtensionCommandContext, taskIds: string[] | undefined): void {
    const operation = startBackgroundDrive(ctx, taskIds, undefined, (message) =>
      notify(ctx, message)
    );
    void operation.promise.then(() => {
      if (!runtimeActive) return;
      refreshUI(ctx);
      if (operation.summary) {
        notify(
          ctx,
          formatDriveSummary(operation.summary),
          operation.summary.stoppedBecause.code === "completed" ? "info" : "warning"
        );
        return;
      }
      if (operation.error) notify(ctx, operation.error, "error");
    });
  }

  async function requestHumanRetry(ctx: ExtensionContext, requestedTaskId: string): Promise<void> {
    if (driveController.hasActive() || liveRuns.size > 0) {
      notify(
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
      isLive: (id) => liveRuns.has(id),
      ...(ownerSession ? { ownerSession } : {}),
    });
    if (!eligibility.eligible || !task) {
      notify(ctx, `Retry not started: ${eligibility.message}`, "warning");
      return;
    }

    const riskEvidence = humanRetryRiskToken(task);
    if (eligibility.requiresConfirmation) {
      if (!ctx.hasUI) {
        notify(ctx, `Retry not started: ${eligibility.message}`, "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Retry accepted or integrated work?",
        `${task.id} will run in a fresh isolated worktree. Existing attempts and recovery evidence will be preserved.`
      );
      if (!confirmed) {
        notify(ctx, "Retry cancelled; accepted work was not changed.", "warning");
        return;
      }
      const currentBoard = loadBoard(ctx.cwd);
      const currentTask = findTask(currentBoard, task.id);
      const currentEligibility = humanRetryEligibility(currentBoard, task.id, {
        maxAttempts: loadConfig(ctx.cwd).maxAttempts,
        config: loadConfig(ctx.cwd),
        isLive: (id) => liveRuns.has(id),
        ...(ownerSession ? { ownerSession } : {}),
      });
      if (
        !currentTask ||
        !currentEligibility.eligible ||
        humanRetryRiskToken(currentTask) !== riskEvidence
      ) {
        notify(
          ctx,
          "Retry not started: task acceptance or integration evidence changed during confirmation.",
          "warning"
        );
        return;
      }
    }
    if (!(await confirmDriveScale(ctx, [task.id]))) {
      notify(ctx, "Retry not started: workflow scale was not confirmed.", "warning");
      return;
    }
    const confirmedTask = findTask(loadBoard(ctx.cwd), task.id);
    if (!confirmedTask || humanRetryRiskToken(confirmedTask) !== riskEvidence) {
      notify(
        ctx,
        "Retry not started: task acceptance or integration evidence changed; confirm it again.",
        "warning"
      );
      return;
    }

    notify(ctx, `Retrying ${task.id} in isolated recovery mode…`);
    const operation = startBackgroundDrive(
      ctx,
      [task.id],
      undefined,
      (message) => notify(ctx, message),
      task.id,
      riskEvidence
    );
    void operation.promise.then(() => {
      if (!runtimeActive) return;
      if (operation.summary) {
        notify(
          ctx,
          formatDriveSummary(operation.summary),
          operation.summary.stoppedBecause.code === "completed" ? "info" : "warning"
        );
      } else if (operation.error) {
        notify(ctx, operation.error, "error");
      }
    });
  }

  registerMaestroTools({
    pi,
    adoptBoard,
    refreshUI,
    liveRuns,
    driveController,
    startBackgroundDrive,
  });

  registerMaestroCommand(
    pi,
    async (args, ctx) => {
      commandCompletions.setCwd(ctx.cwd);
      let { subcommand, rest, restParts } = parseCommand(args);
      if (!subcommand && ctx.mode === "tui") {
        const selected = await showMaestroHome(ctx);
        if (!selected) return;
        ({ subcommand, rest, restParts } = parseCommand(selected));
      }

      try {
        switch (subcommand) {
          case "start": {
            if (!rest) {
              notify(ctx, "Usage: /maestro start <goal>", "warning");
              return;
            }
            if (liveRuns.size > 0) {
              notify(
                ctx,
                "Executors are still running. Abort them before starting a new goal.",
                "warning"
              );
              return;
            }
            const config = loadConfig(ctx.cwd);
            const git = inspectGit(ctx.cwd);
            if (!git.ok && (config.autoCommit || config.useWorktrees)) {
              notify(
                ctx,
                `Git repo not ready: ${git.summary}. Commits will fail — run /maestro doctor, or disable autoCommit/useWorktrees in /maestro config.`,
                "warning"
              );
            }
            let board = loadBoard(ctx.cwd);
            // A new goal is a new run: archive the previous board instead of
            // piling tasks from different goals onto one endless list.
            if (board.tasks.length > 0) {
              const previousRevision = board.revision ?? 0;
              const archivedLogs = captureBoardLogs(ctx.cwd, board);
              for (const warning of archivedLogs.warnings) {
                notify(ctx, `Log cleanup warning: ${warning}`, "warning");
              }
              board = { version: 1, nextTaskNumber: 1, tasks: [], goal: rest };
              let archivePath: string | undefined;
              try {
                archivePath = replaceBoardWithArchive(
                  ctx.cwd,
                  () => structuredClone(board),
                  previousRevision
                );
              } catch (error) {
                notify(
                  ctx,
                  `${error instanceof Error ? error.message : String(error)}. Inspect the current board and start again.`,
                  "warning"
                );
                return;
              }
              if (archivePath) {
                const cleanup = pruneStaleLogs(
                  ctx.cwd,
                  archivedLogs.entries,
                  () => loadBoard(ctx.cwd),
                  (id) => liveRuns.has(id),
                  archivedLogs.warnings
                );
                if (cleanup.warnings.length > 0) {
                  notify(
                    ctx,
                    `Log cleanup warning: ${cleanup.warnings.join("; ").slice(0, 500)}`,
                    "warning"
                  );
                }
                notify(ctx, `Previous board archived: ${archivePath}`);
              }
            } else {
              board.goal = rest;
              try {
                replaceBoard(ctx.cwd, board, board.revision ?? 0);
              } catch (error) {
                notify(
                  ctx,
                  `${error instanceof Error ? error.message : String(error)}. Inspect the current board and start again.`,
                  "warning"
                );
                return;
              }
            }
            adoptBoard(ctx);
            refreshUI(ctx);
            nameSessionAfterGoal(ctx, rest, "maestro");
            pi.sendMessage(
              {
                customType: MESSAGE_TYPE,
                content: buildOrchestratorBriefing(
                  rest,
                  describeTiersForPlanning(loadConfig(ctx.cwd)),
                  loadConfig(ctx.cwd).planGate
                ),
                display: true,
              },
              { triggerTurn: true }
            );
            return;
          }
          case "back": {
            await sessionNavigator.back(ctx);
            return;
          }
          case "drive": {
            if (driveController.hasActive() || liveRuns.size > 0) {
              notify(ctx, "An autonomous drive or executor batch is already running.", "warning");
              return;
            }
            const requestedTaskIds = rest ? rest.split(/[\s,]+/).filter(Boolean) : undefined;
            let taskIds: string[] | undefined;
            try {
              taskIds = canonicalTaskIds(loadBoard(ctx.cwd), requestedTaskIds);
              if (loadBoard(ctx.cwd).planPending) throw new Error("Plan approval is pending.");
              if (!(await confirmDriveScale(ctx, taskIds))) {
                notify(ctx, "Drive not started: workflow scale was not confirmed.", "warning");
                return;
              }
              validateDriveStart(ctx, taskIds);
            } catch (error) {
              notify(ctx, `Drive not started: ${String(error)}`, "warning");
              return;
            }
            notify(ctx, `Driving ${taskIds?.join(", ") ?? "the whole board"}…`);
            launchCommandDrive(ctx, taskIds);
            return;
          }
          case "retry": {
            if (!rest || restParts.length !== 1) {
              notify(ctx, `Usage: /${COMMAND} retry <taskId>`, "warning");
              return;
            }
            await requestHumanRetry(ctx, rest);
            return;
          }
          case "pause": {
            const currentSession = ctx.sessionManager.getSessionFile();
            if (!driveController.hasActive()) {
              const paused = loadBoard(ctx.cwd).pausedDrive;
              notify(
                ctx,
                paused ? "Autonomous drive is already paused." : "No autonomous drive is active.",
                "warning"
              );
              return;
            }
            const activeOwner = driveController.activeOwner();
            if (
              activeOwner?.cwd !== ctx.cwd ||
              !sessionCanControlDrive(activeOwner.ownerSession, currentSession)
            ) {
              notify(ctx, "Only the session that started this drive may pause it.", "warning");
              return;
            }
            driveController.requestPause();
            notify(ctx, "Pause requested. Active executors will finish; no new batch will start.");
            return;
          }
          case "resume": {
            const board = loadBoard(ctx.cwd);
            const paused = board.pausedDrive;
            if (!paused) {
              notify(ctx, "No paused autonomous drive to resume.", "warning");
              return;
            }
            if (driveController.hasActive() || liveRuns.size > 0) {
              notify(ctx, "Executors are already running.", "warning");
              return;
            }
            if (!sessionCanControlDrive(paused.ownerSession, ctx.sessionManager.getSessionFile())) {
              notify(ctx, "Only the session that paused this drive may resume it.", "warning");
              return;
            }
            let taskIds: string[] | undefined;
            try {
              taskIds = canonicalTaskIds(board, paused.taskIds);
              if (board.planPending) throw new Error("Plan approval is pending.");
              if (!(await confirmDriveScale(ctx, taskIds))) {
                notify(ctx, "Drive not resumed: workflow scale was not confirmed.", "warning");
                return;
              }
              validateDriveStart(ctx, taskIds);
            } catch (error) {
              notify(ctx, `Drive not resumed: ${String(error)}`, "warning");
              return;
            }
            notify(ctx, `Resuming ${taskIds?.join(", ") ?? "the whole board"}…`);
            launchCommandDrive(ctx, taskIds);
            return;
          }
          case "abort": {
            const currentSession = ctx.sessionManager.getSessionFile();
            if (driveController.hasActive()) {
              const activeOwner = driveController.activeOwner();
              if (
                activeOwner?.cwd !== ctx.cwd ||
                !sessionCanControlDrive(activeOwner.ownerSession, currentSession)
              ) {
                notify(ctx, "Only the session that started this drive may abort it.", "warning");
                return;
              }
              driveController.abort();
              notify(ctx, "Abort requested for the drive and its active executors.", "warning");
              return;
            }
            const paused = loadBoard(ctx.cwd).pausedDrive;
            if (!paused) {
              notify(ctx, "No active or paused autonomous drive to abort.", "warning");
              return;
            }
            if (!sessionCanControlDrive(paused.ownerSession, currentSession)) {
              notify(ctx, "Only the session that paused this drive may abort it.", "warning");
              return;
            }
            savePausedDrive(ctx.cwd, undefined);
            notify(ctx, "Paused autonomous drive aborted. No executors were running.", "warning");
            return;
          }
          case "plan": {
            const [planAction, planPath, planTaskId] = restParts;
            if (planAction === "export") {
              if (!planPath) {
                notify(ctx, `Usage: /${COMMAND} plan export <file>`, "warning");
                return;
              }
              const file = resolve(ctx.cwd, planPath);
              if (existsSync(file)) {
                notify(ctx, `Refusing to overwrite existing file: ${file}`, "error");
                return;
              }
              writeFileSync(file, exportPlan(loadBoard(ctx.cwd)), { flag: "wx" });
              notify(ctx, `Plan exported to ${file}`);
              return;
            }
            if (planAction === "import") {
              if (!planPath) {
                notify(ctx, `Usage: /${COMMAND} plan import <file>`, "warning");
                return;
              }
              if (liveRuns.size > 0) {
                notify(ctx, "Executors are still running. Import cancelled.", "warning");
                return;
              }
              const config = loadConfig(ctx.cwd);
              let imported: Board;
              try {
                imported = importPlan(
                  readFileSync(resolve(ctx.cwd, planPath), "utf-8"),
                  Object.keys(config.tiers),
                  Object.keys(config.verificationProfiles ?? {}),
                  config.maxPlanTasks
                );
              } catch (error) {
                notify(ctx, error instanceof Error ? error.message : String(error), "error");
                return;
              }
              const current = loadBoard(ctx.cwd);
              if (current.tasks.length > 0) {
                const confirmed =
                  ctx.hasUI &&
                  (await ctx.ui.confirm(
                    "Replace current plan?",
                    `Archive ${current.tasks.length} current task(s), then import ${imported.tasks.length}?`
                  ));
                if (!confirmed) {
                  notify(ctx, "Plan import cancelled; current board was not changed.", "warning");
                  return;
                }
              }
              try {
                if (current.tasks.length > 0) {
                  replaceBoardWithArchive(
                    ctx.cwd,
                    () => structuredClone(imported),
                    current.revision ?? 0
                  );
                } else {
                  replaceBoard(ctx.cwd, imported, current.revision ?? 0);
                }
              } catch (error) {
                notify(
                  ctx,
                  `${error instanceof Error ? error.message : String(error)}. Inspect and confirm the import again.`,
                  "warning"
                );
                return;
              }
              refreshUI(ctx);
              notify(ctx, `Imported ${imported.tasks.length} task(s); plan approval is required.`);
              return;
            }
            if (planAction === "diff") {
              if (!planPath) {
                notify(ctx, `Usage: /${COMMAND} plan diff <file> [taskId]`, "warning");
                return;
              }
              const config = loadConfig(ctx.cwd);
              try {
                const candidate = importPlan(
                  readFileSync(resolve(ctx.cwd, planPath), "utf-8"),
                  Object.keys(config.tiers),
                  Object.keys(config.verificationProfiles ?? {}),
                  config.maxPlanTasks
                );
                const comparison = comparePlans(loadBoard(ctx.cwd), candidate, config);
                notify(
                  ctx,
                  formatPlanComparison(comparison, `/${COMMAND} plan diff ${planPath}`, planTaskId)
                );
              } catch (error) {
                notify(ctx, error instanceof Error ? error.message : String(error), "error");
              }
              return;
            }
            await showPlan(ctx);
            return;
          }
          case "recipe":
            await handleRecipeCommand(ctx, rest, {
              hasLiveRuns: () => liveRuns.size > 0,
              isTaskLive: (taskId) => liveRuns.has(taskId),
              onBoardChanged: () => refreshUI(ctx),
            });
            return;
          case "agents":
            openLivePane(ctx, true);
            return;
          case "workflows":
            await showWorkflowBrowser(ctx, {
              hasLiveRuns: () => liveRuns.size > 0,
              onBoardChanged: () => refreshUI(ctx),
              reviewPlan: showPlan,
            });
            return;
          case "board":
          case "dash":
          case "dashboard":
            await showDashboard(ctx);
            return;
          case "open": {
            if (!rest) {
              notify(ctx, "Usage: /maestro open <taskId>", "warning");
              return;
            }
            await sessionNavigator.openTask(ctx, rest);
            return;
          }
          case "config": {
            if (ctx.mode !== "tui" || rest === "show") {
              notify(ctx, describeConfig(loadConfig(ctx.cwd)));
              return;
            }
            const scope = rest === "project" ? "project" : "user";
            await showSettings(ctx, scope);
            refreshUI(ctx);
            return;
          }
          case "simulate": {
            const taskIds = rest ? rest.split(/[\s,]+/).filter(Boolean) : undefined;
            const board = loadBoard(ctx.cwd);
            assertKnownTaskIds(board, taskIds);
            const validationError = planValidationMessage(
              validatePlan(board, Object.keys(loadConfig(ctx.cwd).tiers))
            );
            notify(ctx, validationError ?? simulatePlan(board, loadConfig(ctx.cwd), taskIds));
            return;
          }
          case "discover":
            await handleDiscoveryCommand(ctx, restParts, {
              hasLiveRuns: () => liveRuns.size > 0,
              isTaskLive: (taskId) => liveRuns.has(taskId),
              onBoardChanged: () => refreshUI(ctx),
            });
            return;
          case "costs": {
            const board = loadBoard(ctx.cwd);
            notify(
              ctx,
              board.tasks.length === 0
                ? "No recorded costs; the board is empty."
                : formatCostSummary(board.tasks)
            );
            return;
          }
          case "reconcile": {
            const warnings: string[] = [];
            const board = loadBoard(ctx.cwd);
            const config = loadConfig(ctx.cwd);
            const decision = board.activeDecision;
            if (decision && !decision.resolution) {
              const matching = decision.taskIds.some((id) => {
                const task = board.tasks.find((candidate) => candidate.id === id);
                return decision.kind === "reviewer_failure"
                  ? task?.status === "failed" || task?.status === "changes_requested"
                  : task?.dispatchClaim !== undefined;
              });
              if (!matching) {
                warnings.push(
                  `${decision.id}: unresolved ${decision.kind} decision has no matching task or live dispatch state`
                );
              }
            }
            for (const task of board.tasks) {
              if (task.status === "approved") {
                const freshness = completionFreshness(board, task, config);
                if (freshness.state !== "fresh") {
                  warnings.push(`${task.id}: ${freshness.state} completion — ${freshness.reason}`);
                }
              }
              if (task.approvalKind === "manual") warnings.push(`${task.id}: manually accepted`);
              if (task.status === "approved" && task.approvalKind !== "reviewed") {
                warnings.push(`${task.id}: approved without a reviewed artifact`);
              }
              if (task.approvalKind === "reviewed" && !task.provenance?.candidateTree) {
                warnings.push(
                  `${task.id}: reviewed approval is missing its authoritative Git tree`
                );
              }
              if (task.approvalKind === "reviewed" && !task.provenance?.reviewedAt) {
                warnings.push(`${task.id}: artifact has no persisted review proof`);
              }
              if (task.approvalKind === "reviewed" && !task.integratedCommit) {
                warnings.push(`${task.id}: reviewed approval is missing its integration commit`);
              }
              if (
                task.verificationProfile &&
                task.approvalKind === "reviewed" &&
                !task.provenance?.verifiedAt
              ) {
                warnings.push(
                  `${task.id}: reviewed artifact is missing trusted verification proof`
                );
              }
              const attempt = task.attempts.at(-1);
              if (
                attempt?.worktreePath &&
                !worktreeExists({
                  worktreePath: attempt.worktreePath,
                  branch: attempt.branch ?? "",
                })
              ) {
                warnings.push(`${task.id}: recorded recovery worktree is missing`);
              }
            }
            notify(
              ctx,
              warnings.length > 0
                ? `Reconciliation warnings:\n- ${warnings.join("\n- ")}`
                : "Board artifacts are consistent."
            );
            return;
          }
          case "doctor": {
            const liveTaskIds = new Set(liveRuns.keys());
            if (restParts[0]?.toLowerCase() !== "cleanup") {
              notify(ctx, buildDoctorReport(ctx.cwd, ctx.modelRegistry, ctx.model, liveTaskIds));
              return;
            }

            const board = loadBoard(ctx.cwd);
            const candidates = inspectManagedWorktrees(ctx.cwd, board, liveTaskIds).filter(
              (entry) => entry.state === "orphaned" || entry.state === "stale"
            );
            const logCandidates = inspectLogRetention(ctx.cwd, board, liveTaskIds).filter(
              (entry) => entry.state === "stale"
            );
            if (candidates.length === 0 && logCandidates.length === 0) {
              notify(ctx, "No stale logs or stale/orphaned managed worktrees to clean.");
              return;
            }

            let confirmed = restParts[1]?.toLowerCase() === "confirm";
            if (ctx.hasUI && !confirmed) {
              const logBytes = logCandidates.reduce((total, entry) => total + entry.size, 0);
              confirmed = await ctx.ui.confirm(
                "Clean stale maestro state?",
                `Remove ${candidates.length} stale/orphaned checkout(s) and ${logCandidates.length} stale log(s) (${Math.ceil(logBytes / 1024)} KB)? Candidates will be rechecked; active and retained state is preserved.`
              );
            }
            if (!ctx.hasUI && !confirmed) {
              notify(
                ctx,
                `Cleanup cancelled. Run /${COMMAND} doctor cleanup confirm to explicitly confirm in non-interactive mode.`,
                "warning"
              );
              return;
            }
            if (!confirmed) {
              notify(ctx, "Worktree cleanup cancelled.");
              return;
            }

            const confirmedPaths = new Set(candidates.map((entry) => entry.ref.worktreePath));
            const result = cleanupManagedWorktrees(
              ctx.cwd,
              confirmedPaths,
              () => loadBoard(ctx.cwd),
              (taskId) => liveRuns.has(taskId)
            );
            const logResult = cleanupStaleLogs(
              ctx.cwd,
              new Set(logCandidates.map((entry) => resolve(entry.file))),
              () => loadBoard(ctx.cwd),
              (taskId) => liveRuns.has(taskId)
            );
            const preserved = result.preserved.filter(
              (entry) =>
                entry.state === "active" ||
                entry.state === "recoverable" ||
                entry.state === "retained-conflict"
            ).length;
            const warnings = logResult.warnings.length
              ? ` Warnings: ${logResult.warnings.join("; ").slice(0, 500)}`
              : "";
            notify(
              ctx,
              `Removed ${result.removed.length} stale/orphaned worktree(s) and ${logResult.removed.length} stale log(s). Preserved ${preserved + logResult.preserved.length} active or retained item(s).${warnings}`
            );
            return;
          }
          case "handoff": {
            const board = loadBoard(ctx.cwd);
            if (board.tasks.length === 0) {
              notify(ctx, "Nothing to hand off — the board is empty.", "warning");
              return;
            }
            if (liveRuns.size > 0) {
              notify(
                ctx,
                `${liveRuns.size} executor(s) still running — switching sessions would abort them. Wait or abort them first.`,
                "warning"
              );
              return;
            }
            if (ctx.hasUI) {
              const ok = await ctx.ui.confirm(
                "Hand off to a fresh orchestrator?",
                "Starts a new session where a supervisor drives run/review from the board alone, without this session's planning context. The current session stays on disk (/resume to revisit)."
              );
              if (!ok) return;
            }
            await runHandoff({
              ctx,
              briefing: buildSupervisorBriefing(
                board.goal,
                board.tasks,
                describeTiersForPlanning(loadConfig(ctx.cwd))
              ),
              goal: board.goal ?? "maestro run",
              adoptBoard,
            });
            return;
          }
          case "history": {
            const history = loadStatusHistory(ctx.cwd);
            if (!history) {
              notify(ctx, "No history yet.");
              return;
            }
            const requestedCount = Number.parseInt(rest, 10);
            const count =
              Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : 20;
            notify(ctx, formatStatusHistory(history.entries, history.skipped, count));
            return;
          }
          case "timeline": {
            const [first, archiveName, archivedTaskId] = restParts;
            const archived = first?.toLowerCase() === "archive";
            let board: Board;
            let taskId: string | undefined;
            try {
              board = archived ? loadArchivedBoard(ctx.cwd, archiveName ?? "") : loadBoard(ctx.cwd);
              taskId = archived ? archivedTaskId : first;
            } catch (error) {
              notify(ctx, error instanceof Error ? error.message : String(error), "error");
              return;
            }
            if (taskId && !findTask(board, taskId)) {
              notify(ctx, `Unknown task: ${taskId}`, "warning");
              return;
            }
            notify(ctx, formatRunTimeline(deriveRunTimeline(board, taskId)));
            return;
          }
          case "replay": {
            if (liveRuns.size > 0) {
              notify(
                ctx,
                "Executors are still running. Abort them before replaying a board.",
                "warning"
              );
              return;
            }

            const replayBoard = loadBoard(ctx.cwd);
            const replayRevision = replayBoard.revision ?? 0;
            let selectedFile = rest;
            if (!selectedFile) {
              const archives = listArchivedBoards(ctx.cwd);
              if (archives.length === 0) {
                notify(ctx, "No archived boards found.");
                return;
              }
              const choice = await pickFromList(
                ctx,
                "Maestro Archives · newest first",
                archives.map((archive) => ({
                  value: archive.file,
                  label: `${archive.timestamp} · ${archive.taskCount} task(s)`,
                  description: archive.file,
                }))
              );
              if (!choice) return;
              selectedFile = choice;
            }

            // Selection is asynchronous, so an executor may have started while
            // the archive picker was open. Check again immediately before restore.
            if (liveRuns.size > 0) {
              notify(
                ctx,
                "Executors are still running. Abort them before replaying a board.",
                "warning"
              );
              return;
            }

            try {
              const archivedLogs = captureBoardLogs(ctx.cwd, replayBoard);
              for (const warning of archivedLogs.warnings) {
                notify(ctx, `Log cleanup warning: ${warning}`, "warning");
              }
              const restored = restoreArchivedBoard(ctx.cwd, selectedFile, replayRevision);
              if (restored.archivedCurrent) {
                const cleanup = pruneStaleLogs(
                  ctx.cwd,
                  archivedLogs.entries,
                  () => loadBoard(ctx.cwd),
                  (id) => liveRuns.has(id),
                  archivedLogs.warnings
                );
                if (cleanup.warnings.length > 0) {
                  notify(
                    ctx,
                    `Log cleanup warning: ${cleanup.warnings.join("; ").slice(0, 500)}`,
                    "warning"
                  );
                }
              }
              refreshUI(ctx);
              const previous = restored.archivedCurrent
                ? ` Current board archived at ${restored.archivedCurrent}.`
                : "";
              notify(ctx, `Board restored from ${restored.selectedFile}.${previous}`);
            } catch (error) {
              notify(ctx, error instanceof Error ? error.message : String(error), "error");
            }
            return;
          }
          case "reset": {
            const reportReset = (message: string, level: "info" | "warning" | "error" = "info") => {
              if (ctx.hasUI) {
                notify(ctx, message, level);
                return;
              }
              ctx.ui.notify(message, level);
              console.error(message);
            };
            const board = loadBoard(ctx.cwd);
            if (board.tasks.length === 0) {
              reportReset("Board is already empty.");
              return;
            }
            if (liveRuns.size > 0) {
              reportReset("Executors are still running. Abort them before resetting.", "warning");
              return;
            }
            if (!ctx.hasUI && rest.trim().toLowerCase() !== "confirm") {
              reportReset(
                `Reset refused without explicit confirmation. Run /${COMMAND} reset confirm to archive and clear the board.`,
                "warning"
              );
              return;
            }
            if (ctx.hasUI) {
              const ok = await ctx.ui.confirm(
                "Reset board?",
                `Archive and delete all ${board.tasks.length} task(s) from the board?`
              );
              if (!ok) return;
              if (liveRuns.size > 0) {
                reportReset(
                  "Executors started during confirmation. Abort them before resetting.",
                  "warning"
                );
                return;
              }
            }
            const archivedLogs = captureBoardLogs(ctx.cwd, board);
            for (const warning of archivedLogs.warnings) {
              reportReset(`Log cleanup warning: ${warning}`, "warning");
            }
            let archivePath: string | undefined;
            try {
              archivePath = replaceBoardWithArchive(
                ctx.cwd,
                () => ({ version: 1, nextTaskNumber: 1, tasks: [] }),
                board.revision ?? 0
              ); // also drops goal
            } catch (error) {
              reportReset(
                `${error instanceof Error ? error.message : String(error)}. Inspect the current board and confirm reset again.`,
                "warning"
              );
              return;
            }
            if (!archivePath) {
              reportReset("Could not archive the board; reset cancelled.", "error");
              return;
            }
            const cleanup = pruneStaleLogs(
              ctx.cwd,
              archivedLogs.entries,
              () => loadBoard(ctx.cwd),
              (id) => liveRuns.has(id),
              archivedLogs.warnings
            );
            if (cleanup.warnings.length > 0) {
              notify(
                ctx,
                `Log cleanup warning: ${cleanup.warnings.join("; ").slice(0, 500)}`,
                "warning"
              );
            }
            refreshUI(ctx);
            reportReset(`Board reset. Archived at ${archivePath}`);
            return;
          }
          default:
            notify(
              ctx,
              [
                ...(subcommand ? [`Unknown subcommand "${subcommand}". Available commands:`] : []),
                "start/plan/drive",
                `/${COMMAND} start <goal>   plan + delegate a goal with the orchestrator`,
                `/${COMMAND} handoff        continue run/review in a fresh session (drops planning context)`,
                `/${COMMAND} drive [ids]    autonomously run, review, and retry tasks`,
                `/${COMMAND} retry <taskId> retry failed work with isolated human-controlled safety`,
                `/${COMMAND} pause          stop the drive after active executors finish`,
                `/${COMMAND} resume         continue a paused drive from fresh board state`,
                `/${COMMAND} abort          abort a drive and its active executors`,
                `/${COMMAND} plan           review, approve, or reject a gated plan`,
                "",
                "observe",
                `/${COMMAND} board          phase-first project dashboard (tasks, launches, evidence, actions)`,
                `/${COMMAND} agents         browse live and completed executor/reviewer sessions`,
                `/${COMMAND} open <taskId>  switch into an executor session`,
                `/${COMMAND} back           switch back to the previous session`,
                "",
                "scripting",
                `/${COMMAND} config         interactive settings editor (add "project" for repo scope, "show" to print)`,
                `/${COMMAND} costs          show attempts, total/average cost, models, and providers`,
                `/${COMMAND} simulate [ids] preview deterministic dependency waves without running work`,
                `/${COMMAND} plan export <file>  export a versioned plan without run evidence`,
                `/${COMMAND} plan import <file>  validate, archive current work, and import`,
                `/${COMMAND} plan diff <file> [taskId]  inspect plan changes without mutation`,
                `/${COMMAND} recipe list|inspect|preview|save|run|remove  manage declarative recipes`,
                `/${COMMAND} workflows      interactively browse and operate reusable workflows`,
                "",
                "recover",
                `/${COMMAND} discover <taskId> [append|replace]  preview and approve generated tasks`,
                `/${COMMAND} doctor         diagnose config, models, authentication, git, and managed worktrees`,
                `/${COMMAND} doctor cleanup remove rechecked stale/orphaned worktrees after confirmation`,
                `/${COMMAND} history [n]    show recent task status changes (default 20)`,
                `/${COMMAND} timeline [id]  show derived run/task evidence chronologically`,
                `/${COMMAND} timeline archive <file> [id]  show archived evidence`,
                `/${COMMAND} reconcile      report artifact/provenance inconsistencies without mutation`,
                `/${COMMAND} replay [file]  restore an archived board (picker when omitted)`,
                `/${COMMAND} reset [confirm] archive and clear the board`,
              ].join("\n")
            );
        }
      } finally {
        notifyQuarantine(ctx);
      }
    },
    (prefix) => commandCompletions.complete(prefix)
  );

  pi.registerShortcut("ctrl+alt+b", {
    description: "Open the maestro dashboard",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await showDashboard(ctx);
    },
  });

  pi.registerShortcut("ctrl+alt+w", {
    description: "Open or close Maestro agent sessions",
    handler: (ctx) => cycleLivePane(ctx),
  });

  /**
   * Works from both the command handler and the shortcut. Shortcut handlers
   * only get ExtensionContext, so session actions are hidden when the host
   * cannot switch sessions.
   */
  async function showDashboard(ctx: ExtensionContext): Promise<void> {
    const canSwitchSessions = () =>
      isCommandContext(ctx) && !sessionSwitchBlocked(driveController.hasActive(), liveRuns.size);
    if (ctx.mode !== "tui") {
      if (isCommandContext(ctx)) await showBoard(ctx);
      return;
    }
    const selection = await ctx.ui.custom<{ taskId: string; action: DashboardTaskAction } | null>(
      (tui, theme, _keybindings, done) => {
        const dashboard = new Dashboard(
          theme,
          {
            getBoard: () => loadBoard(ctx.cwd),
            getConfig: () => loadConfig(ctx.cwd),
            isLive: (taskId) => liveRuns.has(taskId),
            liveKind: (taskId) => liveRuns.get(taskId)?.kind,
            getLiveRun: (taskId) => {
              const live = liveRuns.get(taskId);
              if (!live) return undefined;
              return {
                cost: live.cost,
                turns: live.turns,
                lastActivity: live.lastActivity,
              };
            },
            liveActivity: (taskId) => {
              const live = liveRuns.get(taskId);
              if (!live) return undefined;
              const label = live.kind === "review" ? "reviewing" : "running";
              return `${label} · ${live.turns} turns · ${live.lastActivity}`;
            },
            steer: (taskId, message) => {
              liveRuns.get(taskId)?.handle.steer(message);
            },
            followUp: (taskId, message) => {
              liveRuns.get(taskId)?.handle.followUp(message);
            },
            abort: (taskId) => {
              liveRuns.get(taskId)?.handle.abort();
            },
            setTaskStatus: (taskId, status) => {
              try {
                if (status === "approved") manuallyApproveTask(ctx, taskId);
                else {
                  updateTask(ctx.cwd, taskId, (fresh) => {
                    assertTaskNotDispatched(fresh);
                    forceStatus(fresh, status);
                  });
                }
              } catch (error) {
                notify(ctx, error instanceof Error ? error.message : String(error), "warning");
                return;
              }
              if (status === "approved") {
                const cleanup = pruneTaskLogs(
                  ctx.cwd,
                  taskId,
                  () => loadBoard(ctx.cwd),
                  (id) => liveRuns.has(id)
                );
                for (const warning of cleanup.warnings) {
                  notify(ctx, `Log cleanup warning: ${warning}`, "warning");
                }
              }
              refreshUI(ctx);
            },
            hasExecutorSession: (taskId) => {
              const task = findTask(loadBoard(ctx.cwd), taskId);
              const attempt = task?.attempts.at(-1);
              return canSwitchSessions() && attempt
                ? findSessionFile(attempt) !== undefined
                : false;
            },
            hasReviewerSession: (taskId) => {
              const task = findTask(loadBoard(ctx.cwd), taskId);
              return canSwitchSessions() && task?.attempts.at(-1)?.reviewSessionFile !== undefined;
            },
            retryEligibility: (taskId) =>
              humanRetryEligibility(loadBoard(ctx.cwd), taskId, {
                maxAttempts: loadConfig(ctx.cwd).maxAttempts,
                config: loadConfig(ctx.cwd),
                isLive: (id) => liveRuns.has(id),
                ...(ctx.sessionManager.getSessionFile()
                  ? { ownerSession: ctx.sessionManager.getSessionFile() }
                  : {}),
              }),
            selectTaskAction: (taskId, action) => done({ taskId, action }),
            close: () => done(null),
            requestRender: () => tui.requestRender(),
            getLatestArchive: () => {
              const archive = latestArchiveFile(ctx.cwd);
              if (!archive) return undefined;
              return { name: basename(archive.file), at: Date.parse(archive.timestamp) };
            },
            getStatusHistory: () => loadStatusHistory(ctx.cwd) ?? undefined,
          },
          {
            getRows: () => tui.terminal.rows,
            initialView: "phase",
          }
        );
        return {
          get focused() {
            return dashboard.focused;
          },
          set focused(value: boolean) {
            dashboard.focused = value;
          },
          render: (width: number) => dashboard.render(width),
          invalidate: () => dashboard.invalidate(),
          handleInput: (data: string) => dashboard.handleInput(data),
          dispose: () => dashboard.dispose(),
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "100%",
          maxHeight: "100%",
        },
      }
    );

    if (!selection) return;
    if (selection.action === "retry") {
      await requestHumanRetry(ctx, selection.taskId);
      return;
    }
    if (selection.action === "view_report") {
      showTaskReport(ctx.cwd, selection.taskId);
      return;
    }
    if (selection.action === "view_review") {
      showTaskReview(ctx.cwd, selection.taskId);
      return;
    }
    if (!isCommandContext(ctx)) {
      notify(ctx, `Run /${COMMAND} open ${selection.taskId} to switch sessions.`);
      return;
    }
    if (selection.action === "open_executor") {
      await sessionNavigator.openTask(ctx, selection.taskId);
      return;
    }
    await sessionNavigator.openReviewer(ctx, selection.taskId);
  }

  function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
    return "switchSession" in ctx;
  }

  async function showPlan(ctx: ExtensionCommandContext): Promise<void> {
    await showPlanReview(ctx, {
      hasLiveRuns: () => liveRuns.size > 0,
      onChanged: () => refreshUI(ctx),
      onApproved: () => {
        refreshUI(ctx);
        labelCurrentEntry(ctx, "maestro: plan approved");
      },
    });
  }

  async function showBoard(ctx: ExtensionCommandContext): Promise<void> {
    await showTaskBrowser(ctx, {
      isLive: (taskId) => liveRuns.has(taskId),
      requestRetry: requestHumanRetry,
      manuallyApprove: manuallyApproveTask,
      showReport: showTaskReport,
      showReview: showTaskReview,
      openExecutor: (current, taskId) => sessionNavigator.openTask(current, taskId),
      openReviewer: (current, taskId) => sessionNavigator.openReviewer(current, taskId),
      onStatusChanged: (current, taskId, status) => {
        refreshUI(current);
        if (status === "approved") labelCurrentEntry(current, `maestro: ${taskId} approved`);
      },
    });
  }

  function showTaskReport(cwd: string, taskId: string): void {
    const task = findTask(loadBoard(cwd), taskId);
    if (!task) return;
    const report = lastReport(task) ?? "(no report yet)";
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: `## ${task.id} ${task.title} — last report\n\n${report}`,
      display: true,
    });
  }

  function showTaskReview(cwd: string, taskId: string): void {
    const task = findTask(loadBoard(cwd), taskId);
    if (!task) return;
    const review = task.attempts.at(-1)?.reviewReport ?? "(no review yet)";
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: `## ${task.id} ${task.title} — review verdict\n\n${review}`,
      display: true,
    });
  }

  async function showMaestroHome(ctx: ExtensionCommandContext): Promise<string | null> {
    const board = loadBoard(ctx.cwd);
    const status = projectStatus(board, liveRuns.keys(), loadConfig(ctx.cwd));
    const items: SelectItem[] = [];
    if (board.planPending) {
      items.push({
        value: "plan",
        label: "Review pending plan",
        description: `${board.tasks.length} task(s) must be approved before execution`,
      });
    }
    items.push(
      {
        value: "board",
        label: "Open project dashboard",
        description: `${status.phase} · ${formatBoardProgress(board.tasks)} · starts at the current phase`,
      },
      {
        value: "agents",
        label: "Browse agent sessions",
        description: `${livePaneLaunches(ctx).length} recorded · ${liveRuns.size} live`,
      },
      {
        value: "workflows",
        label: "Manage workflows",
        description: "Browse, inspect, preview, run, save, or remove reusable workflows",
      },
      {
        value: "config project",
        label: "Configure this project",
        description: "Preset, models, review settings, safety limits, Git behavior, and live UI",
      },
      {
        value: "doctor",
        label: "Check setup and recovery",
        description: "Authentication, effective config, Git, worktrees, and actionable fixes",
      },
      {
        value: "start",
        label: "Start a new goal",
        description: "Ask the orchestrator to create a new reviewed plan",
      }
    );
    if (board.tasks.length > 0 && !board.planPending) {
      items.splice(1, 0, {
        value: board.pausedDrive ? "resume" : "drive",
        label: board.pausedDrive ? "Resume paused workflow" : "Run ready work",
        description: "Execute, review, verify, and integrate the current board",
      });
    }

    const choice = await pickFromList(ctx, "Maestro · project control center", items);
    if (choice !== "start") return choice;
    const goal = await ctx.ui.input("Start a new Maestro goal", "Describe the outcome you want");
    return goal?.trim() ? `start ${goal.trim()}` : null;
  }

  // ------------------------------------------------------------ rendering

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    if (!content) return new Text(theme.fg("accent", "⚡ maestro"), 0, 0);
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", "⚡ maestro"), 0, 0));
    container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
    return container;
  });

  pi.on("turn_end", (_event, ctx) => {
    if (contextNudgeShown) return;

    try {
      const usage = ctx.getContextUsage();
      const config = loadConfig(ctx.cwd);
      const threshold = (config.handoffContextRatio ?? CONTEXT_NUDGE_PERCENT / 100) * 100;
      if (!usage || usage.percent === null || threshold <= 0 || usage.percent < threshold) return;

      const board = loadBoard(ctx.cwd);
      if (board.tasks.length === 0 || !sessionOwnsBoard(ctx, board)) return;
      if (driveController.hasActive() || liveRuns.size > 0) {
        if (ctx.hasUI)
          ctx.ui.notify("Maestro handoff pending until live work reaches a safe boundary.");
        return;
      }

      contextNudgeShown = true;
      pi.sendUserMessage(`/${COMMAND} handoff`, { deliverAs: "followUp" });
    } catch {
      // The turn may belong to a context invalidated by a session switch.
    }
  });

  pi.on("session_before_switch", (_event, ctx) => {
    if (!sessionSwitchBlocked(driveController.hasActive(), liveRuns.size)) return;
    notify(
      ctx,
      `Session switch blocked while maestro work is active. Use /${COMMAND} pause and wait, or /${COMMAND} abort.`,
      "warning"
    );
    return { cancel: true };
  });

  pi.on("session_before_fork", (_event, ctx) => {
    if (!sessionSwitchBlocked(driveController.hasActive(), liveRuns.size)) return;
    notify(
      ctx,
      `Session fork blocked while maestro work is active. Use /${COMMAND} pause and wait, or /${COMMAND} abort.`,
      "warning"
    );
    return { cancel: true };
  });

  pi.on("session_start", (event, ctx) => {
    commandCompletions.setCwd(ctx.cwd);
    runtimeActive = true;
    closeLivePane();
    suppressedAutoPaneDriveId = undefined;
    liveRuns.clear();
    contextNudgeShown = false;
    // Session switches reload extensions, so switchWithReturn's in-memory
    // reference does not survive. Executor sessions may have a worktree cwd,
    // while their board and owner session remain linked from the main checkout.
    const boardCwd = maestroBoardCwd(ctx.cwd);
    const navigationBoard = loadBoard(boardCwd);
    const executorSessions = navigationBoard.tasks.flatMap((task) =>
      task.attempts.flatMap((attempt) =>
        [attempt.sessionFile, attempt.reviewSessionFile].filter(
          (sessionFile): sessionFile is string => sessionFile !== undefined
        )
      )
    );
    sessionNavigator.setPrevious(
      previousBoardSession(
        event.previousSessionFile,
        ctx.sessionManager.getSessionFile(),
        navigationBoard.ownerSessions,
        executorSessions
      )
    );

    // Recovery is lease-aware: live owners survive extension reloads and only
    // expired claims are reclaimed with their attempt in one board transaction.
    const recoveryNotes = sweepDispatchState(boardCwd);
    for (const note of recoveryNotes) notify(ctx, note, "warning");
    let recovered = loadBoard(boardCwd);
    const orphanedDrive = recovered.activeDrive;
    const currentSession = ctx.sessionManager.getSessionFile();
    if (
      orphanedDrive &&
      !driveController.hasActive() &&
      liveRuns.size === 0 &&
      sessionCanControlDrive(orphanedDrive.ownerSession, currentSession)
    ) {
      const summary = unexpectedDriveSummary(
        boardCwd,
        orphanedDrive.taskIds,
        "the owning extension runtime stopped before recording an outcome"
      );
      persistDriveDecision(
        boardCwd,
        orphanedDrive.ownerSession,
        summary,
        formatDrivePulse(summary),
        orphanedDrive.id
      );
      recovered = loadBoard(boardCwd);
    }
    const pendingDecision = recovered.activeDecision;
    if (
      pendingDecision &&
      !pendingDecision.deliveredAt &&
      sessionCanControlDrive(pendingDecision.ownerSession, currentSession) &&
      sessionContainsDecision(ctx, pendingDecision.id)
    ) {
      acknowledgeDeliveredDecision(boardCwd, pendingDecision.id);
      recovered = loadBoard(boardCwd);
    }
    deliverPendingDecision(boardCwd, ctx.sessionManager.getSessionFile(), sendDecision);
    const knownWorktrees = recovered.tasks.flatMap((task) =>
      task.attempts.flatMap((attempt) =>
        attempt.worktreePath && attempt.branch
          ? [{ worktreePath: attempt.worktreePath, branch: attempt.branch }]
          : []
      )
    );
    const retained = recovered.tasks
      .filter((task) => task.status === "ready_for_review" || task.status === "changes_requested")
      .flatMap((task) => {
        const attempt = task.attempts.at(-1);
        return attempt?.worktreePath && attempt.branch
          ? [{ worktreePath: attempt.worktreePath, branch: attempt.branch }]
          : [];
      });
    try {
      sweepWorktrees(boardCwd, retained, knownWorktrees);
    } catch (error) {
      notify(ctx, `Could not clean stale maestro worktrees: ${String(error)}`, "warning");
    }
    refreshUI(ctx);
  });

  // The before-switch/fork guards normally keep active work in this runtime.
  // Shutdown still aborts as a final safety net so a forced reload or exit can never orphan it.
  pi.on("session_shutdown", () => {
    runtimeActive = false;
    closeLivePane();
    const active = driveController.activeOwner();
    if (active) {
      try {
        const summary = unexpectedDriveSummary(
          active.cwd,
          active.taskIds,
          "the extension runtime shut down while the drive was active"
        );
        persistDriveDecision(
          active.cwd,
          active.ownerSession,
          summary,
          formatDrivePulse(summary),
          active.id
        );
      } catch {
        // The durable active-drive record remains for owner-scoped startup reconciliation.
      }
    }
    driveController.shutdown();
    for (const run of liveRuns.values()) {
      run.handle.abort();
    }
    liveRuns.clear();
  });
}
