import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
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

function gitOutput(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
  });
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return gitOutput(cwd, args, env).trim();
}

export function headCommit(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]);
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

/** Git-authoritative changed paths for one checkout, including staged, unstaged, and untracked files. */
export function changedPaths(cwd: string): string[] {
  const output = gitOutput(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!output) return [];

  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    paths.push(path);
    if ((status.includes("R") || status.includes("C")) && entries[index + 1]) index += 1;
  }
  return [...new Set(paths.map((path) => path.replaceAll("\\", "/")))].sort();
}

/**
 * Snapshot task paths into an immutable Git tree without touching the checkout index.
 * The tree includes HEAD plus exactly the supplied staged, unstaged, deleted, and untracked paths.
 */
export function snapshotArtifact(cwd: string, paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;

  const directory = mkdtempSync(join(tmpdir(), "maestro-index-"));
  const indexFile = join(directory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    git(cwd, ["read-tree", "HEAD"], env);
    git(cwd, ["add", "-A", "--", ...paths], env);
    return git(cwd, ["write-tree"], env);
  } catch {
    return undefined;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function commitTree(cwd: string, commit: string): string {
  return git(cwd, ["rev-parse", `${commit}^{tree}`]);
}

export function artifactMatchesCommit(
  cwd: string,
  candidateTree: string,
  commit: string,
  paths: string[]
): boolean {
  if (paths.length === 0) return false;
  try {
    git(cwd, ["diff", "--quiet", candidateTree, commit, "--", ...paths]);
    return true;
  } catch {
    return false;
  }
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
  if (paths?.length === 0) return false;
  if (paths) git(cwd, ["add", "--", ...paths]);
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

/** An orphaned checkout with uncommitted changes or branch-only commits still holds recoverable work. */
function orphanHasRecoverableWork(mainCwd: string, worktreePath: string, branch: string): boolean {
  try {
    if (git(worktreePath, ["status", "--porcelain"])) return true;
  } catch {
    // Not a live worktree checkout; fall back to inspecting the branch.
  }
  try {
    const uniqueCommits = git(mainCwd, ["rev-list", "--count", branch, "--not", "HEAD"]);
    return uniqueCommits !== "" && uniqueCommits !== "0";
  } catch {
    return false;
  }
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
      if (!isManagedPath(root, path)) continue;
      const exists = existsSync(path);

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

      if (
        !exists &&
        (state === "active" || state === "recoverable" || state === "retained-conflict")
      ) {
        reason = `${reason}; checkout is missing and cannot be recovered here`;
      } else if (!exists) {
        reason = `${reason}; checkout is missing, only the branch/registration remains`;
      }

      const candidate: ManagedWorktreeInspection = {
        ref: { worktreePath: path, branch: attempt.branch },
        state,
        exists,
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
      const branch = `maestro/${entry.name}`;
      const recoverable = orphanHasRecoverableWork(mainCwd, worktreePath, branch);
      byPath.set(worktreePath, {
        ref: { worktreePath, branch },
        state: recoverable ? "recoverable" : "orphaned",
        exists: true,
        reason: recoverable
          ? "managed checkout has no board metadata but holds uncommitted or branch-only work"
          : "managed checkout has no board metadata",
      });
    }
  }

  return [...byPath.values()].sort((left, right) =>
    left.ref.worktreePath.localeCompare(right.ref.worktreePath)
  );
}

/**
 * Remove only the paths the caller explicitly confirmed. The board and live-run
 * state are read again immediately before each removal so a checkout that became
 * active or recoverable while the user was confirming is preserved, and a path
 * that appeared after confirmation is never touched because it was not confirmed.
 */
export function cleanupManagedWorktrees(
  mainCwd: string,
  confirmedPaths: ReadonlySet<string>,
  loadCurrentBoard: () => Board,
  isTaskLive: (taskId: string) => boolean
): WorktreeCleanupResult {
  if (confirmedPaths.size === 0) return { confirmed: false, removed: [], preserved: [] };

  const removed: ManagedWorktreeInspection[] = [];
  const preserved: ManagedWorktreeInspection[] = [];
  for (const worktreePath of confirmedPaths) {
    const board = loadCurrentBoard();
    const liveIds = new Set(
      board.tasks.filter((task) => isTaskLive(task.id)).map((task) => task.id)
    );
    const current = inspectManagedWorktrees(mainCwd, board, liveIds).find(
      (candidate) => candidate.ref.worktreePath === resolve(worktreePath)
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
    if (orphanHasRecoverableWork(mainCwd, path, ref.branch)) continue;
    removeWorktree(mainCwd, ref);
  }

  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const worktreePath = join(root, entry.name);
    if (retainedPaths.has(resolve(worktreePath))) continue;
    const ref = { worktreePath, branch: `maestro/${entry.name}` };
    if (orphanHasRecoverableWork(mainCwd, ref.worktreePath, ref.branch)) continue;
    removeWorktree(mainCwd, ref);
  }
  git(mainCwd, ["worktree", "prune"]);
}
