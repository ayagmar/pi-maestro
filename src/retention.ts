import { readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stateDir } from "./board.js";
import { LOGS_DIR } from "./constants.js";
import { type Board } from "./types.js";

export type LogRetentionState = "active" | "retained" | "stale";

export interface LogRetentionEntry {
  file: string;
  size: number;
  state: LogRetentionState;
  taskId?: string;
}

const MAX_WARNING_LENGTH = 240;
const MAX_WARNINGS = 20;

function warning(action: string, file: string, _error: unknown): string {
  return `${action} ${basename(file)} due to a filesystem error`.slice(0, MAX_WARNING_LENGTH);
}

function addWarning(warnings: string[], message: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(message);
}

function logIdentity(name: string): { taskId: string; attempt: number } | undefined {
  const match = /^(.+?)-(?:attempt|review)-(\d+)(?:-launch-\d+)?\.jsonl$/.exec(name);
  if (!match?.[1] || !match[2]) return undefined;
  return { taskId: match[1], attempt: Number(match[2]) };
}

/** Classify maestro JSONL logs without modifying state. Files that cannot be inspected are skipped. */
export function inspectLogRetention(
  cwd: string,
  board: Board,
  liveTaskIds: ReadonlySet<string> = new Set(),
  warnings: string[] = []
): LogRetentionEntry[] {
  const directory = join(stateDir(cwd), LOGS_DIR);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") addWarning(warnings, warning("could not inspect", directory, error));
    return [];
  }
  const tasks = new Map(board.tasks.map((task) => [task.id, task]));
  const entries: LogRetentionEntry[] = [];

  for (const name of names.filter((item) => item.endsWith(".jsonl"))) {
    const file = join(directory, name);
    try {
      const identity = logIdentity(name);
      const task = identity ? tasks.get(identity.taskId) : undefined;
      const latestAttempt = task?.attempts.at(-1)?.index ?? task?.attempts.length;
      const isLatest = identity !== undefined && identity.attempt === latestAttempt;
      let state: LogRetentionState = "stale";
      if (identity && liveTaskIds.has(identity.taskId)) state = "active";
      else if (task && isLatest) state = task.status === "approved" ? "retained" : "active";
      entries.push({
        file,
        size: statSync(file).size,
        state,
        ...(identity ? { taskId: identity.taskId } : {}),
      });
    } catch (error) {
      addWarning(warnings, warning("could not inspect", file, error));
    }
  }
  return entries;
}

export interface LogCleanupResult {
  removed: LogRetentionEntry[];
  preserved: LogRetentionEntry[];
  warnings: string[];
}

/** Delete only snapshot-confirmed files which are still stale after live-state rechecks. */
export function cleanupStaleLogs(
  cwd: string,
  confirmedFiles: ReadonlySet<string>,
  getBoard: () => Board,
  isLive: (taskId: string) => boolean
): LogCleanupResult {
  const removed: LogRetentionEntry[] = [];
  const preserved: LogRetentionEntry[] = [];
  const warnings: string[] = [];
  for (const confirmedFile of confirmedFiles) {
    try {
      const identity = logIdentity(basename(confirmedFile));
      if (identity && isLive(identity.taskId)) {
        try {
          preserved.push({
            file: confirmedFile,
            size: statSync(confirmedFile).size,
            state: "active",
            taskId: identity.taskId,
          });
        } catch (error) {
          addWarning(warnings, warning("could not inspect", confirmedFile, error));
        }
        continue;
      }
      const board = getBoard();
      const entry = inspectLogRetention(cwd, board, new Set(), warnings).find(
        (candidate) => resolve(candidate.file) === resolve(confirmedFile)
      );
      if (entry?.state !== "stale") {
        if (entry) preserved.push(entry);
        continue;
      }
      // Liveness may change while the board and filesystem are inspected.
      if (identity && isLive(identity.taskId)) {
        preserved.push({ ...entry, state: "active" });
        continue;
      }
      try {
        unlinkSync(entry.file);
        removed.push(entry);
      } catch (error) {
        addWarning(warnings, warning("could not delete", entry.file, error));
      }
    } catch (error) {
      addWarning(warnings, warning("could not inspect", confirmedFile, error));
    }
  }
  return { removed, preserved, warnings };
}

function cleanupSnapshot(
  cwd: string,
  snapshot: LogRetentionEntry[],
  getBoard: () => Board,
  isLive: (taskId: string) => boolean,
  inspectionWarnings: string[] = []
): LogCleanupResult {
  const result = cleanupStaleLogs(
    cwd,
    new Set(snapshot.map((entry) => resolve(entry.file))),
    getBoard,
    isLive
  );
  result.warnings.unshift(...inspectionWarnings.slice(0, MAX_WARNINGS));
  result.warnings.splice(MAX_WARNINGS);
  return result;
}

/** Remove only superseded attempts for one newly approved task. */
export function pruneTaskLogs(
  cwd: string,
  taskId: string,
  getBoard: () => Board,
  isLive: (taskId: string) => boolean
): LogCleanupResult {
  const warnings: string[] = [];
  try {
    const snapshot = inspectLogRetention(cwd, getBoard(), new Set(), warnings).filter(
      (entry) => entry.taskId === taskId && entry.state === "stale"
    );
    return cleanupSnapshot(cwd, snapshot, getBoard, isLive, warnings);
  } catch (error) {
    addWarning(warnings, warning("could not inspect", "logs", error));
    return { removed: [], preserved: [], warnings };
  }
}

export interface LogCaptureResult {
  entries: LogRetentionEntry[];
  warnings: string[];
}

/** Capture only files attributable to attempts recorded on this board. */
export function captureBoardLogs(cwd: string, board: Board): LogCaptureResult {
  const expectedNames = new Set<string>();
  for (const task of board.tasks) {
    for (const attempt of task.attempts) {
      expectedNames.add(basename(attempt.logFile));

      const reviewLaunches = attempt.reviewLaunches ?? [];
      for (let launch = 1; launch <= reviewLaunches.length; launch += 1) {
        expectedNames.add(`${task.id}-review-${attempt.index}-launch-${launch}.jsonl`);
      }

      // Boards written before launch history was introduced used one unnumbered
      // review log. Include it only when the attempt persisted evidence of a review.
      const hasLegacyReviewEvidence =
        reviewLaunches.length === 0 &&
        (attempt.reviewReport !== undefined ||
          attempt.reviewNotes !== undefined ||
          attempt.reviewModel !== undefined ||
          attempt.reviewProvider !== undefined ||
          attempt.reviewUsage !== undefined ||
          attempt.reviewSessionFile !== undefined ||
          attempt.failureReason?.kind === "reviewer_failure" ||
          attempt.failureReason?.kind === "reviewer_rejection");
      if (hasLegacyReviewEvidence) {
        expectedNames.add(`${task.id}-review-${attempt.index}.jsonl`);
      }
    }
  }

  const warnings: string[] = [];
  const entries = inspectLogRetention(cwd, board, new Set(), warnings).filter((entry) =>
    expectedNames.has(basename(entry.file))
  );
  return { entries, warnings };
}

/** Remove stale files from a captured archived-board snapshot only. */
export function pruneStaleLogs(
  cwd: string,
  archivedSnapshot: LogRetentionEntry[],
  getBoard: () => Board,
  isLive: (taskId: string) => boolean,
  inspectionWarnings: string[] = []
): LogCleanupResult {
  return cleanupSnapshot(cwd, archivedSnapshot, getBoard, isLive, inspectionWarnings);
}
