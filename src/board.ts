import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./constants.js";
import { type Board, type Task, type TaskStatus } from "./types.js";

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
  const archive = join(archiveDir, `${new Date().toISOString()}-board.json`);
  copyFileSync(file, archive);
  return archive;
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
