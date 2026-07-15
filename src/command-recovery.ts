import { resolve } from "node:path";
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  listArchivedBoards,
  loadBoard,
  loadStatusHistory,
  replaceBoardWithArchive,
  restoreArchivedBoard,
} from "./board.js";
import { pickFromList } from "./command-ui.js";
import { COMMAND } from "./constants.js";
import { buildDoctorReport } from "./diagnostics.js";
import { formatStatusHistory } from "./format.js";
import { notify } from "./handoff.js";
import {
  captureBoardLogs,
  cleanupStaleLogs,
  inspectLogRetention,
  pruneStaleLogs,
} from "./retention.js";
import {
  cleanupManagedWorktrees,
  inspectManagedWorktrees,
  parkInactiveWorktrees,
} from "./worktree.js";

export interface RecoveryCommandRuntime {
  hasLiveRuns(): boolean;
  isTaskLive(taskId: string): boolean;
  liveTaskIds(): Set<string>;
  onBoardChanged(): void;
}

export async function handleDoctorCommand(
  ctx: ExtensionCommandContext,
  restParts: string[],
  runtime: RecoveryCommandRuntime
): Promise<void> {
  const liveTaskIds = runtime.liveTaskIds();
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
    runtime.isTaskLive
  );
  const logResult = cleanupStaleLogs(
    ctx.cwd,
    new Set(logCandidates.map((entry) => resolve(entry.file))),
    () => loadBoard(ctx.cwd),
    runtime.isTaskLive
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
}

export function handleHistoryCommand(ctx: ExtensionCommandContext, rest: string): void {
  const history = loadStatusHistory(ctx.cwd);
  if (!history) {
    notify(ctx, "No history yet.");
    return;
  }
  const requestedCount = Number.parseInt(rest, 10);
  const count = Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : 20;
  notify(ctx, formatStatusHistory(history.entries, history.skipped, count));
}

export async function handleReplayCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  runtime: RecoveryCommandRuntime
): Promise<void> {
  if (runtime.hasLiveRuns()) {
    notify(ctx, "Executors are still running. Abort them before replaying a board.", "warning");
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

  if (runtime.hasLiveRuns()) {
    notify(ctx, "Executors are still running. Abort them before replaying a board.", "warning");
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
        runtime.isTaskLive,
        archivedLogs.warnings
      );
      if (cleanup.warnings.length > 0) {
        notify(ctx, `Log cleanup warning: ${cleanup.warnings.join("; ").slice(0, 500)}`, "warning");
      }
    }
    runtime.onBoardChanged();
    const previous = restored.archivedCurrent
      ? ` Current board archived at ${restored.archivedCurrent}.`
      : "";
    notify(ctx, `Board restored from ${restored.selectedFile}.${previous}`);
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

export async function handleResetCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  runtime: RecoveryCommandRuntime
): Promise<void> {
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
  if (runtime.hasLiveRuns()) {
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
    if (runtime.hasLiveRuns()) {
      reportReset("Executors started during confirmation. Abort them before resetting.", "warning");
      return;
    }
  }

  const archivedLogs = captureBoardLogs(ctx.cwd, board);
  for (const warning of archivedLogs.warnings) {
    reportReset(`Log cleanup warning: ${warning}`, "warning");
  }
  const parking = parkInactiveWorktrees(ctx.cwd, board, runtime.liveTaskIds());
  for (const warning of parking.warnings) {
    reportReset(`Worktree cleanup warning: ${warning}`, "warning");
  }
  let archivePath: string | undefined;
  try {
    archivePath = replaceBoardWithArchive(
      ctx.cwd,
      () => ({ version: 1, nextTaskNumber: 1, tasks: [] }),
      board.revision ?? 0
    );
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
    runtime.isTaskLive,
    archivedLogs.warnings
  );
  if (cleanup.warnings.length > 0) {
    notify(ctx, `Log cleanup warning: ${cleanup.warnings.join("; ").slice(0, 500)}`, "warning");
  }
  runtime.onBoardChanged();
  reportReset(`Board reset. Archived at ${archivePath}`);
}
