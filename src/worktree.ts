import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface WorktreeRef {
  worktreePath: string;
  branch: string;
}

export interface MergeResult {
  ok: boolean;
  error?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

/** Commit executor edits so the reviewed branch can be merged into the main tree. */
function commitWorktreeChanges(ref: WorktreeRef): void {
  git(ref.worktreePath, ["add", "-A"]);
  const status = git(ref.worktreePath, ["status", "--porcelain"]);
  if (!status) return;
  git(ref.worktreePath, [
    "-c",
    "user.name=Maestro",
    "-c",
    "user.email=maestro@local",
    "commit",
    "-m",
    `maestro: ${ref.branch}`,
  ]);
}

/** Merge in the main tree. A failed merge is aborted and recovery state is retained. */
export function mergeWorktree(mainCwd: string, ref: WorktreeRef): MergeResult {
  try {
    commitWorktreeChanges(ref);
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

/** Remove managed directories and known branches not represented by a retained task attempt. */
export function sweepWorktrees(
  mainCwd: string,
  retained: WorktreeRef[],
  known: WorktreeRef[] = []
): void {
  const root = resolve(mainCwd, ".pi", "maestro", "worktrees");
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
