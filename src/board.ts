import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { completionFreshness } from "./artifact-policy.js";
import { STATE_DIR } from "./constants.js";
import {
  type Attempt,
  type Board,
  type FailureKind,
  type MaestroConfig,
  type PlanTaskEdits,
  type PlanValidation,
  type RecipeScope,
  type Task,
  type TaskGroup,
  type TaskStatus,
} from "./types.js";

export const BOARD_FILE = "board.json";
const HISTORY_FILE = "history.jsonl";
const RECIPE_DIRECTORY = "maestro-recipes";
const BOARD_LOCK_STALE_MS = 30_000;
let quarantineNotice: string | undefined;
const BOARD_LOCK_RETRIES = 500;
export const DISPATCH_LEASE_MS = 30_000;

interface BoardLock {
  fd: number;
  file: string;
  token: string;
}

export interface StatusHistoryEntry {
  ts: string;
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  revision: number;
}

const EMPTY_BOARD: Board = { version: 1, nextTaskNumber: 1, tasks: [] };

export function stateDir(cwd: string): string {
  return join(cwd, STATE_DIR);
}

function boardFile(cwd: string): string {
  return join(stateDir(cwd), BOARD_FILE);
}

export interface StoredRecipeFile {
  name: string;
  scope: RecipeScope;
  file: string;
  text: string;
}

export function recipeDirectory(scope: RecipeScope, cwd: string, userDirectory?: string): string {
  if (scope === "user") {
    if (!userDirectory) throw new Error("User recipe storage requires an agent directory.");
    return join(userDirectory, RECIPE_DIRECTORY);
  }
  return join(cwd, ".pi", RECIPE_DIRECTORY);
}

export function listStoredRecipeFiles(
  scope: RecipeScope,
  cwd: string,
  userDirectory?: string
): StoredRecipeFile[] {
  const directory = recipeDirectory(scope, cwd, userDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      name: name.slice(0, -".json".length),
      scope,
      file: join(directory, name),
      text: readFileSync(join(directory, name), "utf-8"),
    }));
}

export function saveStoredRecipe(
  scope: RecipeScope,
  cwd: string,
  name: string,
  text: string,
  userDirectory?: string
): string {
  assertRecipeName(name);
  const directory = recipeDirectory(scope, cwd, userDirectory);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${name}.json`);
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(temporary, text, "utf-8");
  renameSync(temporary, file);
  return file;
}

export function removeStoredRecipe(
  scope: RecipeScope,
  cwd: string,
  name: string,
  userDirectory?: string
): boolean {
  assertRecipeName(name);
  const file = join(recipeDirectory(scope, cwd, userDirectory), `${name}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

function assertRecipeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(
      "Recipe names must contain 1-64 letters, numbers, dots, dashes, or underscores."
    );
  }
}

export function inspectBoardStorage(cwd: string): { boardBytes: number; archiveCount: number } {
  const file = boardFile(cwd);
  const archiveDirectory = join(stateDir(cwd), "archive");
  return {
    boardBytes: existsSync(file) ? statSync(file).size : 0,
    archiveCount: existsSync(archiveDirectory)
      ? readdirSync(archiveDirectory).filter((name) => name.endsWith("-board.json")).length
      : 0,
  };
}

interface BoardCacheEntry {
  identity: string;
  board: Board;
}

const boardCache = new Map<string, BoardCacheEntry>();

/** Exact file identity (inode + size + mtime ns) so a cached parse can never go stale silently. */
function fileIdentity(file: string): string | undefined {
  try {
    const stat = statSync(file, { bigint: true });
    return `${stat.ino}-${stat.size}-${stat.mtimeNs}`;
  } catch {
    return undefined;
  }
}

export function loadBoard(cwd: string): Board {
  const file = boardFile(cwd);
  const identity = fileIdentity(file);
  if (identity === undefined) {
    boardCache.delete(file);
    return structuredClone(EMPTY_BOARD);
  }
  const cached = boardCache.get(file);
  if (cached && cached.identity === identity) return structuredClone(cached.board);
  const contents = readFileSync(file, "utf-8");
  try {
    const value: unknown = JSON.parse(contents);
    if (!isBoard(value)) throw new Error("board has an invalid structure");
    // Re-stat after the read: cache only when the identity did not move mid-read.
    if (fileIdentity(file) === identity) {
      boardCache.set(file, { identity, board: structuredClone(value) });
    }
    return value;
  } catch {
    boardCache.delete(file);
    quarantineNotice = quarantineCorruptBoard(file);
    return structuredClone(EMPTY_BOARD);
  }
}

export function listCorruptBoardFiles(cwd: string): string[] {
  const directory = stateDir(cwd);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.startsWith(`${BOARD_FILE}.corrupt-`));
}

export function consumeQuarantineNotice(): string | undefined {
  const notice = quarantineNotice;
  quarantineNotice = undefined;
  return notice;
}

export function restoreQuarantineNotice(path: string): void {
  quarantineNotice = path;
}

export function saveBoard(cwd: string, board: Board): void {
  const lock = acquireBoardLock(cwd);
  try {
    saveBoardUnlocked(cwd, board);
  } finally {
    releaseBoardLock(lock);
  }
}

/**
 * Load-modify-save fresh board state while holding the board lock.
 * A thrown mutation or literal false result is never persisted.
 */
export function updateBoard<T>(cwd: string, mutate: (board: Board) => T): T {
  const lock = acquireBoardLock(cwd);
  try {
    const board = loadBoard(cwd);
    const result = mutate(board);
    if (result !== false) saveBoardUnlocked(cwd, board);
    return result;
  } finally {
    releaseBoardLock(lock);
  }
}

export function replaceBoard(cwd: string, board: Board, expectedRevision: number): void {
  const lock = acquireBoardLock(cwd);
  try {
    const currentRevision = loadBoard(cwd).revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new Error("Cannot replace a stale maestro board; reload it before replacing");
    }
    board.revision = currentRevision;
    saveBoardUnlocked(cwd, board);
  } finally {
    releaseBoardLock(lock);
  }
}

export function replaceBoardWithArchive(
  cwd: string,
  replacement: (current: Board) => Board,
  expectedRevision: number
): string | undefined {
  const lock = acquireBoardLock(cwd);
  try {
    const current = loadBoard(cwd);
    if ((current.revision ?? 0) !== expectedRevision) {
      throw new Error(
        "Cannot replace a stale maestro board; inspect the latest board and confirm again"
      );
    }
    const next = replacement(current);
    const archive = archiveBoard(cwd);
    if (current.revision === undefined) delete next.revision;
    else next.revision = current.revision;
    saveBoardUnlocked(cwd, next);
    return archive;
  } finally {
    releaseBoardLock(lock);
  }
}

function saveBoardUnlocked(cwd: string, board: Board): void {
  const dir = stateDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // Runtime state (board, logs) has no place in version control.
    writeFileSync(join(dir, ".gitignore"), "*\n", "utf-8");
  }
  board.revision = (board.revision ?? 0) + 1;
  const file = boardFile(cwd);
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf-8");
  renameSync(tmp, file);
  const identity = fileIdentity(file);
  if (identity) boardCache.set(file, { identity, board: structuredClone(board) });
  else boardCache.delete(file);
}

/**
 * Kernel-reported process start identity, so a recycled PID cannot masquerade
 * as a live lock owner. Linux-only; other platforms return undefined and keep
 * the conservative liveness-only check.
 */
function processStartId(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = stat.slice(closeParen + 2).split(" ");
    // Field 22 (starttime) is index 19 after the (pid, comm) prefix.
    const startTicks = fields[19];
    return startTicks && /^\d+$/.test(startTicks) ? startTicks : undefined;
  } catch {
    return undefined;
  }
}

function acquireBoardLock(cwd: string): BoardLock {
  const dir = stateDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "board.lock");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let tries = 0; tries < BOARD_LOCK_RETRIES; tries += 1) {
    try {
      const fd = openSync(file, "wx");
      const start = processStartId(process.pid);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, ...(start ? { start } : {}) }));
      return { fd, file, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const staleOwner = staleLockOwner(file);
      if (staleOwner && reclaimStaleLock(file, staleOwner)) continue;
      // Board critical sections are read-modify-write of one JSON file and
      // complete in single-digit milliseconds. Spin briefly at fine
      // granularity so typical contention resolves in ≤1ms of blocking,
      // then back off to 10ms slices for the pathological long-hold case.
      const waitMs = tries < 20 ? 1 : 10;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  throw new Error("Timed out waiting for maestro board lock");
}

interface StaleLockOwner {
  identity: string;
}

function staleLockOwner(file: string): StaleLockOwner | undefined {
  try {
    const stat = statSync(file);
    if (Date.now() - stat.mtimeMs <= BOARD_LOCK_STALE_MS) return undefined;
    const contents = readFileSync(file, "utf-8");
    const owner = JSON.parse(contents) as { pid?: unknown; token?: unknown; start?: unknown };
    if (typeof owner.pid === "number") {
      const currentStart = processStartId(owner.pid);
      const recordedStart = typeof owner.start === "string" ? owner.start : undefined;
      const pidRecycled =
        recordedStart !== undefined && currentStart !== undefined && recordedStart !== currentStart;
      if (!pidRecycled) {
        try {
          process.kill(owner.pid, 0);
          return undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined;
        }
      }
    }
    const token = typeof owner.token === "string" ? owner.token : "invalid";
    return { identity: `${stat.dev}-${stat.ino}-${token}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    // Old malformed lock files are reclaimable, but their inode still provides
    // the identity used by the ownership-safe hard-link protocol below.
    const stat = statSync(file);
    return { identity: `${stat.dev}-${stat.ino}-invalid` };
  }
}

function reclaimStaleLock(file: string, owner: StaleLockOwner): boolean {
  const claimed = `${file}.stale-${owner.identity}`;
  try {
    // linkSync is the ownership claim: exactly one contender can create this
    // name. Losers never unlink board.lock and therefore cannot remove the
    // winner's newly acquired lock.
    linkSync(file, claimed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw error;
  }

  let reclaimed = false;
  try {
    const current = statSync(file);
    const stale = statSync(claimed);
    if (current.dev === stale.dev && current.ino === stale.ino) {
      unlinkSync(file);
      reclaimed = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    unlinkSync(claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return reclaimed;
}

function releaseBoardLock(lock: BoardLock): void {
  closeSync(lock.fd);
  try {
    const owner = JSON.parse(readFileSync(lock.file, "utf-8")) as { token?: unknown };
    if (owner.token === lock.token) unlinkSync(lock.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function recordStatusChange(
  cwd: string,
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
  revision: number
): void {
  const dir = stateDir(cwd);
  mkdirSync(dir, { recursive: true });
  const record = { ts: new Date().toISOString(), taskId, from, to, revision };
  appendFileSync(join(dir, HISTORY_FILE), `${JSON.stringify(record)}\n`, "utf-8");
}

export function archiveBoard(cwd: string): string | undefined {
  const file = boardFile(cwd);
  if (!existsSync(file)) return undefined;

  const archiveDir = join(stateDir(cwd), "archive");
  mkdirSync(archiveDir, { recursive: true });
  const timestamp = new Date().toISOString();
  let archive = join(archiveDir, `${timestamp}-board.json`);
  let suffix = 1;
  while (existsSync(archive)) {
    archive = join(archiveDir, `${timestamp}-${suffix}-board.json`);
    suffix += 1;
  }
  copyFileSync(file, archive);
  return archive;
}

export interface ArchivedBoard {
  file: string;
  timestamp: string;
  taskCount: number;
}

function archiveSortKey(name: string): { iso: string; suffix: number } {
  const isoEnd = name.indexOf("Z");
  const iso = isoEnd < 0 ? name : name.slice(0, isoEnd + 1);
  const match = name.slice(iso.length).match(/^-(\d+)-board\.json$/);
  return { iso, suffix: match ? Number(match[1]) : 0 };
}

export function latestArchiveFile(cwd: string): { file: string; timestamp: string } | undefined {
  const directory = join(stateDir(cwd), "archive");
  if (!existsSync(directory)) return undefined;
  // Sorting by name (not file contents) keeps this a cheap display hint; a
  // corrupt-but-newer archive can still outrank an older valid one.
  const name = readdirSync(directory)
    .filter((candidate) => candidate.endsWith("-board.json"))
    .sort((left, right) => {
      const a = archiveSortKey(left);
      const b = archiveSortKey(right);
      if (a.iso !== b.iso) return b.iso.localeCompare(a.iso);
      return b.suffix - a.suffix;
    })[0];
  if (!name) return undefined;
  const isoEnd = name.indexOf("Z");
  if (isoEnd < 0) return undefined;
  return { file: join(directory, name), timestamp: name.slice(0, isoEnd + 1) };
}

export function loadArchivedBoard(cwd: string, selectedFile: string): Board {
  const archiveDirectory = resolve(stateDir(cwd), "archive");
  const file = resolve(
    isAbsolute(selectedFile) ? selectedFile : join(archiveDirectory, selectedFile)
  );
  if (dirname(file) !== archiveDirectory) {
    throw new Error(`Archive file must be in ${archiveDirectory}`);
  }
  const board = readArchivedBoard(file);
  if (!board) throw new Error(`Archive is missing or invalid: ${file}`);
  return board;
}

export function listArchivedBoards(cwd: string): ArchivedBoard[] {
  const directory = join(stateDir(cwd), "archive");
  if (!existsSync(directory)) return [];

  return readdirSync(directory)
    .filter((name) => name.endsWith("-board.json"))
    .sort((left, right) => right.localeCompare(left))
    .flatMap((name) => {
      const file = join(directory, name);
      const board = readArchivedBoard(file);
      if (!board) return [];
      return [
        { file, timestamp: name.slice(0, -"-board.json".length), taskCount: board.tasks.length },
      ];
    });
}

export function restoreArchivedBoard(
  cwd: string,
  selectedFile: string,
  expectedRevision: number
): { archivedCurrent: string | undefined; selectedFile: string } {
  const archiveDirectory = resolve(stateDir(cwd), "archive");
  const file = resolve(
    isAbsolute(selectedFile) ? selectedFile : join(archiveDirectory, selectedFile)
  );
  if (dirname(file) !== archiveDirectory) {
    throw new Error(`Archive file must be in ${archiveDirectory}`);
  }
  if (!existsSync(file)) throw new Error(`Archive file not found: ${file}`);

  const board = readArchivedBoard(file);
  if (!board) throw new Error(`Archive is not a valid maestro board: ${file}`);

  const archivedCurrent = replaceBoardWithArchive(
    cwd,
    () => structuredClone(board),
    expectedRevision
  );
  return { archivedCurrent, selectedFile: file };
}

function readArchivedBoard(file: string): Board | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return isBoard(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isBoard(value: unknown): value is Board {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || !isNumber(value.nextTaskNumber) || !Array.isArray(value.tasks)) {
    return false;
  }
  if (value.revision !== undefined && !isNumber(value.revision)) return false;
  if (value.goal !== undefined && typeof value.goal !== "string") return false;
  if (value.planPending !== undefined && typeof value.planPending !== "boolean") return false;
  if (
    value.scaleApproval !== undefined &&
    (!isRecord(value.scaleApproval) ||
      typeof value.scaleApproval.signature !== "string" ||
      !isNumber(value.scaleApproval.confirmedAt))
  ) {
    return false;
  }
  if (value.activeDecision !== undefined && !isDriveDecision(value.activeDecision)) return false;
  if (value.activeDrive !== undefined && !isActiveDrive(value.activeDrive)) return false;
  if (value.pausedDrive !== undefined && !isPausedDrive(value.pausedDrive)) return false;
  if (
    value.ownerSessions !== undefined &&
    (!Array.isArray(value.ownerSessions) ||
      !value.ownerSessions.every((session) => typeof session === "string"))
  ) {
    return false;
  }
  return value.tasks.every(isTask);
}

function isPausedDrive(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.ownerSession === undefined || typeof value.ownerSession === "string") &&
    (value.taskIds === undefined ||
      (Array.isArray(value.taskIds) &&
        value.taskIds.length <= 64 &&
        value.taskIds.every((id) => typeof id === "string")))
  );
}

function isActiveDrive(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.ownerSession === undefined || typeof value.ownerSession === "string") &&
    (value.taskIds === undefined ||
      (Array.isArray(value.taskIds) &&
        value.taskIds.length <= 64 &&
        value.taskIds.every((id) => typeof id === "string"))) &&
    isNumber(value.startedAt)
  );
}

function isDriveDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const interventions = ["handoff", "abort", "steer"];
  const resolutions = [...interventions, "resume"];
  return (
    typeof value.id === "string" &&
    (value.ownerSession === undefined || typeof value.ownerSession === "string") &&
    typeof value.kind === "string" &&
    Array.isArray(value.taskIds) &&
    value.taskIds.length <= 64 &&
    value.taskIds.every((id) => typeof id === "string") &&
    typeof value.evidence === "string" &&
    value.evidence.length <= 4000 &&
    Array.isArray(value.allowedInterventions) &&
    value.allowedInterventions.every((item) => interventions.includes(String(item))) &&
    isNumber(value.createdAt) &&
    (value.deliveredAt === undefined || isNumber(value.deliveredAt)) &&
    (value.deliveryClaim === undefined ||
      (isRecord(value.deliveryClaim) &&
        typeof value.deliveryClaim.id === "string" &&
        isNumber(value.deliveryClaim.claimedAt))) &&
    (value.resolution === undefined ||
      (isRecord(value.resolution) &&
        resolutions.includes(String(value.resolution.intervention)) &&
        isNumber(value.resolution.resolvedAt)))
  );
}

function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const statuses: TaskStatus[] = [
    "todo",
    "running",
    "ready_for_review",
    "approved",
    "changes_requested",
    "failed",
    "cancelled",
  ];
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.brief === "string" &&
    (value.kind === undefined || value.kind === "investigation") &&
    typeof value.tier === "string" &&
    statuses.includes(value.status as TaskStatus) &&
    Array.isArray(value.dependsOn) &&
    value.dependsOn.every((dependency) => typeof dependency === "string") &&
    (value.writePaths === undefined ||
      (Array.isArray(value.writePaths) &&
        value.writePaths.every((path) => typeof path === "string"))) &&
    (value.successCriteria === undefined ||
      (Array.isArray(value.successCriteria) &&
        value.successCriteria.every((criterion) => typeof criterion === "string"))) &&
    (value.verificationProfile === undefined || typeof value.verificationProfile === "string") &&
    (value.reviewPolicy === undefined ||
      value.reviewPolicy === "single" ||
      value.reviewPolicy === "confirm" ||
      value.reviewPolicy === "find-and-refute") &&
    (value.discovery === undefined || isDiscoveryContract(value.discovery)) &&
    (value.findings === undefined ||
      (Array.isArray(value.findings) && value.findings.every(isReviewFinding))) &&
    Array.isArray(value.attempts) &&
    value.attempts.every(isAttempt) &&
    isNumber(value.createdAt) &&
    isNumber(value.updatedAt) &&
    (value.commitMessage === undefined || typeof value.commitMessage === "string") &&
    (value.supersededBy === undefined || typeof value.supersededBy === "string") &&
    (value.supersedes === undefined || typeof value.supersedes === "string") &&
    (value.reviewNotes === undefined || typeof value.reviewNotes === "string") &&
    (value.approvalKind === undefined ||
      value.approvalKind === "reviewed" ||
      value.approvalKind === "manual") &&
    (value.reviewedPatchHash === undefined || typeof value.reviewedPatchHash === "string") &&
    (value.integratedCommit === undefined || typeof value.integratedCommit === "string") &&
    (value.verificationSummary === undefined || typeof value.verificationSummary === "string") &&
    (value.provenance === undefined || isArtifactProvenance(value.provenance)) &&
    (value.approvedProvenance === undefined || isApprovedProvenance(value.approvedProvenance)) &&
    (value.reviewRejections === undefined || isNumber(value.reviewRejections)) &&
    (value.dispatchNote === undefined || typeof value.dispatchNote === "string") &&
    (value.dispatchClaim === undefined || isDispatchClaim(value.dispatchClaim))
  );
}

function isApprovedProvenance(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.componentHashes)) return false;
  const digest = (candidate: unknown) =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
  if (
    !digest(value.fingerprint) ||
    !digest(value.componentHashes.contract) ||
    !digest(value.componentHashes.execution) ||
    !digest(value.componentHashes.verification) ||
    !digest(value.componentHashes.dependencies) ||
    !isRecord(value.artifact) ||
    (value.artifact.kind !== "git-tree" && value.artifact.kind !== "report") ||
    typeof value.artifact.identity !== "string" ||
    !(value.artifact.kind === "git-tree"
      ? /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value.artifact.identity)
      : /^[a-f0-9]{64}$/.test(value.artifact.identity)) ||
    !isNumber(value.approvedAt) ||
    !Array.isArray(value.dependencyIdentities) ||
    value.dependencyIdentities.length > 512
  ) {
    return false;
  }
  return value.dependencyIdentities.every(
    (dependency) =>
      isRecord(dependency) &&
      typeof dependency.taskId === "string" &&
      dependency.taskId.length > 0 &&
      dependency.taskId.length <= 64 &&
      (dependency.kind === "git-tree" || dependency.kind === "report") &&
      typeof dependency.identity === "string" &&
      (dependency.kind === "git-tree"
        ? /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(dependency.identity)
        : /^[a-f0-9]{64}$/.test(dependency.identity))
  );
}

function isDiscoveryContract(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !Array.isArray(value.allowedWritePaths) ||
    value.allowedWritePaths.length < 1 ||
    value.allowedWritePaths.length > 64 ||
    !value.allowedWritePaths.every((path) => typeof path === "string")
  ) {
    return false;
  }
  try {
    return normalizeWritePaths(value.allowedWritePaths as string[]).length > 0;
  } catch {
    return false;
  }
}

function isArtifactProvenance(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.candidateTree === "string" &&
    isNumber(value.capturedAt) &&
    (value.reviewedAt === undefined || isNumber(value.reviewedAt)) &&
    (value.integratedCommit === undefined || typeof value.integratedCommit === "string") &&
    (value.integratedTree === undefined || typeof value.integratedTree === "string") &&
    (value.verifiedAt === undefined || isNumber(value.verifiedAt)) &&
    (value.verificationProfile === undefined || typeof value.verificationProfile === "string")
  );
}

function isReviewFinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.fingerprint === "string" &&
    typeof value.message === "string" &&
    (value.status === "open" || value.status === "verified") &&
    isNumber(value.firstAttempt) &&
    isNumber(value.lastAttempt)
  );
}

function isDispatchClaim(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.kind === "execute" || value.kind === "review") &&
    isNumber(value.claimedAt) &&
    (value.expiresAt === undefined || isNumber(value.expiresAt))
  );
}

function isValidExecutionComponentHashes(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (["contract", "execution", "verification", "dependencies"] as const).every(
    (key) => typeof value[key] === "string" && /^[a-f0-9]{64}$/.test(value[key] as string)
  );
}

function isAttempt(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.usage)) return false;
  return (
    isNumber(value.index) &&
    typeof value.logFile === "string" &&
    typeof value.thinking === "string" &&
    isNumber(value.startedAt) &&
    isNumber(value.usage.input) &&
    isNumber(value.usage.output) &&
    isNumber(value.usage.cost) &&
    isNumber(value.usage.turns) &&
    Array.isArray(value.touchedFiles) &&
    value.touchedFiles.every((file) => typeof file === "string") &&
    (value.sessionFile === undefined || typeof value.sessionFile === "string") &&
    (value.sessionDir === undefined || typeof value.sessionDir === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.provider === undefined || typeof value.provider === "string") &&
    (value.endedAt === undefined || isNumber(value.endedAt)) &&
    (value.exitCode === undefined || isNumber(value.exitCode)) &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string") &&
    (value.failureReason === undefined || isFailureReason(value.failureReason)) &&
    (value.executionFingerprint === undefined ||
      (typeof value.executionFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(value.executionFingerprint))) &&
    isValidExecutionComponentHashes(value.executionComponentHashes) &&
    (value.consumesAttempt === undefined || typeof value.consumesAttempt === "boolean") &&
    (value.providerFailure === undefined || typeof value.providerFailure === "boolean") &&
    (value.finalReport === undefined || typeof value.finalReport === "string") &&
    (value.promptCharacters === undefined || isNumber(value.promptCharacters)) &&
    (value.promptApproximateTokens === undefined || isNumber(value.promptApproximateTokens)) &&
    (value.promptSections === undefined || isPromptSections(value.promptSections)) &&
    (value.diff === undefined || typeof value.diff === "string") &&
    (value.worktreePath === undefined || typeof value.worktreePath === "string") &&
    (value.branch === undefined || typeof value.branch === "string") &&
    (value.reviewReport === undefined || typeof value.reviewReport === "string") &&
    (value.reviewNotes === undefined || typeof value.reviewNotes === "string") &&
    (value.reviewModel === undefined || typeof value.reviewModel === "string") &&
    (value.reviewProvider === undefined || typeof value.reviewProvider === "string") &&
    (value.reviewLaunches === undefined ||
      (Array.isArray(value.reviewLaunches) && value.reviewLaunches.every(isReviewLaunch))) &&
    (value.reviewConvergence === undefined || isReviewConvergence(value.reviewConvergence)) &&
    (value.reviewConvergenceHistory === undefined ||
      (Array.isArray(value.reviewConvergenceHistory) &&
        value.reviewConvergenceHistory.every(isReviewConvergence))) &&
    (value.reviewUsage === undefined || isUsage(value.reviewUsage)) &&
    (value.reviewSessionFile === undefined || typeof value.reviewSessionFile === "string")
  );
}

function isReviewLaunch(value: unknown): boolean {
  if (!isRecord(value) || !isUsage(value.usage)) return false;
  return (
    isNumber(value.startedAt) &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.reviewerIndex === undefined ||
      (isNumber(value.reviewerIndex) &&
        Number.isInteger(value.reviewerIndex) &&
        value.reviewerIndex > 0)) &&
    (value.role === undefined ||
      value.role === "single" ||
      value.role === "confirmer" ||
      value.role === "finder" ||
      value.role === "refuter") &&
    (value.verdict === undefined ||
      value.verdict === "approve" ||
      value.verdict === "request_changes") &&
    (value.criterionEvidence === undefined ||
      (Array.isArray(value.criterionEvidence) &&
        value.criterionEvidence.every(
          (entry) =>
            isRecord(entry) &&
            isNumber(entry.criterion) &&
            Number.isInteger(entry.criterion) &&
            entry.criterion > 0 &&
            typeof entry.passed === "boolean" &&
            typeof entry.evidence === "string" &&
            entry.evidence.length <= 500
        ))) &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.provider === undefined || typeof value.provider === "string") &&
    (value.sessionFile === undefined || typeof value.sessionFile === "string") &&
    (value.logFile === undefined || typeof value.logFile === "string") &&
    (value.endedAt === undefined || isNumber(value.endedAt)) &&
    (value.exitCode === undefined || isNumber(value.exitCode)) &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string") &&
    (value.failureReason === undefined || isFailureReason(value.failureReason)) &&
    (value.finalReport === undefined || typeof value.finalReport === "string") &&
    (value.promptCharacters === undefined || isNumber(value.promptCharacters)) &&
    (value.promptApproximateTokens === undefined || isNumber(value.promptApproximateTokens)) &&
    (value.promptSections === undefined || isPromptSections(value.promptSections))
  );
}

function isReviewConvergence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.policy === "single" ||
      value.policy === "confirm" ||
      value.policy === "find-and-refute") &&
    (value.status === "approved" ||
      value.status === "changes_requested" ||
      value.status === "disagreement" ||
      value.status === "operational_failure") &&
    isNumber(value.requiredApprovals) &&
    Number.isInteger(value.requiredApprovals) &&
    isNumber(value.actualApprovals) &&
    Number.isInteger(value.actualApprovals) &&
    isNumber(value.reviewerCount) &&
    Number.isInteger(value.reviewerCount) &&
    typeof value.summary === "string" &&
    value.summary.length <= 2_000 &&
    isNumber(value.decidedAt)
  );
}

function isPromptSections(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (section) =>
        isRecord(section) &&
        typeof section.name === "string" &&
        isNumber(section.characters) &&
        typeof section.omitted === "boolean"
    )
  );
}

function isFailureReason(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kinds = [
    "provider_failure",
    "stalled",
    "executor_failure",
    "reviewer_rejection",
    "reviewer_failure",
    "user_abort",
    "cost_cap",
  ];
  return (
    kinds.includes(value.kind as string) &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean"
  );
}

function isUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.input) &&
    isNumber(value.output) &&
    isNumber(value.cost) &&
    isNumber(value.turns)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function quarantineCorruptBoard(file: string): string {
  const prefix = `${file}.corrupt-${Date.now()}`;
  let destination = prefix;
  for (let suffix = 1; existsSync(destination); suffix += 1) {
    destination = `${prefix}-${suffix}`;
  }
  renameSync(file, destination);
  return destination;
}

export function loadStatusHistory(
  cwd: string
): { entries: StatusHistoryEntry[]; skipped: number } | undefined {
  const file = join(stateDir(cwd), HISTORY_FILE);
  if (!existsSync(file)) return undefined;

  const entries: StatusHistoryEntry[] = [];
  let skipped = 0;
  for (const line of readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try {
      const value: unknown = JSON.parse(line);
      if (
        !isRecord(value) ||
        typeof value.ts !== "string" ||
        !Number.isFinite(Date.parse(value.ts)) ||
        typeof value.taskId !== "string" ||
        typeof value.from !== "string" ||
        typeof value.to !== "string"
      ) {
        skipped += 1;
        continue;
      }
      entries.push(value as unknown as StatusHistoryEntry);
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

export function createTask(
  board: Board,
  input: {
    title: string;
    brief: string;
    kind?: "investigation";
    tier: string;
    commitMessage?: string;
    dependsOn?: string[];
    writePaths?: string[];
    successCriteria?: string[];
    verificationProfile?: string;
    reviewPolicy?: "single" | "confirm" | "find-and-refute";
    discovery?: { allowedWritePaths: string[] };
  }
): Task {
  const task: Task = {
    id: `T${board.nextTaskNumber}`,
    title: input.title,
    brief: input.brief,
    tier: input.tier,
    status: "todo",
    dependsOn: input.dependsOn ?? [],
    attempts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (input.kind === "investigation") task.kind = "investigation";
  if (input.commitMessage) task.commitMessage = input.commitMessage;
  if (input.writePaths) task.writePaths = normalizeWritePaths(input.writePaths);
  if (input.successCriteria) task.successCriteria = normalizeSuccessCriteria(input.successCriteria);
  if (input.verificationProfile) task.verificationProfile = input.verificationProfile;
  if (input.reviewPolicy && input.reviewPolicy !== "single") task.reviewPolicy = input.reviewPolicy;
  if (input.discovery) {
    task.discovery = { allowedWritePaths: normalizeWritePaths(input.discovery.allowedWritePaths) };
  }
  board.nextTaskNumber += 1;
  board.tasks.push(task);
  return task;
}

/**
 * Load-modify-save a single task against fresh board state. Use this for
 * every mutation that can race with other writers (parallel executors
 * finishing, dashboard status overrides), so last-write-wins clobbering
 * cannot revert another task's update.
 */
export function updateTask(
  cwd: string,
  taskId: string,
  mutate: (task: Task, board: Board) => void
): Task | undefined {
  const lock = acquireBoardLock(cwd);
  try {
    const board = loadBoard(cwd);
    const task = findTask(board, taskId);
    if (!task) return undefined;
    const previousStatus = task.status;
    mutate(task, board);
    task.updatedAt = Date.now();
    saveBoardUnlocked(cwd, board);
    if (task.status !== previousStatus) {
      recordStatusChange(cwd, task.id, previousStatus, task.status, board.revision as number);
    }
    return task;
  } finally {
    releaseBoardLock(lock);
  }
}

export function assertTaskNotDispatched(task: Task): void {
  if (!task.dispatchClaim) return;
  throw new Error(
    `${task.id} is owned by an active ${task.dispatchClaim.kind} dispatch. Wait for it to finish or abort it first.`
  );
}

export interface DispatchClaimResult {
  task: Task;
  claimed: boolean;
  claimId: string;
  attemptIndex?: number;
  note?: string;
}

export function claimTaskDispatch(
  cwd: string,
  taskId: string,
  kind: "execute" | "review",
  dispatchable: (board: Board, task: Task) => boolean
): DispatchClaimResult | undefined {
  const claimId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let claimed = false;
  let note: string | undefined;
  let attemptIndex: number | undefined;
  const task = updateTask(cwd, taskId, (fresh, board) => {
    if (fresh.dispatchClaim) {
      const expiresAt =
        fresh.dispatchClaim.expiresAt ?? fresh.dispatchClaim.claimedAt + DISPATCH_LEASE_MS;
      if (expiresAt > Date.now()) {
        note = `${fresh.id} dispatch declined; held by ${fresh.dispatchClaim.id} (${fresh.dispatchClaim.kind})`;
        return;
      }
      recoverExpiredClaim(fresh);
    }
    if (!dispatchable(board, fresh)) {
      note = `${fresh.id} dispatch declined; status is ${fresh.status}`;
      return;
    }
    const now = Date.now();
    fresh.dispatchClaim = { id: claimId, kind, claimedAt: now, expiresAt: now + DISPATCH_LEASE_MS };
    delete fresh.dispatchNote;
    claimed = true;
    if (kind === "execute") {
      attemptIndex = Math.max(0, ...fresh.attempts.map((attempt) => attempt.index)) + 1;
      fresh.attempts.push({
        index: attemptIndex,
        logFile: "pending",
        thinking: "pending",
        startedAt: Date.now(),
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
        touchedFiles: [],
      });
      transition(fresh, "running");
    }
    const decision = board.activeDecision;
    if (
      decision?.kind === "stale_completion" &&
      !decision.resolution &&
      (decision.taskIds.includes(fresh.id) ||
        decision.taskIds.every((id) => findTask(board, id)?.status === "cancelled"))
    ) {
      decision.resolution = { intervention: "resume", resolvedAt: now };
      delete decision.deliveryClaim;
    }
  });
  if (!task) return undefined;
  return {
    task,
    claimed,
    claimId,
    ...(attemptIndex ? { attemptIndex } : {}),
    ...(note ? { note } : {}),
  };
}

export function releaseTaskDispatch(cwd: string, taskId: string, claimId: string): boolean {
  let released = false;
  updateTask(cwd, taskId, (task) => {
    if (task.dispatchClaim?.id !== claimId) return;
    delete task.dispatchClaim;
    released = true;
  });
  return released;
}

export function renewTaskDispatch(cwd: string, taskId: string, claimId: string): boolean {
  let renewed = false;
  updateTask(cwd, taskId, (task) => {
    if (task.dispatchClaim?.id !== claimId) return;
    task.dispatchClaim.expiresAt = Date.now() + DISPATCH_LEASE_MS;
    renewed = true;
  });
  return renewed;
}

export function reserveClaimedAttempt(
  cwd: string,
  taskId: string,
  claimId: string
): number | undefined {
  let index: number | undefined;
  updateTask(cwd, taskId, (task) => {
    if (task.dispatchClaim?.id !== claimId) return;
    index = Math.max(0, ...task.attempts.map((attempt) => attempt.index)) + 1;
    task.attempts.push({
      index,
      logFile: "pending",
      thinking: "pending",
      startedAt: Date.now(),
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      touchedFiles: [],
    });
  });
  return index;
}

function recoverExpiredClaim(task: Task): void {
  const claim = task.dispatchClaim;
  if (!claim) return;
  if (claim.kind === "execute" && task.status === "running") {
    const attempt = task.attempts.at(-1);
    if (attempt && attempt.endedAt === undefined) {
      const message = "orphan attempt recovered after expired dispatch lease";
      attempt.endedAt = Date.now();
      attempt.exitCode = 1;
      attempt.errorMessage = message;
      attempt.failureReason = { kind: "executor_failure", message, retryable: true };
    }
    forceStatus(task, "failed");
  }
  delete task.dispatchClaim;
}

export function sweepDispatchState(cwd: string): string[] {
  const notes: string[] = [];
  for (const stale of loadBoard(cwd).tasks) {
    const orphanCount =
      stale.status === "running"
        ? 0
        : stale.attempts.filter(
            (attempt) => attempt.endedAt === undefined && attempt.usage.turns === 0
          ).length;
    const claimExpired =
      stale.dispatchClaim !== undefined &&
      (stale.dispatchClaim.expiresAt ?? stale.dispatchClaim.claimedAt + DISPATCH_LEASE_MS) <=
        Date.now();
    if (!claimExpired && orphanCount === 0) continue;
    updateTask(cwd, stale.id, (task) => {
      const parts: string[] = [];
      const claimExpired =
        task.dispatchClaim !== undefined &&
        (task.dispatchClaim.expiresAt ?? task.dispatchClaim.claimedAt + DISPATCH_LEASE_MS) <=
          Date.now();
      if (task.dispatchClaim && claimExpired) {
        parts.push(`cleared stale ${task.dispatchClaim.kind} claim ${task.dispatchClaim.id}`);
        recoverExpiredClaim(task);
      }
      const orphans = task.attempts.filter(
        (attempt) => attempt.endedAt === undefined && attempt.usage.turns === 0
      );
      for (const attempt of orphans) {
        const message = "orphan attempt recovered after interrupted dispatch";
        attempt.endedAt = Date.now();
        attempt.exitCode = 1;
        attempt.errorMessage = message;
        attempt.failureReason = { kind: "executor_failure", message, retryable: true };
      }
      if (orphans.length > 0) {
        parts.push(`flagged ${orphans.length} orphan attempt${orphans.length === 1 ? "" : "s"}`);
      }
      if (parts.length === 0) return;
      const note = `${task.id}: ${parts.join("; ")}`.slice(0, 500);
      task.dispatchNote = note;
      notes.push(note);
    });
  }
  return notes;
}

export function findTask(board: Board, id: string): Task | undefined {
  const wanted = id.trim().toUpperCase();
  return board.tasks.find((task) => task.id.toUpperCase() === wanted);
}

const LEGAL_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["running"],
  running: ["ready_for_review", "failed", "cancelled"],
  ready_for_review: ["approved", "changes_requested"],
  approved: [],
  changes_requested: ["running"],
  failed: ["running"],
  cancelled: ["running"],
};

export function transition(task: Task, next: TaskStatus): void {
  if (!LEGAL_TRANSITIONS[task.status].includes(next)) {
    throw new Error(`Illegal task status transition: ${task.status} → ${next}`);
  }
  forceStatus(task, next);
}

export function forceStatus(task: Task, status: TaskStatus): void {
  task.status = status;
  task.updatedAt = Date.now();
}

/** @deprecated Prefer transition, or forceStatus for an explicit manual override. */
export function setStatus(task: Task, status: TaskStatus): void {
  forceStatus(task, status);
}

/**
 * A task is runnable when it is pending work and all dependencies are approved.
 * With explicit=true (task named directly in a scoped drive), failed and
 * cancelled tasks are also runnable so dead ends can be retried on purpose.
 */
export function isRunnable(board: Board, task: Task, explicit = false): boolean {
  if (board.planPending) return false;
  const pending = task.status === "todo" || task.status === "changes_requested";
  const retryable = explicit && (task.status === "failed" || task.status === "cancelled");
  if (!pending && !retryable) return false;
  return task.dependsOn.every((depId) => findTask(board, depId)?.status === "approved");
}

export function isFreshlyApproved(board: Board, task: Task, config: MaestroConfig): boolean {
  return completionFreshness(board, task, config).state === "fresh";
}

export function isRunnableWithConfig(
  board: Board,
  task: Task,
  config: MaestroConfig,
  explicit = false
): boolean {
  if (board.planPending) return false;
  const pending = task.status === "todo" || task.status === "changes_requested";
  const retryable = explicit && (task.status === "failed" || task.status === "cancelled");
  if (!pending && !retryable) return false;
  return task.dependsOn.every((dependencyId) => {
    const dependency = findTask(board, dependencyId);
    return dependency ? isFreshlyApproved(board, dependency, config) : false;
  });
}

export type HumanRetryCode =
  | "eligible"
  | "unknown_task"
  | "plan_pending"
  | "active"
  | "foreign_owner"
  | "dependency_blocked"
  | "attempt_cap"
  | "review_disagreement"
  | "not_retryable";

export interface HumanRetryEligibility {
  eligible: boolean;
  code: HumanRetryCode;
  kind?: "execute" | "review";
  requiresConfirmation: boolean;
  message: string;
}

export function humanRetryRiskToken(task: Task): string {
  // updatedAt is deliberately excluded: an unrelated board touch between the
  // user's confirmation and dispatch must not invalidate the confirmed retry.
  // Acceptance and integration evidence changes still do.
  return JSON.stringify({
    status: task.status,
    approvalKind: task.approvalKind,
    integratedCommit: task.integratedCommit,
    provenanceIntegratedCommit: task.provenance?.integratedCommit,
    approvedFingerprint: task.approvedProvenance?.fingerprint,
    attempts: task.attempts.length,
  });
}

export function humanRetryEligibility(
  board: Board,
  taskId: string,
  options: {
    maxAttempts: number;
    isLive: (taskId: string) => boolean;
    ownerSession?: string | undefined;
    config?: MaestroConfig;
  }
): HumanRetryEligibility {
  const refused = (code: Exclude<HumanRetryCode, "eligible">, message: string) => ({
    eligible: false,
    code,
    requiresConfirmation: false,
    message,
  });
  const task = findTask(board, taskId);
  if (!task) return refused("unknown_task", `Unknown task id: ${taskId}`);
  if (board.activeDrive && board.activeDrive.ownerSession !== options.ownerSession) {
    return refused("foreign_owner", `${task.id} is owned by an active drive from another session.`);
  }
  if (board.pausedDrive && board.pausedDrive.ownerSession !== options.ownerSession) {
    return refused("foreign_owner", `${task.id} is owned by a paused drive from another session.`);
  }
  if (board.planPending) return refused("plan_pending", "Plan approval is pending.");
  if (options.isLive(task.id) || task.status === "running" || task.dispatchClaim) {
    return refused("active", `${task.id} is running or owned by an active dispatch.`);
  }
  const dependency = task.dependsOn.find((id) => {
    const candidate = findTask(board, id);
    if (!candidate) return true;
    return options.config
      ? !isFreshlyApproved(board, candidate, options.config)
      : candidate.status !== "approved";
  });
  if (dependency) {
    return refused(
      "dependency_blocked",
      `${task.id} cannot retry until dependency ${dependency} is approved.`
    );
  }
  const convergence = task.attempts.at(-1)?.reviewConvergence?.status;
  if (convergence === "disagreement") {
    return refused(
      "review_disagreement",
      `${task.id} has unresolved reviewer disagreement; change its review policy or task contract before retrying.`
    );
  }
  const latest = task.attempts.at(-1);
  const reviewerFailure =
    convergence === "operational_failure" ||
    latest?.failureReason?.kind === "reviewer_failure" ||
    latest?.reviewLaunches?.at(-1)?.failureReason?.kind === "reviewer_failure";
  if (task.status === "ready_for_review" && reviewerFailure) {
    return {
      eligible: true,
      code: "eligible",
      kind: "review",
      requiresConfirmation: false,
      message: `${task.id} reviewer retry is eligible.`,
    };
  }
  if (!["failed", "cancelled", "changes_requested", "approved"].includes(task.status)) {
    return refused(
      "not_retryable",
      `${task.id} is ${task.status}; there is no failed work to retry.`
    );
  }
  const consumedAttempts = task.attempts.filter(
    (attempt) => attempt.consumesAttempt ?? !attempt.providerFailure
  ).length;
  if (consumedAttempts >= options.maxAttempts) {
    return refused(
      "attempt_cap",
      `${task.id} reached the attempt cap (${options.maxAttempts}). Create a narrowly scoped successor with maestro_plan and set supersedesTaskId to ${task.id}; Maestro will atomically cancel this predecessor and rewire downstream dependencies.`
    );
  }
  const risky =
    task.status === "approved" ||
    task.approvalKind === "manual" ||
    task.integratedCommit !== undefined ||
    task.provenance?.integratedCommit !== undefined;
  const freshness =
    task.status === "approved" && options.config
      ? completionFreshness(board, task, options.config)
      : undefined;
  return {
    eligible: true,
    code: "eligible",
    kind: "execute",
    requiresConfirmation: risky,
    message:
      freshness && freshness.state !== "fresh"
        ? `${task.id} has ${freshness.state} approved work (${freshness.reason}); retry requires explicit confirmation and preserves prior evidence until replacement approval.`
        : risky
          ? `${task.id} has accepted or integrated work; retry requires explicit confirmation.`
          : `${task.id} execution retry is eligible.`,
  };
}

export function scopedDependencyGaps(
  board: Board,
  taskIds: readonly string[]
): Array<{ taskId: string; dependencyId: string }> {
  const selected = new Set(taskIds.map((id) => id.trim().toUpperCase()));
  const gaps: Array<{ taskId: string; dependencyId: string }> = [];
  for (const taskId of selected) {
    const task = findTask(board, taskId);
    if (!task) continue;
    const visit = (dependencyId: string) => {
      const dependency = findTask(board, dependencyId);
      if (!dependency || dependency.status === "approved") return;
      if (!selected.has(dependency.id.toUpperCase())) {
        gaps.push({ taskId: task.id, dependencyId: dependency.id });
      }
      for (const nested of dependency.dependsOn) visit(nested);
    };
    for (const dependencyId of task.dependsOn) visit(dependencyId);
  }
  return gaps.filter(
    (gap, index) =>
      gaps.findIndex(
        (candidate) =>
          candidate.taskId === gap.taskId && candidate.dependencyId === gap.dependencyId
      ) === index
  );
}

export function scopedDependencyGapsWithConfig(
  board: Board,
  taskIds: readonly string[],
  config: MaestroConfig
): Array<{ taskId: string; dependencyId: string }> {
  const selected = new Set(taskIds.map((id) => id.trim().toUpperCase()));
  const gaps: Array<{ taskId: string; dependencyId: string }> = [];
  for (const taskId of selected) {
    const task = findTask(board, taskId);
    if (!task) continue;
    const visit = (dependencyId: string, visited: Set<string>) => {
      if (visited.has(dependencyId)) return;
      visited.add(dependencyId);
      const dependency = findTask(board, dependencyId);
      if (dependency && isFreshlyApproved(board, dependency, config)) return;
      if (dependency && !selected.has(dependency.id.toUpperCase())) {
        gaps.push({ taskId: task.id, dependencyId: dependency.id });
      }
      for (const nested of dependency?.dependsOn ?? []) visit(nested, visited);
    };
    for (const dependencyId of task.dependsOn) visit(dependencyId, new Set());
  }
  return gaps.filter(
    (gap, index) =>
      gaps.findIndex(
        (candidate) =>
          candidate.taskId === gap.taskId && candidate.dependencyId === gap.dependencyId
      ) === index
  );
}

export function blockedReason(board: Board, task: Task): string | undefined {
  const blocking = task.dependsOn.filter((depId) => findTask(board, depId)?.status !== "approved");
  if (blocking.length === 0) return undefined;
  return `blocked by ${blocking.join(", ")}`;
}

export function attemptFailureCause(attempt: Attempt): FailureKind | undefined {
  if (attempt.failureReason) return attempt.failureReason.kind;
  if (attempt.errorMessage?.startsWith("cost cap exceeded:")) return "cost_cap";
  if (attempt.providerFailure) return "provider_failure";
  if (
    attempt.errorMessage &&
    (attempt.usage.turns === 0 ||
      /\b429\b|usage limit|rate limit|quota|too many requests|resource.?exhausted/i.test(
        attempt.errorMessage
      ))
  ) {
    return "provider_failure";
  }
  if (attempt.exitCode !== undefined && attempt.exitCode !== 0) return "executor_failure";
  if (attempt.errorMessage) return "executor_failure";
  return undefined;
}

export function taskFailureCause(task: Task): FailureKind | undefined {
  if (task.status === "cancelled") return "user_abort";
  if (task.status === "changes_requested") return "reviewer_rejection";
  if (task.status !== "failed") return undefined;

  const latestAttempt = task.attempts.at(-1);
  return latestAttempt
    ? (attemptFailureCause(latestAttempt) ?? "executor_failure")
    : "executor_failure";
}

export function isTaskSettled(task: Pick<Task, "status">): boolean {
  return task.status === "approved" || task.status === "cancelled";
}

export function taskGroup(board: Board, task: Task): TaskGroup {
  if (task.status === "todo" || task.status === "changes_requested") {
    return blockedReason(board, task) ? "blocked" : "ready";
  }
  if (task.status === "ready_for_review") return "review-needed";
  return task.status;
}

export function filterTasksByGroup(board: Board, group: TaskGroup): Task[] {
  return board.tasks.filter((task) => taskGroup(board, task) === group);
}

export function groupTasks(board: Board): Record<TaskGroup, Task[]> {
  const groups: Record<TaskGroup, Task[]> = {
    blocked: [],
    ready: [],
    running: [],
    "review-needed": [],
    approved: [],
    failed: [],
    cancelled: [],
  };
  for (const task of board.tasks) groups[taskGroup(board, task)].push(task);
  return groups;
}

export function validatePlan(board: Board, availableTiers?: Iterable<string>): PlanValidation {
  const tasksById = new Map(board.tasks.map((task) => [task.id.toUpperCase(), task]));
  const missingDependencies: PlanValidation["missingDependencies"] = [];
  const validTiers = availableTiers ? new Set(availableTiers) : undefined;
  const invalidTiers = validTiers
    ? board.tasks
        .filter((task) => !validTiers.has(task.tier))
        .map((task) => ({ taskId: task.id, tier: task.tier }))
    : [];
  const contractErrors: NonNullable<PlanValidation["contractErrors"]> = [];

  for (const task of board.tasks) {
    if (task.discovery && task.writePaths?.length !== 0) {
      contractErrors.push({ taskId: task.id, message: "discovery tasks must use writePaths: []" });
    }
  }

  for (const task of board.tasks) {
    for (const dependencyId of task.dependsOn) {
      if (!tasksById.has(dependencyId.trim().toUpperCase())) {
        missingDependencies.push({ taskId: task.id, dependencyId });
      }
    }
  }

  const dependencyCycles: string[][] = [];
  const visited = new Set<string>();
  const active = new Map<string, number>();
  const path: Task[] = [];

  function visit(task: Task): void {
    const taskKey = task.id.toUpperCase();
    visited.add(taskKey);
    active.set(taskKey, path.length);
    path.push(task);

    for (const dependencyId of task.dependsOn) {
      const dependency = tasksById.get(dependencyId.trim().toUpperCase());
      if (!dependency) continue;

      const dependencyKey = dependency.id.toUpperCase();
      const cycleStart = active.get(dependencyKey);
      if (cycleStart !== undefined) {
        dependencyCycles.push([...path.slice(cycleStart).map((item) => item.id), dependency.id]);
      } else if (!visited.has(dependencyKey)) {
        visit(dependency);
      }
    }

    path.pop();
    active.delete(taskKey);
  }

  for (const task of board.tasks) {
    if (!visited.has(task.id.toUpperCase())) visit(task);
  }

  const unresolved = board.tasks.filter(
    (task) => task.status !== "approved" && task.status !== "cancelled" && task.writePaths
  );
  const dependsTransitively = (task: Task, targetId: string, seen = new Set<string>()): boolean => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return task.dependsOn.some((id) => {
      if (id.toUpperCase() === targetId.toUpperCase()) return true;
      const dependency = tasksById.get(id.toUpperCase());
      return dependency ? dependsTransitively(dependency, targetId, seen) : false;
    });
  };
  const writePathOverlaps: NonNullable<PlanValidation["writePathOverlaps"]> = [];
  for (let leftIndex = 0; leftIndex < unresolved.length; leftIndex += 1) {
    const left = unresolved[leftIndex];
    if (!left) continue;
    for (const right of unresolved.slice(leftIndex + 1)) {
      if (dependsTransitively(left, right.id) || dependsTransitively(right, left.id)) continue;
      const path = left.writePaths?.find((candidate) =>
        right.writePaths?.some((other) => writePathsOverlap(candidate, other))
      );
      if (path) writePathOverlaps.push({ leftTaskId: left.id, rightTaskId: right.id, path });
    }
  }

  return {
    missingDependencies,
    dependencyCycles,
    invalidTiers,
    ...(contractErrors.length > 0 ? { contractErrors } : {}),
    ...(writePathOverlaps.length > 0 ? { writePathOverlaps } : {}),
  };
}

export function rejectPlan(cwd: string, expectedRevision: number): string | undefined {
  return replaceBoardWithArchive(
    cwd,
    () => ({ version: 1, nextTaskNumber: 1, tasks: [] }),
    expectedRevision
  );
}

export function approvePlan(board: Board, availableTiers: Iterable<string>): PlanValidation {
  const validation = validatePlan(board, availableTiers);
  if (!planValidationMessage(validation)) board.planPending = false;
  return validation;
}

export function planValidationMessage(validation: PlanValidation): string | undefined {
  const problems: string[] = [];
  for (const missing of validation.missingDependencies) {
    problems.push(`${missing.taskId} references unknown dependency "${missing.dependencyId}"`);
  }
  for (const cycle of validation.dependencyCycles) {
    problems.push(`dependency cycle: ${cycle.join(" → ")}`);
  }
  for (const invalid of validation.invalidTiers) {
    problems.push(`${invalid.taskId} uses unknown tier "${invalid.tier}"`);
  }
  for (const contractError of validation.contractErrors ?? []) {
    problems.push(
      `${contractError.taskId} ${contractError.message}; update the task before dispatch`
    );
  }
  for (const overlap of validation.writePathOverlaps ?? []) {
    problems.push(
      `${overlap.leftTaskId} and ${overlap.rightTaskId} both write "${overlap.path}"; add a dependency or narrow writePaths`
    );
  }
  if (problems.length === 0) return undefined;
  return `Invalid plan:\n- ${problems.join("\n- ")}`;
}

export function normalizeSuccessCriteria(criteria: string[]): string[] {
  if (criteria.length < 1 || criteria.length > 12) {
    throw new Error("successCriteria must contain 1-12 items.");
  }
  return criteria.map((value) => {
    const criterion = value.trim();
    if (!criterion || criterion.length > 500) {
      throw new Error("Each success criterion must contain 1-500 characters.");
    }
    return criterion;
  });
}

export function normalizeWritePaths(paths: string[]): string[] {
  if (paths.length > 64) throw new Error("writePaths cannot contain more than 64 paths.");
  return [
    ...new Set(
      paths.map((value) => {
        const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
        if (!path || path.length > 240 || isAbsolute(path) || path.split("/").includes("..")) {
          throw new Error(`Invalid repository-relative write path: ${value}`);
        }
        return path;
      })
    ),
  ].sort();
}

/** Legacy brief phrasing accepted as an investigation marker for boards planned before the explicit kind field. */
const LEGACY_INVESTIGATION_BRIEF = /investigat|no[- ]file|read[- ]only/i;

export function normalizeTaskContract(input: {
  brief: string;
  kind?: "investigation";
  writePaths?: string[];
  successCriteria?: string[];
}): { writePaths: string[]; successCriteria?: string[]; kind?: "investigation" } {
  if (!input.writePaths) throw new Error("writePaths is required for every new task");
  const writePaths = normalizeWritePaths(input.writePaths);
  const noFileTask =
    writePaths.length === 0 &&
    (input.kind === "investigation" || LEGACY_INVESTIGATION_BRIEF.test(input.brief));
  if (input.kind === "investigation" && writePaths.length > 0) {
    throw new Error("investigation tasks must use writePaths: []");
  }
  if (writePaths.length === 0 && !noFileTask) {
    throw new Error(
      'empty writePaths requires kind: "investigation" (or a legacy investigation/no-file brief)'
    );
  }
  if (!noFileTask && !input.successCriteria) {
    throw new Error("successCriteria is required for every executable task");
  }
  const successCriteria = noFileTask
    ? input.successCriteria && input.successCriteria.length > 0
      ? normalizeSuccessCriteria(input.successCriteria)
      : undefined
    : normalizeSuccessCriteria(input.successCriteria ?? []);
  return {
    writePaths,
    ...(successCriteria ? { successCriteria } : {}),
    ...(noFileTask ? { kind: "investigation" as const } : {}),
  };
}

export function normalizeExistingTaskContract(
  task: Pick<Task, "brief" | "kind" | "writePaths" | "successCriteria">
): { writePaths: string[]; successCriteria?: string[]; kind?: "investigation" } {
  return normalizeTaskContract({
    brief: task.brief,
    ...(task.kind === undefined ? {} : { kind: task.kind }),
    ...(task.writePaths === undefined ? {} : { writePaths: task.writePaths }),
    ...(task.successCriteria === undefined ? {} : { successCriteria: task.successCriteria }),
  });
}

/** A task is read-only when it is an explicit investigation or a discovery task. */
export function isReadOnlyTask(
  task: Pick<Task, "kind" | "discovery" | "writePaths" | "brief">
): boolean {
  if (task.kind === "investigation" || task.discovery) return true;
  return task.writePaths?.length === 0 && LEGACY_INVESTIGATION_BRIEF.test(task.brief);
}

function writePathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.endsWith("/**")) return right.startsWith(left.slice(0, -2));
  if (right.endsWith("/**")) return left.startsWith(right.slice(0, -2));
  return false;
}

export function applyPlanTaskEdits(
  task: Task,
  edits: PlanTaskEdits,
  availableTiers: Iterable<string>
): void {
  if (edits.title !== undefined) {
    const title = edits.title.trim();
    if (!title) throw new Error(`${task.id} title cannot be empty.`);
    task.title = title;
  }
  if (edits.brief !== undefined) {
    const brief = edits.brief.trim();
    if (!brief) throw new Error(`${task.id} brief cannot be empty.`);
    task.brief = brief;
    delete task.reviewNotes;
    delete task.reviewRejections;
    if (task.status === "changes_requested" || task.status === "failed") {
      forceStatus(task, "todo");
    }
  }
  if (edits.kind !== undefined) {
    if (edits.kind === "investigation") task.kind = "investigation";
    else delete task.kind;
  }
  if (edits.tier !== undefined) {
    if (!new Set(availableTiers).has(edits.tier)) {
      throw new Error(`${task.id} uses unknown tier "${edits.tier}".`);
    }
    task.tier = edits.tier;
    delete task.reviewRejections;
  }
  if (edits.dependsOn !== undefined) {
    task.dependsOn = edits.dependsOn.map((id) => id.trim().toUpperCase()).filter(Boolean);
  }
  if (edits.writePaths !== undefined) task.writePaths = normalizeWritePaths(edits.writePaths);
  if (edits.commitMessage !== undefined) {
    const commitMessage = edits.commitMessage.trim();
    if (commitMessage) task.commitMessage = commitMessage;
    else delete task.commitMessage;
  }
  if (edits.successCriteria !== undefined) {
    task.successCriteria = normalizeSuccessCriteria(edits.successCriteria);
  }
  if (edits.verificationProfile !== undefined) {
    const profile = edits.verificationProfile.trim();
    if (profile) task.verificationProfile = profile;
    else delete task.verificationProfile;
  }
  if (edits.reviewPolicy !== undefined) {
    const currentPolicy = task.reviewPolicy ?? "single";
    if (edits.reviewPolicy !== currentPolicy) {
      if (edits.reviewPolicy === "single") delete task.reviewPolicy;
      else task.reviewPolicy = edits.reviewPolicy;
      const latestAttempt = task.attempts.at(-1);
      if (
        latestAttempt?.reviewConvergence?.status === "disagreement" ||
        latestAttempt?.reviewConvergence?.status === "operational_failure"
      ) {
        delete latestAttempt.reviewConvergence;
      }
    }
  }
  if (edits.cancelled === true) forceStatus(task, "cancelled");
  if (edits.cancelled === false && task.status === "cancelled") forceStatus(task, "todo");
  task.updatedAt = Date.now();
}
