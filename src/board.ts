import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOARD_FILE, STATE_DIR } from "./constants.js";
import { type Board, type Task, type TaskStatus } from "./types.js";

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
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Board;
  } catch {
    return structuredClone(EMPTY_BOARD);
  }
}

export function saveBoard(cwd: string, board: Board): void {
  mkdirSync(stateDir(cwd), { recursive: true });
  const file = boardFile(cwd);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf-8");
  renameSync(tmp, file);
}

export function createTask(
  board: Board,
  input: { title: string; brief: string; tier: string; dependsOn?: string[] }
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
  mutate(task, board);
  task.updatedAt = Date.now();
  saveBoard(cwd, board);
  return task;
}

export function findTask(board: Board, id: string): Task | undefined {
  const wanted = id.trim().toUpperCase();
  return board.tasks.find((task) => task.id.toUpperCase() === wanted);
}

export function setStatus(task: Task, status: TaskStatus): void {
  task.status = status;
  task.updatedAt = Date.now();
}

/**
 * A task is runnable when it is pending work and all dependencies are approved.
 * With explicit=true (task named directly in conductor_run), failed and
 * cancelled tasks are also runnable so dead ends can be retried on purpose.
 */
export function isRunnable(board: Board, task: Task, explicit = false): boolean {
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
