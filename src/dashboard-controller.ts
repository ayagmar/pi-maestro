import { basename } from "node:path";
import {
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  assertTaskNotDispatched,
  findTask,
  forceStatus,
  humanRetryEligibility,
  latestArchiveFile,
  loadBoard,
  loadStatusHistory,
  updateTask,
} from "./board.js";
import { loadConfig } from "./config.js";
import { COMMAND } from "./constants.js";
import { Dashboard, type DashboardTaskAction } from "./dashboard.js";
import { type DriveRuntimeController } from "./drive-controller.js";
import { notify } from "./handoff.js";
import { manuallyApproveTask } from "./manual-approval.js";
import { pruneTaskLogs } from "./retention.js";
import { findSessionFile } from "./runner.js";
import { sessionSwitchBlocked } from "./session-control.js";
import { type SessionNavigator } from "./session-navigator.js";
import { parkInactiveWorktrees } from "./worktree.js";

export interface DashboardControllerDependencies {
  driveController: DriveRuntimeController;
  sessionNavigator: SessionNavigator;
  refreshUI(ctx: ExtensionContext): void;
  requestRetry(ctx: ExtensionContext, taskId: string): Promise<void>;
  showTaskBrowser(ctx: ExtensionCommandContext): Promise<void>;
  showTaskReport(cwd: string, taskId: string): void;
  showTaskReview(cwd: string, taskId: string): void;
}

export async function showDashboard(
  ctx: ExtensionContext,
  dependencies: DashboardControllerDependencies
): Promise<void> {
  const { driveController, sessionNavigator } = dependencies;
  const canSwitchSessions = () =>
    isCommandContext(ctx) &&
    !sessionSwitchBlocked(driveController.hasActive(), driveController.liveRunCount());
  if (ctx.mode !== "tui") {
    if (isCommandContext(ctx)) await dependencies.showTaskBrowser(ctx);
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
            return { cost: live.cost, turns: live.turns, lastActivity: live.lastActivity };
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
            const parking = parkInactiveWorktrees(
              ctx.cwd,
              loadBoard(ctx.cwd),
              new Set([...driveController.liveRunValues()].map((run) => run.taskId))
            );
            for (const warning of parking.warnings) {
              notify(ctx, `Worktree cleanup warning: ${warning}`, "warning");
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
            dependencies.refreshUI(ctx);
          },
          hasExecutorSession: (taskId) => {
            const task = findTask(loadBoard(ctx.cwd), taskId);
            const attempt = task?.attempts.at(-1);
            return canSwitchSessions() && attempt ? findSessionFile(attempt) !== undefined : false;
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
        { getRows: () => tui.terminal.rows, initialView: "phase" }
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
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    }
  );

  if (!selection) return;
  if (selection.action === "retry") {
    await dependencies.requestRetry(ctx, selection.taskId);
    return;
  }
  if (selection.action === "view_report") {
    dependencies.showTaskReport(ctx.cwd, selection.taskId);
    return;
  }
  if (selection.action === "view_review") {
    dependencies.showTaskReview(ctx.cwd, selection.taskId);
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
