import { findTask, latestArchiveFile, loadArchivedBoard, loadBoard } from "./board.js";
import { taskLaunches } from "./dashboard-launches.js";
import type { LiveRun } from "./drive-controller.js";
import { type LivePaneLaunch } from "./live-pane.js";

export function collectLivePaneLaunches(
  cwd: string,
  liveRuns: Iterable<LiveRun>
): LivePaneLaunch[] {
  const runs = [...liveRuns];
  const currentBoard = loadBoard(cwd);
  let board = currentBoard;
  let archived = false;
  if (currentBoard.tasks.length === 0) {
    const latestArchive = latestArchiveFile(cwd);
    if (latestArchive) {
      try {
        board = loadArchivedBoard(cwd, latestArchive.file);
        archived = true;
      } catch {
        // A corrupt newest archive must not hide the empty current board or break the TUI.
      }
    }
  }

  const liveByLog = new Map(runs.map((run) => [run.handle.attempt.logFile, run] as const));
  const launches = board.tasks.flatMap((task) =>
    taskLaunches(task).map((launch): LivePaneLaunch => {
      const review = launch.review;
      const logFile = review?.logFile ?? launch.attempt.logFile;
      const live = liveByLog.get(logFile);
      return {
        key: launch.key,
        taskId: task.id,
        title: `${task.title} · ${launch.label}${archived ? " · archived" : ""}`,
        kind: launch.kind,
        logFile,
        ...(live?.handle.attempt.sessionFile || review?.sessionFile || launch.attempt.sessionFile
          ? {
              sessionFile:
                live?.handle.attempt.sessionFile ??
                review?.sessionFile ??
                launch.attempt.sessionFile,
            }
          : {}),
        ...(live?.handle.attempt.model || review?.model || launch.attempt.model
          ? { model: live?.handle.attempt.model ?? review?.model ?? launch.attempt.model }
          : {}),
        ...(live?.handle.attempt.provider || review?.provider || launch.attempt.provider
          ? {
              provider:
                live?.handle.attempt.provider ?? review?.provider ?? launch.attempt.provider,
            }
          : {}),
        turns: live?.turns ?? review?.usage.turns ?? launch.attempt.usage.turns,
        cost: live?.cost ?? review?.usage.cost ?? launch.attempt.usage.cost,
        lastActivity: live?.lastActivity ?? "settled",
        live: live !== undefined,
      };
    })
  );

  const representedLogs = new Set(launches.map((launch) => launch.logFile));
  for (const run of runs) {
    const attempt = run.handle.attempt;
    if (representedLogs.has(attempt.logFile)) continue;
    const task = findTask(board, run.taskId);
    launches.push({
      key: `${run.taskId}:${run.kind}:${attempt.index}:${attempt.startedAt}`,
      taskId: run.taskId,
      title: task?.title ?? run.taskId,
      kind: run.kind,
      logFile: attempt.logFile,
      ...(attempt.sessionFile ? { sessionFile: attempt.sessionFile } : {}),
      ...(attempt.model ? { model: attempt.model } : {}),
      ...(attempt.provider ? { provider: attempt.provider } : {}),
      turns: run.turns,
      cost: run.cost,
      lastActivity: run.lastActivity,
      live: true,
    });
  }
  return launches;
}
