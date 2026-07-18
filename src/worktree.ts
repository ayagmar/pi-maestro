import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { STATE_DIR } from "./constants.js";
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

export interface MainTreeIdentity {
  head: string;
  indexTree: string;
  porcelainHash: string;
  worktreeTree: string;
}

export interface PreparedIntegration {
  baseCommit: string;
  integratedCommit: string;
  integratedTree: string;
  mainIdentity: MainTreeIdentity;
  tempRef: WorktreeRef;
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

export interface WorktreeParkingResult {
  parked: WorktreeRef[];
  removed: WorktreeRef[];
  warnings: string[];
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
  const base = worktreeRef(mainCwd, taskId, attempt);
  let ref = base;
  let suffix = 2;

  while (existsSync(ref.worktreePath) || git(mainCwd, ["branch", "--list", ref.branch])) {
    ref = {
      worktreePath: `${base.worktreePath}-${suffix}`,
      branch: `${base.branch}-${suffix}`,
    };
    suffix += 1;
  }

  git(mainCwd, ["worktree", "add", "-b", ref.branch, ref.worktreePath, "HEAD"]);
  return ref;
}

export function worktreeExists(ref: WorktreeRef): boolean {
  return existsSync(ref.worktreePath);
}

export function worktreeRecoveryExists(mainCwd: string, ref: WorktreeRef): boolean {
  return worktreeExists(ref) || branchExists(mainCwd, ref.branch);
}

function branchExists(mainCwd: string, branch: string): boolean {
  return git(mainCwd, ["branch", "--list", branch]) !== "";
}

function registeredBranch(mainCwd: string, worktreePath: string): string | undefined {
  try {
    const target = resolve(worktreePath);
    let currentPath: string | undefined;
    for (const line of gitOutput(mainCwd, ["worktree", "list", "--porcelain"]).split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = resolve(line.slice("worktree ".length));
      } else if (currentPath === target && line.startsWith("branch refs/heads/")) {
        return line.slice("branch refs/heads/".length);
      }
    }
  } catch {
    // An unregistered or non-Git path has no authoritative branch mapping.
  }
  return undefined;
}

/** Restore a parked task checkout from its durable Maestro branch. */
export function restoreWorktree(mainCwd: string, ref: WorktreeRef): WorktreeRef {
  if (worktreeExists(ref)) return ref;
  if (!branchExists(mainCwd, ref.branch)) {
    throw new Error(`Recovery branch is missing: ${ref.branch}`);
  }

  git(mainCwd, ["worktree", "prune"]);
  mkdirSync(dirname(ref.worktreePath), { recursive: true });
  git(mainCwd, ["worktree", "add", ref.worktreePath, ref.branch]);
  return ref;
}

function changedPathsFromPorcelain(output: string): string[] {
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

/** Git-authoritative changed paths for one checkout, including staged, unstaged, and untracked files. */
export function changedPaths(cwd: string): string[] {
  const output = gitOutput(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return changedPathsFromPorcelain(output);
}

export interface ChangeBaseline {
  /** Immutable tree of HEAD plus every path dirty when the baseline was captured. */
  tree: string;
  paths: string[];
}

/** Maestro's own runtime state must never be attributed to an executor. */
function isMaestroStatePath(path: string): boolean {
  return (
    path === ".pi/maestro.json" ||
    path.startsWith(`${STATE_DIR}/`) ||
    path.startsWith(".pi/maestro-recipes/")
  );
}

/**
 * Capture a Git-authoritative snapshot of the checkout before an executor
 * runs directly in it, so its changes can later be attributed by content
 * instead of trusting tool-call reporting (which misses bash mutations).
 */
export function captureChangeBaseline(cwd: string): ChangeBaseline | undefined {
  try {
    const paths = changedPaths(cwd).filter((path) => !isMaestroStatePath(path));
    const tree = paths.length === 0 ? commitTree(cwd, "HEAD") : snapshotArtifact(cwd, paths);
    return tree ? { tree, paths } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Paths whose content differs from the baseline snapshot: files created,
 * modified, deleted, or reverted by whatever ran since the baseline,
 * regardless of which tool performed the mutation.
 */
export function changedPathsSinceBaseline(
  cwd: string,
  baseline: ChangeBaseline
): string[] | undefined {
  try {
    const current = changedPaths(cwd).filter((path) => !isMaestroStatePath(path));
    const paths = [...new Set([...baseline.paths, ...current])];
    const tree = paths.length === 0 ? commitTree(cwd, "HEAD") : snapshotArtifact(cwd, paths);
    if (!tree) return undefined;
    const output = gitOutput(cwd, ["diff", "--name-only", "-z", baseline.tree, tree]);
    return [
      ...new Set(
        output
          .split("\0")
          .filter(Boolean)
          .map((path) => path.replaceAll("\\", "/"))
          .filter((path) => !isMaestroStatePath(path))
      ),
    ].sort();
  } catch {
    return undefined;
  }
}

/** Exact Git-visible main-tree identity used to fail closed before promotion. */
function captureMainTreeIdentity(cwd: string, env?: NodeJS.ProcessEnv): MainTreeIdentity {
  const porcelain = gitOutput(
    cwd,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
      // Maestro's own runtime state, project config, and recipes are not
      // reviewed artifacts; editing them mid-review must not fail promotion
      // with a spurious "main checkout changed".
      `:(exclude)${STATE_DIR}/**`,
      ":(exclude).pi/maestro.json",
      ":(exclude).pi/maestro-recipes/**",
    ],
    env
  );
  const paths = changedPathsFromPorcelain(porcelain);
  const worktreeTree = paths.length === 0 ? commitTree(cwd, "HEAD") : snapshotArtifact(cwd, paths);
  if (!worktreeTree) throw new Error("could not snapshot the main checkout worktree");
  return {
    head: headCommit(cwd),
    indexTree: git(cwd, ["write-tree"], env),
    porcelainHash: createHash("sha256").update(porcelain).digest("hex"),
    worktreeTree,
  };
}

export function mainTreeIdentity(cwd: string): MainTreeIdentity {
  return captureMainTreeIdentity(cwd);
}

export function mainTreeIdentityMatches(cwd: string, expected: MainTreeIdentity): boolean {
  try {
    return JSON.stringify(mainTreeIdentity(cwd)) === JSON.stringify(expected);
  } catch {
    return false;
  }
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
  if (paths) {
    git(cwd, ["add", "--", ...paths]);
    try {
      git(cwd, ["diff", "--cached", "--quiet", "--", ...paths]);
      return false;
    } catch {
      // At least one task-scoped path is staged; unrelated staged files are ignored.
    }
    // Only commit what this task touched; unrelated files remain untouched.
    git(cwd, ["commit", "-m", message, "--", ...paths]);
    return true;
  }
  git(cwd, ["add", "-A"]);
  try {
    git(cwd, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    git(cwd, ["commit", "-m", message]);
    return true;
  }
}

/** Commit executor edits so the reviewed branch can be merged into the main tree. */
function commitWorktreeChanges(ref: WorktreeRef, message?: string): void {
  commitAll(ref.worktreePath, message ?? `maestro: ${ref.branch}`);
}

function integrationWorktreeRef(): WorktreeRef {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const worktreePath = mkdtempSync(join(tmpdir(), "maestro-integration-"));
  rmSync(worktreePath, { recursive: true });
  return {
    worktreePath,
    branch: `maestro-integration/${nonce}`,
  };
}

/** Prepare a reviewed main-tree snapshot as an immutable commit in an isolated checkout. */
export function prepareMainTreeIntegration(
  mainCwd: string,
  candidateTree: string,
  message: string
): PreparedIntegration {
  const mainIdentity = mainTreeIdentity(mainCwd);
  const baseCommit = mainIdentity.head;
  const integratedCommit = git(mainCwd, [
    "commit-tree",
    candidateTree,
    "-p",
    baseCommit,
    "-m",
    message,
  ]);
  const tempRef = integrationWorktreeRef();
  try {
    git(mainCwd, ["worktree", "add", "-b", tempRef.branch, tempRef.worktreePath, integratedCommit]);
    return {
      baseCommit,
      integratedCommit,
      integratedTree: candidateTree,
      mainIdentity,
      tempRef,
    };
  } catch (error) {
    removeWorktree(mainCwd, tempRef);
    throw error;
  }
}

/** Prepare a reviewed task merge away from the integration checkout. */
export function prepareWorktreeIntegration(
  mainCwd: string,
  taskRef: WorktreeRef,
  message?: string
): PreparedIntegration {
  commitWorktreeChanges(taskRef, message);
  const mainIdentity = mainTreeIdentity(mainCwd);
  const baseCommit = mainIdentity.head;
  const tempRef = integrationWorktreeRef();
  try {
    git(mainCwd, ["worktree", "add", "-b", tempRef.branch, tempRef.worktreePath, baseCommit]);
    git(tempRef.worktreePath, ["merge", "--no-edit", taskRef.branch]);
    if (changedPaths(tempRef.worktreePath).length > 0) {
      throw new Error("prepared integration checkout is not Git-clean");
    }
    const integratedCommit = headCommit(tempRef.worktreePath);
    return {
      baseCommit,
      integratedCommit,
      integratedTree: commitTree(tempRef.worktreePath, integratedCommit),
      mainIdentity,
      tempRef,
    };
  } catch (error) {
    removeWorktree(mainCwd, tempRef);
    throw error;
  }
}

/**
 * Prepare task-scoped index entries under Git's index lock, then advance HEAD
 * with compare-and-swap and atomically install that index. The working files
 * are never overwritten, so later mutations remain visible as recovery edits.
 */
export function promotePreparedMainTreeIntegration(
  mainCwd: string,
  prepared: PreparedIntegration,
  paths: string[]
): MergeResult {
  if (paths.length === 0) return { ok: false, error: "main-tree promotion has no task paths" };

  const indexFile = resolve(mainCwd, git(mainCwd, ["rev-parse", "--git-path", "index"]));
  const indexLock = `${indexFile}.lock`;
  try {
    closeSync(openSync(indexLock, "wx"));
  } catch {
    return {
      ok: false,
      error: "main checkout index is locked; retry after the other Git operation finishes",
    };
  }

  let ownsIndexLock = true;
  try {
    copyFileSync(indexFile, indexLock);
    const preparedIndexEnv = {
      ...process.env,
      GIT_INDEX_FILE: indexLock,
      GIT_OPTIONAL_LOCKS: "0",
    };
    const currentIdentity = captureMainTreeIdentity(mainCwd, preparedIndexEnv);
    if (JSON.stringify(currentIdentity) !== JSON.stringify(prepared.mainIdentity)) {
      return { ok: false, error: "main checkout changed after snapshot preparation" };
    }

    git(mainCwd, ["reset", "--quiet", prepared.integratedCommit, "--", ...paths], preparedIndexEnv);
    git(mainCwd, ["update-ref", "HEAD", prepared.integratedCommit, prepared.baseCommit]);
    try {
      renameSync(indexLock, indexFile);
      ownsIndexLock = false;
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        git(mainCwd, ["update-ref", "HEAD", prepared.baseCommit, prepared.integratedCommit]);
        return { ok: false, error: `${message}; HEAD was restored` };
      } catch (rollbackError) {
        return {
          ok: false,
          error: `${message}; HEAD contains the reviewed commit but index installation failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (ownsIndexLock) rmSync(indexLock, { force: true });
  }
}

/** Promote only the prepared descendant after proving the main checkout did not move. */
export function promotePreparedIntegration(
  mainCwd: string,
  prepared: PreparedIntegration
): MergeResult {
  if (!mainTreeIdentityMatches(mainCwd, prepared.mainIdentity)) {
    return { ok: false, error: "main checkout changed after integration preparation" };
  }
  try {
    git(mainCwd, ["merge-base", "--is-ancestor", prepared.baseCommit, prepared.integratedCommit]);
    git(mainCwd, ["merge", "--ff-only", prepared.integratedCommit]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function removePreparedIntegration(mainCwd: string, prepared: PreparedIntegration): void {
  removeWorktree(mainCwd, prepared.tempRef);
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
  const branch = registeredBranch(mainCwd, ref.worktreePath) ?? ref.branch;
  if (existsSync(ref.worktreePath)) {
    git(mainCwd, ["worktree", "remove", "--force", ref.worktreePath]);
  } else {
    git(mainCwd, ["worktree", "prune"]);
  }
  try {
    git(mainCwd, ["branch", "-D", branch]);
  } catch {
    // Already absent is the desired idempotent state.
  }
}

/**
 * Checkpoint recoverable edits on the task branch and remove the physical checkout.
 * Branches with no work beyond main are removed as well.
 */
export function parkWorktree(mainCwd: string, ref: WorktreeRef): "parked" | "removed" | "absent" {
  if (!worktreeExists(ref)) {
    git(mainCwd, ["worktree", "prune"]);
    return "absent";
  }

  const branch = registeredBranch(mainCwd, ref.worktreePath) ?? ref.branch;
  const effectiveRef = { ...ref, branch };
  if (changedPaths(ref.worktreePath).length > 0) {
    commitAll(ref.worktreePath, `chore(maestro): checkpoint ${branch}`);
  }
  git(mainCwd, ["worktree", "remove", "--force", ref.worktreePath]);
  git(mainCwd, ["worktree", "prune"]);

  if (orphanHasRecoverableWork(mainCwd, effectiveRef.worktreePath, branch)) return "parked";
  try {
    git(mainCwd, ["branch", "-D", branch]);
  } catch {
    // An already absent branch is fully cleaned.
  }
  return "removed";
}

export function removeUnreferencedCleanWorktree(
  mainCwd: string,
  board: Board,
  ref: WorktreeRef
): boolean {
  const referenced = board.tasks.some((task) =>
    task.attempts.some(
      (attempt) => attempt.worktreePath === ref.worktreePath || attempt.branch === ref.branch
    )
  );
  if (referenced || !worktreeExists(ref) || changedPaths(ref.worktreePath).length > 0) return false;
  removeWorktree(mainCwd, ref);
  return true;
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

      if (!exists && branchExists(mainCwd, attempt.branch)) {
        reason = `${reason}; checkout is parked on ${attempt.branch}`;
      } else if (
        !exists &&
        (state === "active" || state === "recoverable" || state === "retained-conflict")
      ) {
        reason = `${reason}; checkout is missing and recovery branch is missing`;
      } else if (!exists) {
        reason = `${reason}; checkout is missing, only stale metadata remains`;
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
      const branch = registeredBranch(mainCwd, worktreePath) ?? `maestro/${entry.name}`;
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

  let parkedBranches: string[] = [];
  try {
    parkedBranches = git(mainCwd, ["branch", "--list", "maestro/*"])
      .split("\n")
      .map((line) => line.replace(/^[+* ]+/, "").trim())
      .filter(Boolean);
  } catch {
    // A non-Git project cannot have managed task branches.
  }
  for (const branch of parkedBranches) {
    const worktreePath = resolve(root, branch.slice("maestro/".length));
    if (byPath.has(worktreePath)) continue;
    const recoverable = orphanHasRecoverableWork(mainCwd, worktreePath, branch);
    byPath.set(worktreePath, {
      ref: { worktreePath, branch },
      state: recoverable ? "recoverable" : "orphaned",
      exists: false,
      reason: recoverable
        ? "parked recovery branch has no live board metadata"
        : "parked branch has no live board metadata or unique work",
    });
  }

  return [...byPath.values()].sort((left, right) =>
    left.ref.worktreePath.localeCompare(right.ref.worktreePath)
  );
}

/** Park every non-live managed checkout while retaining recoverable work on its branch. */
export function parkInactiveWorktrees(
  mainCwd: string,
  board: Board,
  liveTaskIds: ReadonlySet<string> = new Set()
): WorktreeParkingResult {
  const parked: WorktreeRef[] = [];
  const removed: WorktreeRef[] = [];
  const warnings: string[] = [];

  for (const entry of inspectManagedWorktrees(mainCwd, board, liveTaskIds)) {
    if (entry.state === "active" || !entry.exists) continue;
    try {
      const result = parkWorktree(mainCwd, entry.ref);
      if (result === "parked") parked.push(entry.ref);
      if (result === "removed") removed.push(entry.ref);
    } catch (error) {
      warnings.push(
        `${entry.ref.worktreePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { parked, removed, warnings };
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
    const ref = {
      worktreePath,
      branch: registeredBranch(mainCwd, worktreePath) ?? `maestro/${entry.name}`,
    };
    if (orphanHasRecoverableWork(mainCwd, ref.worktreePath, ref.branch)) continue;
    removeWorktree(mainCwd, ref);
  }
  git(mainCwd, ["worktree", "prune"]);
}
