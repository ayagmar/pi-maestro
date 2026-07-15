import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadBoard, replaceBoard, replaceBoardWithArchive } from "./board.js";
import { describeTiersForPlanning, loadConfig } from "./config.js";
import { COMMAND } from "./constants.js";
import { confirmDriveScale, validateDriveStart } from "./drive-preflight.js";
import { notify, runHandoff } from "./handoff.js";
import { buildOrchestratorBriefing, buildSupervisorBriefing } from "./prompts.js";
import { captureBoardLogs, pruneStaleLogs } from "./retention.js";
import { canonicalTaskIds, sessionCanControlDrive } from "./session-control.js";
import type { ActiveDriveControl } from "./drive-controller.js";
import type { PausedDriveState } from "./types.js";
import { inspectGit } from "./worktree.js";

export interface RunCommandRuntime {
  hasActiveDrive(): boolean;
  liveRunCount(): number;
  isTaskLive(taskId: string): boolean;
  activeOwner(): Pick<ActiveDriveControl, "id" | "cwd" | "ownerSession" | "taskIds"> | undefined;
  requestPause(): void;
  abort(): void;
  launchDrive(ctx: ExtensionCommandContext, taskIds: string[] | undefined): void;
  requestRetry(ctx: ExtensionContext, taskId: string): Promise<void>;
  savePausedDrive(cwd: string, pausedDrive: PausedDriveState | undefined): void;
}

export interface RunCommandSession {
  adoptBoard(ctx: ExtensionContext): void;
  onBoardChanged(ctx: ExtensionContext): void;
  startOrchestrator(ctx: ExtensionContext, goal: string, briefing: string): void;
}

export async function handleStartCommand(
  ctx: ExtensionCommandContext,
  goal: string,
  runtime: RunCommandRuntime,
  session: RunCommandSession
): Promise<void> {
  if (!goal) {
    notify(ctx, "Usage: /maestro start <goal>", "warning");
    return;
  }
  if (runtime.liveRunCount() > 0) {
    notify(ctx, "Executors are still running. Abort them before starting a new goal.", "warning");
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
  if (board.tasks.length > 0) {
    const previousRevision = board.revision ?? 0;
    const archivedLogs = captureBoardLogs(ctx.cwd, board);
    for (const warning of archivedLogs.warnings) {
      notify(ctx, `Log cleanup warning: ${warning}`, "warning");
    }
    board = { version: 1, nextTaskNumber: 1, tasks: [], goal };
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
        runtime.isTaskLive,
        archivedLogs.warnings
      );
      if (cleanup.warnings.length > 0) {
        notify(ctx, `Log cleanup warning: ${cleanup.warnings.join("; ").slice(0, 500)}`, "warning");
      }
      notify(ctx, `Previous board archived: ${archivePath}`);
    }
  } else {
    board.goal = goal;
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

  session.adoptBoard(ctx);
  session.onBoardChanged(ctx);
  session.startOrchestrator(
    ctx,
    goal,
    buildOrchestratorBriefing(
      goal,
      describeTiersForPlanning(loadConfig(ctx.cwd)),
      loadConfig(ctx.cwd).planGate
    )
  );
}

export async function handleDriveCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  runtime: RunCommandRuntime
): Promise<void> {
  if (runtime.hasActiveDrive() || runtime.liveRunCount() > 0) {
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
  runtime.launchDrive(ctx, taskIds);
}

export async function handleRetryCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  restParts: string[],
  runtime: RunCommandRuntime
): Promise<void> {
  if (!rest || restParts.length !== 1) {
    notify(ctx, `Usage: /${COMMAND} retry <taskId>`, "warning");
    return;
  }
  await runtime.requestRetry(ctx, rest);
}

export function handlePauseCommand(ctx: ExtensionCommandContext, runtime: RunCommandRuntime): void {
  const currentSession = ctx.sessionManager.getSessionFile();
  if (!runtime.hasActiveDrive()) {
    const paused = loadBoard(ctx.cwd).pausedDrive;
    notify(
      ctx,
      paused ? "Autonomous drive is already paused." : "No autonomous drive is active.",
      "warning"
    );
    return;
  }
  const activeOwner = runtime.activeOwner();
  if (
    activeOwner?.cwd !== ctx.cwd ||
    !sessionCanControlDrive(activeOwner.ownerSession, currentSession)
  ) {
    notify(ctx, "Only the session that started this drive may pause it.", "warning");
    return;
  }
  runtime.requestPause();
  notify(ctx, "Pause requested. Active executors will finish; no new batch will start.");
}

export async function handleResumeCommand(
  ctx: ExtensionCommandContext,
  runtime: RunCommandRuntime
): Promise<void> {
  const board = loadBoard(ctx.cwd);
  const paused = board.pausedDrive;
  if (!paused) {
    notify(ctx, "No paused autonomous drive to resume.", "warning");
    return;
  }
  if (runtime.hasActiveDrive() || runtime.liveRunCount() > 0) {
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
  runtime.launchDrive(ctx, taskIds);
}

export function handleAbortCommand(ctx: ExtensionCommandContext, runtime: RunCommandRuntime): void {
  const currentSession = ctx.sessionManager.getSessionFile();
  if (runtime.hasActiveDrive()) {
    const activeOwner = runtime.activeOwner();
    if (
      activeOwner?.cwd !== ctx.cwd ||
      !sessionCanControlDrive(activeOwner.ownerSession, currentSession)
    ) {
      notify(ctx, "Only the session that started this drive may abort it.", "warning");
      return;
    }
    runtime.abort();
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
  runtime.savePausedDrive(ctx.cwd, undefined);
  notify(ctx, "Paused autonomous drive aborted. No executors were running.", "warning");
}

export async function handleHandoffCommand(
  ctx: ExtensionCommandContext,
  runtime: RunCommandRuntime,
  session: RunCommandSession
): Promise<void> {
  const board = loadBoard(ctx.cwd);
  if (board.tasks.length === 0) {
    notify(ctx, "Nothing to hand off — the board is empty.", "warning");
    return;
  }
  if (runtime.liveRunCount() > 0) {
    notify(
      ctx,
      `${runtime.liveRunCount()} executor(s) still running — switching sessions would abort them. Wait or abort them first.`,
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
    adoptBoard: session.adoptBoard,
  });
}
