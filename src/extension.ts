import { basename } from "node:path";
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
import {
  assertTaskNotDispatched,
  consumeQuarantineNotice,
  findTask,
  forceStatus,
  humanRetryEligibility,
  latestArchiveFile,
  loadBoard,
  loadStatusHistory,
  restoreQuarantineNotice,
  updateBoard,
  updateTask,
} from "./board.js";
import { MaestroCommandDispatcher } from "./command-dispatcher.js";
import { type RunCommandRuntime, type RunCommandSession } from "./command-run-control.js";
import { pickFromList } from "./command-ui.js";
import { registerMaestroCommand } from "./commands.js";
import { loadConfig } from "./config.js";
import { COMMAND, MESSAGE_TYPE } from "./constants.js";
import {
  Dashboard,
  type DashboardTaskAction,
  LivePaneComponent,
  type LivePaneLaunch,
} from "./dashboard.js";
import { type BackgroundDrive, DriveRuntimeController } from "./drive-controller.js";
import { ExtensionLifecycleState, registerMaestroLifecycle } from "./extension-lifecycle.js";
import { boardUsage, formatBoardProgress } from "./format.js";
import { notify } from "./handoff.js";
import { collectLivePaneLaunches } from "./live-pane-launches.js";
import { manuallyApproveTask } from "./manual-approval.js";
import { showPlanReview } from "./plan-review-controller.js";
import { pruneTaskLogs } from "./retention.js";
import { startExecutor as defaultStartExecutor, findSessionFile } from "./runner.js";
import { sessionSwitchBlocked } from "./session-control.js";
import { SessionNavigator } from "./session-navigator.js";
import { projectStatus } from "./status.js";
import { showTaskBrowser } from "./task-browser.js";

export {
  assertKnownTaskIds,
  maestroBoardCwd,
  previousBoardSession,
  sessionCanControlDrive,
  sessionSwitchBlocked,
} from "./session-control.js";

import { registerMaestroTools } from "./tools.js";
import { type Board } from "./types.js";
import { formatDriveSummary, lastReport } from "./workflow.js";
import { showWorkflowBrowser } from "./workflow-browser.js";

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

  const driveController = new DriveRuntimeController();
  const lifecycleState = new ExtensionLifecycleState();
  const sessionNavigator = new SessionNavigator({
    hasActiveDrive: () => driveController.hasActive(),
    liveRunCount: () => driveController.liveRunCount(),
    isTaskLive: (taskId) => driveController.isTaskLive(taskId),
  });
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
    return collectLivePaneLaunches(ctx.cwd, driveController.liveRunValues());
  }

  function watchedLiveRunCount(): number {
    return driveController.liveRunCount();
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
              driveController.getLiveRun(launch.taskId)?.handle.steer(message);
            },
            onFollowUp: (launch, message) => {
              driveController.getLiveRun(launch.taskId)?.handle.followUp(message);
            },
            ...(isCommandContext(ctx)
              ? {
                  canOpenSession: () =>
                    !sessionSwitchBlocked(
                      driveController.hasActive(),
                      driveController.liveRunCount()
                    ),
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
            if (
              !lifecycleState.isActive() ||
              livePaneLaunches(ctx).length === 0 ||
              !canShowLivePane(ctx)
            ) {
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
      if (lifecycleState.isActive()) refreshUI(ctx);
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
    const showBoard = sessionOwnsBoard(ctx, board) || driveController.liveRunCount() > 0;
    if (board.tasks.length === 0 || !showBoard) {
      ctx.ui.setStatus(COMMAND, undefined);
      ctx.ui.setWidget(COMMAND, undefined);
      ctx.ui.setWorkingMessage();
      return;
    }

    const progress = formatBoardProgress(board.tasks);
    const status = projectStatus(board, driveController.liveTaskIds(), loadConfig(ctx.cwd));
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
      const lines = [...driveController.liveRunValues()].map((run) => {
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

  function sendDecision(evidence: string, decisionId: string): void {
    if (!lifecycleState.isActive()) throw new Error("Maestro session runtime is no longer active.");
    pi.sendMessage(
      { customType: MESSAGE_TYPE, content: evidence, display: true, details: { decisionId } },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  }

  const driveServices = {
    startExecutor: dependencies.startExecutor,
    isRuntimeActive: () => lifecycleState.isActive(),
    adoptBoard,
    refreshUI,
    notify,
    sendDecision,
    onRunStarted: () => {
      if (suppressedAutoPaneDriveId !== currentDriveId()) suppressedAutoPaneDriveId = undefined;
    },
  };

  function startDrive(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    signal?: AbortSignal,
    reportProgress: (message: string) => void = () => {},
    humanRetryTaskId?: string,
    humanRetryExpectedRiskToken?: string
  ): BackgroundDrive {
    return driveController.startBackgroundDrive(
      ctx,
      taskIds,
      driveServices,
      signal,
      reportProgress,
      humanRetryTaskId,
      humanRetryExpectedRiskToken
    );
  }

  function launchCommandDrive(ctx: ExtensionCommandContext, taskIds: string[] | undefined): void {
    const operation = startDrive(ctx, taskIds, undefined, (message) => notify(ctx, message));
    void operation.promise.then(() => {
      if (!lifecycleState.isActive()) return;
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

  function requestRetry(ctx: ExtensionContext, taskId: string): Promise<void> {
    return driveController.requestHumanRetry(ctx, taskId, driveServices);
  }

  const commandRuntime: RunCommandRuntime = {
    hasActiveDrive: () => driveController.hasActive(),
    liveRunCount: () => driveController.liveRunCount(),
    liveTaskIds: () => new Set(driveController.liveTaskIds()),
    isTaskLive: (taskId) => driveController.isTaskLive(taskId),
    activeOwner: () => driveController.activeOwner(),
    requestPause: () => {
      driveController.requestPause();
    },
    abort: () => {
      driveController.abort();
    },
    launchDrive: launchCommandDrive,
    requestRetry,
    savePausedDrive: (cwd, pausedDrive) => driveController.savePausedDrive(cwd, pausedDrive),
  };
  const commandSession: RunCommandSession = {
    adoptBoard,
    onBoardChanged: refreshUI,
    startOrchestrator: (ctx, goal, briefing) => {
      nameSessionAfterGoal(ctx, goal, "maestro");
      pi.sendMessage(
        { customType: MESSAGE_TYPE, content: briefing, display: true },
        { triggerTurn: true }
      );
    },
  };

  registerMaestroTools({
    pi,
    adoptBoard,
    refreshUI,
    driveController,
    startBackgroundDrive: startDrive,
  });

  const commandDispatcher = new MaestroCommandDispatcher(
    process.cwd(),
    commandRuntime,
    commandSession,
    sessionNavigator,
    {
      showHome: showMaestroHome,
      showAgents: (ctx) => openLivePane(ctx, true),
      showWorkflows: (ctx) =>
        showWorkflowBrowser(ctx, {
          hasLiveRuns: () => driveController.liveRunCount() > 0,
          onBoardChanged: () => refreshUI(ctx),
          reviewPlan: showPlan,
        }),
      showDashboard,
      showPlan,
      onBoardChanged: refreshUI,
      notifyQuarantine,
    }
  );
  registerMaestroCommand(pi, commandDispatcher.dispatch, commandDispatcher.complete);

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
      isCommandContext(ctx) &&
      !sessionSwitchBlocked(driveController.hasActive(), driveController.liveRunCount());
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
            isLive: (taskId) => driveController.isTaskLive(taskId),
            liveKind: (taskId) => driveController.getLiveRun(taskId)?.kind,
            getLiveRun: (taskId) => {
              const live = driveController.getLiveRun(taskId);
              if (!live) return undefined;
              return {
                cost: live.cost,
                turns: live.turns,
                lastActivity: live.lastActivity,
              };
            },
            liveActivity: (taskId) => {
              const live = driveController.getLiveRun(taskId);
              if (!live) return undefined;
              const label = live.kind === "review" ? "reviewing" : "running";
              return `${label} · ${live.turns} turns · ${live.lastActivity}`;
            },
            steer: (taskId, message) => {
              driveController.getLiveRun(taskId)?.handle.steer(message);
            },
            followUp: (taskId, message) => {
              driveController.getLiveRun(taskId)?.handle.followUp(message);
            },
            abort: (taskId) => {
              driveController.getLiveRun(taskId)?.handle.abort();
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
                  (id) => driveController.isTaskLive(id)
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
                isLive: (id) => driveController.isTaskLive(id),
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
      await requestRetry(ctx, selection.taskId);
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
      hasLiveRuns: () => driveController.liveRunCount() > 0,
      onChanged: () => refreshUI(ctx),
      onApproved: () => {
        refreshUI(ctx);
        labelCurrentEntry(ctx, "maestro: plan approved");
      },
    });
  }

  async function showBoard(ctx: ExtensionCommandContext): Promise<void> {
    await showTaskBrowser(ctx, {
      isLive: (taskId) => driveController.isTaskLive(taskId),
      requestRetry,
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
    const status = projectStatus(board, driveController.liveTaskIds(), loadConfig(ctx.cwd));
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
        description: `${livePaneLaunches(ctx).length} recorded · ${driveController.liveRunCount()} live`,
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

  registerMaestroLifecycle(pi, {
    state: lifecycleState,
    driveController,
    setCommandCwd: (cwd) => commandDispatcher.setCwd(cwd),
    setPreviousSession: (sessionFile) => sessionNavigator.setPrevious(sessionFile),
    closeLivePane,
    clearSuppressedPane: () => {
      suppressedAutoPaneDriveId = undefined;
    },
    refreshUI,
    sessionOwnsBoard,
    sendDecision,
  });
}
