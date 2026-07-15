import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findTask, loadBoard } from "./board.js";
import { COMMAND } from "./constants.js";
import { notify } from "./handoff.js";
import { findSessionFile } from "./runner.js";
import { sessionSwitchBlocked } from "./session-control.js";

export interface SessionNavigatorState {
  hasActiveDrive(): boolean;
  liveRunCount(): number;
  isTaskLive(taskId: string): boolean;
}

export class SessionNavigator {
  private previousSession: string | undefined;

  constructor(private readonly state: SessionNavigatorState) {}

  setPrevious(sessionFile: string | undefined): void {
    this.previousSession = sessionFile;
  }

  async back(ctx: ExtensionCommandContext): Promise<void> {
    if (!this.previousSession) {
      notify(ctx, "No session to go back to. Use /resume to pick one.", "warning");
      return;
    }
    const target = this.previousSession;
    this.previousSession = ctx.sessionManager.getSessionFile();
    await ctx.switchSession(target);
  }

  async openReviewer(ctx: ExtensionCommandContext, taskId: string): Promise<void> {
    const task = findTask(loadBoard(ctx.cwd), taskId);
    const reviewSession = task?.attempts.at(-1)?.reviewSessionFile;
    if (reviewSession) await this.switchWithReturn(ctx, reviewSession);
  }

  async openTask(ctx: ExtensionCommandContext, taskId: string): Promise<void> {
    const board = loadBoard(ctx.cwd);
    const task = findTask(board, taskId);
    if (!task) {
      notify(ctx, `Unknown task: ${taskId}`, "error");
      return;
    }
    if (this.state.isTaskLive(task.id)) {
      notify(
        ctx,
        `${task.id} is still running — watch it live in /${COMMAND} board (s to steer, x to abort). The session opens here once it finishes.`,
        "warning"
      );
      return;
    }
    const attempt = task.attempts.at(-1);
    const sessionFile = attempt ? findSessionFile(attempt) : undefined;
    if (!sessionFile) {
      notify(ctx, `${task.id} has no executor session yet.`, "warning");
      return;
    }
    const confirmed = await ctx.ui.confirm(
      `Open executor session for ${task.id}?`,
      `This switches the current TUI into the executor's session. Use /${COMMAND} back to return here.`
    );
    if (!confirmed) return;
    await this.switchWithReturn(ctx, sessionFile);
  }

  async switchWithReturn(ctx: ExtensionCommandContext, sessionFile: string): Promise<void> {
    if (sessionSwitchBlocked(this.state.hasActiveDrive(), this.state.liveRunCount())) {
      notify(
        ctx,
        `Pause the autonomous drive and wait for active executors before switching sessions. Use /${COMMAND} abort to stop them immediately.`,
        "warning"
      );
      return;
    }
    const current = ctx.sessionManager.getSessionFile();
    const result = await ctx.switchSession(sessionFile);
    if (!result.cancelled && current) this.previousSession = current;
  }
}
