import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type SelectItem } from "@earendil-works/pi-tui";
import {
  assertTaskNotDispatched,
  findTask,
  forceStatus,
  humanRetryEligibility,
  loadBoard,
  updateTask,
} from "./board.js";
import { pickFromList } from "./command-ui.js";
import { loadConfig } from "./config.js";
import { boardUsage, formatUsage, STATUS_LABELS, taskLine, truncateText } from "./format.js";
import { notify } from "./handoff.js";
import { pruneTaskLogs } from "./retention.js";
import { type TaskStatus } from "./types.js";

export interface TaskBrowserActions {
  isLive(taskId: string): boolean;
  requestRetry(ctx: ExtensionCommandContext, taskId: string): Promise<void>;
  manuallyApprove(ctx: ExtensionCommandContext, taskId: string): void;
  showReport(cwd: string, taskId: string): void;
  showReview(cwd: string, taskId: string): void;
  openExecutor(ctx: ExtensionCommandContext, taskId: string): Promise<void>;
  openReviewer(ctx: ExtensionCommandContext, taskId: string): Promise<void>;
  onStatusChanged(ctx: ExtensionCommandContext, taskId: string, status: TaskStatus): void;
}

export async function showTaskBrowser(
  ctx: ExtensionCommandContext,
  actions: TaskBrowserActions
): Promise<void> {
  const board = loadBoard(ctx.cwd);
  if (board.tasks.length === 0) {
    notify(ctx, "Board is empty. Use /maestro start <goal> or ask the model to plan tasks.");
    return;
  }

  const items: SelectItem[] = board.tasks.map((task) => ({
    value: task.id,
    label: taskLine(task),
    description: truncateText(task.brief, 1),
  }));

  const taskId = await pickFromList(
    ctx,
    `Maestro Board · ${formatUsage(boardUsage(board.tasks))}`,
    items
  );
  if (!taskId) return;
  await showTaskActions(ctx, taskId, actions);
}

async function showTaskActions(
  ctx: ExtensionCommandContext,
  taskId: string,
  actions: TaskBrowserActions
): Promise<void> {
  const board = loadBoard(ctx.cwd);
  const task = findTask(board, taskId);
  if (!task) return;

  const items: SelectItem[] = [{ value: "report", label: "View last report" }];
  if (task.attempts.at(-1)?.reviewReport) {
    items.push({ value: "review", label: "View review verdict" });
  }
  if (task.attempts.length > 0) {
    items.push({
      value: "open",
      label: "Open executor session",
      description: "Switch this TUI into the executor's session",
    });
  }
  if (task.attempts.at(-1)?.reviewSessionFile) {
    items.push({
      value: "open-review",
      label: "Open reviewer session",
      description: "Switch this TUI into the reviewer's session",
    });
  }
  const config = loadConfig(ctx.cwd);
  const retry = humanRetryEligibility(board, task.id, {
    maxAttempts: config.maxAttempts,
    config,
    isLive: actions.isLive,
    ...(ctx.sessionManager.getSessionFile()
      ? { ownerSession: ctx.sessionManager.getSessionFile() }
      : {}),
  });
  if (retry.eligible) {
    items.push({ value: "retry", label: "Retry failed work", description: retry.message });
  }
  if (!(["approved", "failed", "cancelled"] as TaskStatus[]).includes(task.status)) {
    for (const status of [
      "todo",
      "ready_for_review",
      "changes_requested",
      "approved",
      "cancelled",
    ] as TaskStatus[]) {
      if (status !== task.status) {
        items.push({ value: `status:${status}`, label: `Mark as ${STATUS_LABELS[status]}` });
      }
    }
  }

  const action = await pickFromList(
    ctx,
    `${task.id} ${task.title} · ${STATUS_LABELS[task.status]}`,
    items
  );
  if (!action) return;

  if (action === "report") {
    actions.showReport(ctx.cwd, task.id);
    return;
  }
  if (action === "review") {
    actions.showReview(ctx.cwd, task.id);
    return;
  }
  if (action === "open") {
    await actions.openExecutor(ctx, task.id);
    return;
  }
  if (action === "open-review") {
    await actions.openReviewer(ctx, task.id);
    return;
  }
  if (action === "retry") {
    await actions.requestRetry(ctx, task.id);
    return;
  }
  if (!action.startsWith("status:")) return;

  const status = action.slice("status:".length) as TaskStatus;
  try {
    if (status === "approved") actions.manuallyApprove(ctx, task.id);
    else {
      updateTask(ctx.cwd, task.id, (fresh) => {
        assertTaskNotDispatched(fresh);
        forceStatus(fresh, status);
      });
    }
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "warning");
    return;
  }
  if (status === "approved") {
    const cleanup = pruneTaskLogs(ctx.cwd, task.id, () => loadBoard(ctx.cwd), actions.isLive);
    for (const warning of cleanup.warnings) {
      notify(ctx, `Log cleanup warning: ${warning}`, "warning");
    }
  }
  actions.onStatusChanged(ctx, task.id, status);
  notify(ctx, `${task.id} → ${STATUS_LABELS[status]}`);
}
