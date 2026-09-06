import { sep } from "node:path";
import { findTask } from "./board.js";
import { type Board, type PausedDriveState } from "./types.js";

export function maestroBoardCwd(cwd: string): string {
  const marker = `${sep}.pi${sep}maestro${sep}worktrees${sep}`;
  const worktreeIndex = cwd.indexOf(marker);
  return worktreeIndex === -1 ? cwd : cwd.slice(0, worktreeIndex);
}

export function sessionCanControlDrive(
  ownerSession: string | undefined,
  currentSession: string | undefined
): boolean {
  return ownerSession === undefined || ownerSession === currentSession;
}

/**
 * Whether `currentSession` may resume or release a paused drive.
 *
 * Only a deliberate `/maestro pause` keeps its owner guard. A drive parked by
 * a provider outage or a settled escalation is a mechanical stop whose fix
 * (quota back, config edited) any session can apply — the owning session is
 * frequently closed by then, and the only escape was `/maestro reset`, which
 * archives the whole board. Concurrent starts are still serialized by the
 * atomic active-drive claim, so opening the paused guard cannot race two
 * drives. Records without a reason predate the field; they are treated as
 * mechanical because the stuck-behind-a-dead-session case is exactly what
 * they were found in.
 */
export function sessionCanResumePausedDrive(
  paused: Pick<PausedDriveState, "ownerSession" | "reason">,
  currentSession: string | undefined
): boolean {
  if (paused.reason !== "paused") return true;
  return sessionCanControlDrive(paused.ownerSession, currentSession);
}

export function sessionSwitchBlocked(activeDrive: boolean, liveRunCount: number): boolean {
  return activeDrive || liveRunCount > 0;
}

export function assertKnownTaskIds(board: Board, taskIds: string[] | undefined): void {
  if (!taskIds) return;
  const unknown = taskIds.filter((id) => !findTask(board, id));
  if (unknown.length > 0) throw new Error(`Unknown task id(s): ${unknown.join(", ")}`);
}

export function canonicalTaskIds(
  board: Board,
  taskIds: string[] | undefined
): string[] | undefined {
  if (!taskIds || taskIds.length === 0) return undefined;
  const canonicalIds: string[] = [];
  const unknownIds: string[] = [];

  for (const id of taskIds) {
    const task = findTask(board, id);
    if (task) canonicalIds.push(task.id);
    else unknownIds.push(id);
  }

  if (unknownIds.length > 0) throw new Error(`Unknown task id(s): ${unknownIds.join(", ")}`);
  return [...new Set(canonicalIds)];
}

export function previousBoardSession(
  previousSessionFile: string | undefined,
  currentSessionFile: string | undefined,
  ownerSessions: string[] | undefined,
  executorSessions: string[]
): string | undefined {
  if (!previousSessionFile || !currentSessionFile || !ownerSessions) return undefined;

  const previousIsOwner = ownerSessions.includes(previousSessionFile);
  const currentIsOwner = ownerSessions.includes(currentSessionFile);
  const previousIsExecutor = executorSessions.includes(previousSessionFile);
  const currentIsExecutor = executorSessions.includes(currentSessionFile);

  if (previousIsOwner && currentIsExecutor) return previousSessionFile;
  if (previousIsExecutor && currentIsOwner) return previousSessionFile;
  return undefined;
}
