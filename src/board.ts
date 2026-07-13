import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { STATE_DIR } from "./constants.js";
import {
  type Attempt,
  type Board,
  type FailureKind,
  type PlanTaskEdits,
  type PlanValidation,
  type Task,
  type TaskGroup,
  type TaskStatus,
} from "./types.js";

export const BOARD_FILE = "board.json";
const HISTORY_FILE = "history.jsonl";
const BOARD_LOCK_STALE_MS = 30_000;
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

export function loadBoard(cwd: string): Board {
  const file = boardFile(cwd);
  if (!existsSync(file)) return structuredClone(EMPTY_BOARD);
  const contents = readFileSync(file, "utf-8");
  try {
    return JSON.parse(contents) as Board;
  } catch {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
    return structuredClone(EMPTY_BOARD);
  }
}

export function saveBoard(cwd: string, board: Board): void {
  const lock = acquireBoardLock(cwd);
  try {
    saveBoardUnlocked(cwd, board);
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
}

function acquireBoardLock(cwd: string): BoardLock {
  const dir = stateDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "board.lock");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let tries = 0; tries < BOARD_LOCK_RETRIES; tries += 1) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      return { fd, file, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const staleOwner = staleLockOwner(file);
      if (staleOwner && reclaimStaleLock(file, staleOwner)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
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
    const owner = JSON.parse(contents) as { pid?: unknown; token?: unknown };
    if (typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
        return undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined;
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
  selectedFile: string
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

  const currentRevision = loadBoard(cwd).revision ?? 0;
  const archivedCurrent = archiveBoard(cwd);
  replaceBoard(cwd, board, currentRevision);
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
  if (value.activeDecision !== undefined && !isDriveDecision(value.activeDecision)) return false;
  if (
    value.ownerSessions !== undefined &&
    (!Array.isArray(value.ownerSessions) ||
      !value.ownerSessions.every((session) => typeof session === "string"))
  ) {
    return false;
  }
  return value.tasks.every(isTask);
}

function isDriveDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const interventions = ["handoff", "abort", "steer"];
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
    (value.resolution === undefined ||
      (isRecord(value.resolution) &&
        interventions.includes(String(value.resolution.intervention)) &&
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
    (value.findings === undefined ||
      (Array.isArray(value.findings) && value.findings.every(isReviewFinding))) &&
    Array.isArray(value.attempts) &&
    value.attempts.every(isAttempt) &&
    isNumber(value.createdAt) &&
    isNumber(value.updatedAt) &&
    (value.commitMessage === undefined || typeof value.commitMessage === "string") &&
    (value.reviewNotes === undefined || typeof value.reviewNotes === "string") &&
    (value.approvalKind === undefined ||
      value.approvalKind === "reviewed" ||
      value.approvalKind === "manual") &&
    (value.reviewedPatchHash === undefined || typeof value.reviewedPatchHash === "string") &&
    (value.integratedCommit === undefined || typeof value.integratedCommit === "string") &&
    (value.verificationSummary === undefined || typeof value.verificationSummary === "string") &&
    (value.provenance === undefined || isArtifactProvenance(value.provenance)) &&
    (value.reviewRejections === undefined || isNumber(value.reviewRejections)) &&
    (value.dispatchNote === undefined || typeof value.dispatchNote === "string") &&
    (value.dispatchClaim === undefined || isDispatchClaim(value.dispatchClaim))
  );
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
    (value.reviewUsage === undefined || isUsage(value.reviewUsage)) &&
    (value.reviewSessionFile === undefined || typeof value.reviewSessionFile === "string")
  );
}

function isReviewLaunch(value: unknown): boolean {
  if (!isRecord(value) || !isUsage(value.usage)) return false;
  return (
    isNumber(value.startedAt) &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.provider === undefined || typeof value.provider === "string") &&
    (value.sessionFile === undefined || typeof value.sessionFile === "string") &&
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

export function loadStatusHistory(cwd: string): StatusHistoryEntry[] | undefined {
  const file = join(stateDir(cwd), HISTORY_FILE);
  if (!existsSync(file)) return undefined;

  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StatusHistoryEntry);
}

export function createTask(
  board: Board,
  input: {
    title: string;
    brief: string;
    tier: string;
    commitMessage?: string;
    dependsOn?: string[];
    writePaths?: string[];
    successCriteria?: string[];
    verificationProfile?: string;
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
  if (input.commitMessage) task.commitMessage = input.commitMessage;
  if (input.writePaths) task.writePaths = normalizeWritePaths(input.writePaths);
  if (input.successCriteria) task.successCriteria = normalizeSuccessCriteria(input.successCriteria);
  if (input.verificationProfile) task.verificationProfile = input.verificationProfile;
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
    ...(writePathOverlaps.length > 0 ? { writePathOverlaps } : {}),
  };
}

export function rejectPlan(cwd: string): string | undefined {
  const archivePath = archiveBoard(cwd);
  if (!archivePath) return undefined;
  replaceBoard(cwd, { version: 1, nextTaskNumber: 1, tasks: [] }, loadBoard(cwd).revision ?? 0);
  return archivePath;
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
  if (edits.successCriteria !== undefined) {
    task.successCriteria = normalizeSuccessCriteria(edits.successCriteria);
  }
  if (edits.verificationProfile !== undefined) {
    const profile = edits.verificationProfile.trim();
    if (profile) task.verificationProfile = profile;
    else delete task.verificationProfile;
  }
  if (edits.cancelled === true) forceStatus(task, "cancelled");
  if (edits.cancelled === false && task.status === "cancelled") forceStatus(task, "todo");
  task.updatedAt = Date.now();
}
