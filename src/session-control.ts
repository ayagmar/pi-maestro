import { sep } from "node:path";
import { findTask } from "./board.js";
import { type Board } from "./types.js";

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
