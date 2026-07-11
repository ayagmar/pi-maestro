import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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
  const dir = stateDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // Runtime state (board, logs) has no place in version control.
    writeFileSync(join(dir, ".gitignore"), "*\n", "utf-8");
  }
  board.revision = (board.revision ?? 0) + 1;
  const file = boardFile(cwd);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf-8");
  renameSync(tmp, file);
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

  const archivedCurrent = archiveBoard(cwd);
  saveBoard(cwd, board);
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
    value.ownerSessions !== undefined &&
    (!Array.isArray(value.ownerSessions) ||
      !value.ownerSessions.every((session) => typeof session === "string"))
  ) {
    return false;
  }
  return value.tasks.every(isTask);
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
    Array.isArray(value.attempts) &&
    value.attempts.every(isAttempt) &&
    isNumber(value.createdAt) &&
    isNumber(value.updatedAt) &&
    (value.commitMessage === undefined || typeof value.commitMessage === "string") &&
    (value.reviewNotes === undefined || typeof value.reviewNotes === "string")
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
    (value.providerFailure === undefined || typeof value.providerFailure === "boolean") &&
    (value.finalReport === undefined || typeof value.finalReport === "string") &&
    (value.diff === undefined || typeof value.diff === "string") &&
    (value.worktreePath === undefined || typeof value.worktreePath === "string") &&
    (value.branch === undefined || typeof value.branch === "string") &&
    (value.reviewReport === undefined || typeof value.reviewReport === "string") &&
    (value.reviewNotes === undefined || typeof value.reviewNotes === "string") &&
    (value.reviewModel === undefined || typeof value.reviewModel === "string") &&
    (value.reviewProvider === undefined || typeof value.reviewProvider === "string") &&
    (value.reviewUsage === undefined || isUsage(value.reviewUsage)) &&
    (value.reviewSessionFile === undefined || typeof value.reviewSessionFile === "string")
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
  const board = loadBoard(cwd);
  const task = findTask(board, taskId);
  if (!task) return undefined;
  const previousStatus = task.status;
  mutate(task, board);
  task.updatedAt = Date.now();
  saveBoard(cwd, board);
  if (task.status !== previousStatus) {
    recordStatusChange(cwd, task.id, previousStatus, task.status, board.revision as number);
  }
  return task;
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
 * With explicit=true (task named directly in maestro_run), failed and
 * cancelled tasks are also runnable so dead ends can be retried on purpose.
 */
export function isRunnable(board: Board, task: Task, explicit = false): boolean {
  if (board.planPending) return false;
  const pending = task.status === "todo" || task.status === "changes_requested";
  const retryable = explicit && (task.status === "failed" || task.status === "cancelled");
  if (!pending && !retryable) return false;
  return task.dependsOn.every((depId) => findTask(board, depId)?.status === "approved");
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
      /usage limit|rate limit|quota|too many requests|resource.?exhausted/i.test(
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

  return { missingDependencies, dependencyCycles, invalidTiers };
}

export function rejectPlan(cwd: string): string | undefined {
  const archivePath = archiveBoard(cwd);
  if (!archivePath) return undefined;
  saveBoard(cwd, { version: 1, nextTaskNumber: 1, tasks: [] });
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
  if (problems.length === 0) return undefined;
  return `Invalid plan:\n- ${problems.join("\n- ")}`;
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
    if (task.status === "changes_requested" || task.status === "failed") {
      forceStatus(task, "todo");
    }
  }
  if (edits.tier !== undefined) {
    if (!new Set(availableTiers).has(edits.tier)) {
      throw new Error(`${task.id} uses unknown tier "${edits.tier}".`);
    }
    task.tier = edits.tier;
  }
  if (edits.dependsOn !== undefined) {
    task.dependsOn = edits.dependsOn.map((id) => id.trim().toUpperCase()).filter(Boolean);
  }
  if (edits.cancelled === true) forceStatus(task, "cancelled");
  if (edits.cancelled === false && task.status === "cancelled") forceStatus(task, "todo");
  task.updatedAt = Date.now();
}
