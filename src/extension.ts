import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type SelectItem, Text } from "@earendil-works/pi-tui";
import {
  consumeQuarantineNotice,
  findTask,
  loadBoard,
  restoreQuarantineNotice,
  updateBoard,
} from "./board.js";
import { MaestroCommandDispatcher } from "./command-dispatcher.js";
import { type RunCommandRuntime, type RunCommandSession } from "./command-run-control.js";
import { pickFromList } from "./command-ui.js";
import { registerMaestroCommand } from "./commands.js";
import { loadConfig } from "./config.js";
import { COMMAND, MESSAGE_TYPE } from "./constants.js";
import { showDashboard as showDashboardOverlay } from "./dashboard-controller.js";
import { type BackgroundDrive, DriveRuntimeController } from "./drive-controller.js";
import { ExtensionLifecycleState, registerMaestroLifecycle } from "./extension-lifecycle.js";
import { boardUsage, formatBoardProgress } from "./format.js";
import { notify } from "./handoff.js";
import { LivePaneController } from "./live-pane-controller.js";
import { manuallyApproveTask } from "./manual-approval.js";
import { showPlanReview } from "./plan-review-controller.js";
import { startExecutor as defaultStartExecutor } from "./runner.js";
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
  const livePaneController = new LivePaneController({
    driveController,
    sessionNavigator,
    isRuntimeActive: () => lifecycleState.isActive(),
    sessionOwnsBoard,
    refreshUI,
  });

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
    livePaneController.sync(ctx);

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
    const status = projectStatus(
      board,
      driveController.liveTaskIds(),
      loadConfig(ctx.cwd),
      driveController.liveRunKinds()
    );
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
        render: () => (livePaneController.isVisible(tui.terminal.columns) ? [] : lines),
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
    onRunStarted: () => livePaneController.onRunStarted(),
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
      showAgents: (ctx) => livePaneController.open(ctx, true),
      showWorkflows: (ctx) =>
        showWorkflowBrowser(ctx, {
          hasLiveRuns: () => driveController.liveRunCount() > 0,
          onBoardChanged: () => refreshUI(ctx),
          reviewPlan: showPlan,
        }),
      showDashboard: openDashboard,
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
      await openDashboard(ctx);
    },
  });

  pi.registerShortcut("ctrl+alt+w", {
    description: "Open or close Maestro agent sessions",
    handler: (ctx) => livePaneController.cycle(ctx),
  });

  function openDashboard(ctx: ExtensionContext): Promise<void> {
    return showDashboardOverlay(ctx, {
      driveController,
      sessionNavigator,
      refreshUI,
      requestRetry,
      showTaskBrowser: showBoard,
      showTaskReport,
      showTaskReview,
    });
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
    const status = projectStatus(
      board,
      driveController.liveTaskIds(),
      loadConfig(ctx.cwd),
      driveController.liveRunKinds()
    );
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
        description: `${livePaneController.launches(ctx).length} recorded · ${driveController.liveRunCount()} live`,
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
    closeLivePane: () => livePaneController.close(),
    clearSuppressedPane: () => livePaneController.clearSuppression(),
    refreshUI,
    sessionOwnsBoard,
    sendDecision,
  });
}
