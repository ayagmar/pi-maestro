import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { MAX_INJECTED_CONTEXT_LENGTH } from "./prompts.js";
import { type Board, type Task } from "./types.js";

export interface WorktreeRef {
  worktreePath: string;
  branch: string;
}

export interface MergeResult {
  ok: boolean;
  error?: string;
}

export interface GitReadiness {
  ok: boolean;
  summary: string;
}

export type ManagedWorktreeState =
  | "active"
  | "recoverable"
  | "retained-conflict"
  | "orphaned"
  | "stale";

export interface ManagedWorktreeInspection {
  ref: WorktreeRef;
  state: ManagedWorktreeState;
  exists: boolean;
  taskId?: string;
  attemptIndex?: number;
  reason: string;
}

export interface WorktreeCleanupResult {
  confirmed: boolean;
  removed: ManagedWorktreeInspection[];
  preserved: ManagedWorktreeInspection[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function inspectGit(cwd: string): GitReadiness {
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    git(cwd, ["rev-parse", "--verify", "HEAD"]);
    const branch = git(cwd, ["branch", "--show-current"]);
    const status = git(cwd, ["status", "--porcelain"]);
    return {
      ok: true,
      summary: `${root} · ${branch || "detached HEAD"} · ${status ? "working tree has changes" : "clean"}`,
    };
  } catch {
    return {
      ok: false,
      summary:
        "not a git repository with an initial commit; worktrees and automatic commits are unavailable",
    };
  }
}

function safeTaskId(taskId: string): string {
  const safe = taskId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "task";
}

export function worktreeRef(mainCwd: string, taskId: string, attempt: number): WorktreeRef {
  const name = `${safeTaskId(taskId)}-attempt-${attempt}`;
  return {
    worktreePath: resolve(mainCwd, ".pi", "maestro", "worktrees", name),
    branch: `maestro/${name}`,
  };
}

export function createWorktree(mainCwd: string, taskId: string, attempt: number): WorktreeRef {
  const ref = worktreeRef(mainCwd, taskId, attempt);
  git(mainCwd, ["worktree", "add", "-b", ref.branch, ref.worktreePath, "HEAD"]);
  return ref;
}

export function worktreeExists(ref: WorktreeRef): boolean {
  return existsSync(ref.worktreePath);
}

/** Capture a bounded diff. An empty paths list deliberately captures nothing. */
export function captureDiff(cwd: string, paths?: string[]): string {
  if (paths?.length === 0) return "";

  const diff = paths
    ? [git(cwd, ["diff", "--", ...paths]), git(cwd, ["diff", "--cached", "--", ...paths])]
        .filter(Boolean)
        .join("\n")
    : git(cwd, ["diff", "HEAD"]);
  return diff.slice(0, MAX_INJECTED_CONTEXT_LENGTH);
}

/** Commit staged-and-unstaged changes in a tree. Returns false when there was nothing to commit. */
export function commitAll(cwd: string, message: string, paths?: string[]): boolean {
  if (paths && paths.length > 0) git(cwd, ["add", "--", ...paths]);
  else git(cwd, ["add", "-A"]);
  const status = git(cwd, ["status", "--porcelain"]);
  if (!status) return false;
  if (paths && paths.length > 0) {
    // Only commit what this task touched; other tasks' files stay staged-free.
    git(cwd, ["commit", "-m", message, "--", ...paths]);
  } else {
    git(cwd, ["commit", "-m", message]);
  }
  return true;
}

/** Commit executor edits so the reviewed branch can be merged into the main tree. */
function commitWorktreeChanges(ref: WorktreeRef, message?: string): void {
  commitAll(ref.worktreePath, message ?? `maestro: ${ref.branch}`);
}

/** Merge in the main tree. A failed merge is aborted and recovery state is retained. */
export function mergeWorktree(mainCwd: string, ref: WorktreeRef, message?: string): MergeResult {
  try {
    commitWorktreeChanges(ref, message);
    git(mainCwd, ["merge", "--no-edit", ref.branch]);
    return { ok: true };
  } catch (error) {
    try {
      git(mainCwd, ["merge", "--abort"]);
    } catch {
      // A pre-merge failure does not create MERGE_HEAD.
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export function removeWorktree(mainCwd: string, ref: WorktreeRef): void {
  if (existsSync(ref.worktreePath)) {
    git(mainCwd, ["worktree", "remove", "--force", ref.worktreePath]);
  } else {
    git(mainCwd, ["worktree", "prune"]);
  }
  try {
    git(mainCwd, ["branch", "-D", ref.branch]);
  } catch {
    // Already absent is the desired idempotent state.
  }
}

function managedWorktreeRoot(mainCwd: string): string {
  return resolve(mainCwd, ".pi", "maestro", "worktrees");
}

function isManagedPath(root: string, worktreePath: string): boolean {
  return resolve(worktreePath).startsWith(`${root}${sep}`);
}

function hasMergeConflictNotes(task: Task): boolean {
  const notes = task.reviewNotes ?? task.attempts.at(-1)?.reviewNotes;
  return notes !== undefined && /git conflict/i.test(notes);
}

/** Inspect managed worktrees without changing the filesystem or git state. */
export function inspectManagedWorktrees(
  mainCwd: string,
  board: Board,
  liveTaskIds: ReadonlySet<string> = new Set()
): ManagedWorktreeInspection[] {
  const root = managedWorktreeRoot(mainCwd);
  const byPath = new Map<string, ManagedWorktreeInspection>();

  for (const task of board.tasks) {
    const latestAttempt = task.attempts.at(-1);
    for (const attempt of task.attempts) {
      if (!attempt.worktreePath || !attempt.branch) continue;
      const path = resolve(attempt.worktreePath);
      if (!isManagedPath(root, path) || !existsSync(path)) continue;

      const isLatest = attempt === latestAttempt;
      let state: ManagedWorktreeState = "stale";
      let reason = `recorded by settled or superseded attempt ${task.id} #${attempt.index}`;
      if (isLatest && (liveTaskIds.has(task.id) || task.status === "running")) {
        state = "active";
        reason = `${task.id} is running`;
      } else if (isLatest && task.status === "changes_requested" && hasMergeConflictNotes(task)) {
        state = "retained-conflict";
        reason = `${task.id} is retained after a merge conflict`;
      } else if (
        isLatest &&
        (task.status === "ready_for_review" || task.status === "changes_requested")
      ) {
        state = "recoverable";
        reason = `${task.id} can continue from this checkout`;
      }

      const candidate: ManagedWorktreeInspection = {
        ref: { worktreePath: path, branch: attempt.branch },
        state,
        exists: existsSync(path),
        taskId: task.id,
        attemptIndex: attempt.index,
        reason,
      };
      const current = byPath.get(path);
      const priority: Record<ManagedWorktreeState, number> = {
        active: 5,
        "retained-conflict": 4,
        recoverable: 3,
        stale: 2,
        orphaned: 1,
      };
      if (!current || priority[candidate.state] > priority[current.state]) {
        byPath.set(path, candidate);
      }
    }
  }

  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const worktreePath = resolve(root, entry.name);
      if (byPath.has(worktreePath)) continue;
      byPath.set(worktreePath, {
        ref: { worktreePath, branch: `maestro/${entry.name}` },
        state: "orphaned",
        exists: true,
        reason: "managed checkout has no board metadata",
      });
    }
  }

  return [...byPath.values()].sort((left, right) =>
    left.ref.worktreePath.localeCompare(right.ref.worktreePath)
  );
}

/**
 * Remove only confirmed stale/orphaned entries. The board and live-run state are
 * read again immediately before each removal so a newly active or recoverable
 * checkout is never removed from a stale diagnostic snapshot.
 */
export function cleanupManagedWorktrees(
  mainCwd: string,
  confirmed: boolean,
  loadCurrentBoard: () => Board,
  isTaskLive: (taskId: string) => boolean
): WorktreeCleanupResult {
  const initial = inspectManagedWorktrees(mainCwd, loadCurrentBoard());
  if (!confirmed) return { confirmed: false, removed: [], preserved: initial };

  const removed: ManagedWorktreeInspection[] = [];
  const preserved: ManagedWorktreeInspection[] = [];
  for (const entry of initial) {
    if (entry.state !== "orphaned" && entry.state !== "stale") {
      preserved.push(entry);
      continue;
    }

    const board = loadCurrentBoard();
    const liveIds = new Set(
      board.tasks.filter((task) => isTaskLive(task.id)).map((task) => task.id)
    );
    const current = inspectManagedWorktrees(mainCwd, board, liveIds).find(
      (candidate) => candidate.ref.worktreePath === entry.ref.worktreePath
    );
    if (!current || (current.state !== "orphaned" && current.state !== "stale")) {
      if (current) preserved.push(current);
      continue;
    }

    removeWorktree(mainCwd, current.ref);
    removed.push(current);
  }
  return { confirmed: true, removed, preserved };
}

/** Remove managed directories and known branches not represented by a retained task attempt. */
export function sweepWorktrees(
  mainCwd: string,
  retained: WorktreeRef[],
  known: WorktreeRef[] = []
): void {
  const root = managedWorktreeRoot(mainCwd);
  const retainedPaths = new Set(retained.map((ref) => resolve(ref.worktreePath)));

  for (const ref of known) {
    const path = resolve(ref.worktreePath);
    if (!path.startsWith(`${root}${sep}`) || retainedPaths.has(path)) continue;
    removeWorktree(mainCwd, ref);
  }

  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const worktreePath = join(root, entry.name);
    if (retainedPaths.has(resolve(worktreePath))) continue;
    removeWorktree(mainCwd, { worktreePath, branch: `maestro/${entry.name}` });
  }
  git(mainCwd, ["worktree", "prune"]);
}
