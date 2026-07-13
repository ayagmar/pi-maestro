import {
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { MESSAGE_TYPE } from "./constants.js";

export function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info"
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

export async function runHandoff(options: {
  ctx: ExtensionCommandContext;
  briefing: string;
  goal: string;
  adoptBoard(ctx: ExtensionContext): void;
}): Promise<void> {
  const { ctx, briefing, goal, adoptBoard } = options;
  await ctx.waitForIdle();
  const parentSession = ctx.sessionManager.getSessionFile();
  const notifier = ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : undefined;
  const reportFailure = (message: string) => {
    try {
      if (notifier) notifier(message, "error");
      else console.error(message);
    } catch {
      // Session replacement may invalidate the command context.
    }
  };

  try {
    await ctx.newSession({
      ...(parentSession ? { parentSession } : {}),
      setup: async (sessionManager) => {
        const summary = goal.length > 48 ? `${goal.slice(0, 48)}…` : goal;
        sessionManager.appendSessionInfo(`supervisor: ${summary}`);
      },
      withSession: async (fresh) => {
        try {
          adoptBoard(fresh);
          await fresh.sendMessage(
            { customType: MESSAGE_TYPE, content: briefing, display: true },
            { triggerTurn: true }
          );
        } catch (error) {
          reportFailure(
            `Could not complete maestro handoff: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
    });
  } catch (error) {
    reportFailure(
      `Could not start maestro handoff: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
