import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  archiveBoard,
  blockedReason,
  createTask,
  findTask,
  forceStatus,
  isRunnable,
  loadBoard,
  loadStatusHistory,
  saveBoard,
  setStatus,
  transition,
  updateTask,
} from "../src/board.js";
import { type Board, type TaskStatus } from "../src/types.js";

function emptyBoard(): Board {
  return { version: 1, nextTaskNumber: 1, tasks: [] };
}

test("createTask assigns sequential ids", () => {
  const board = emptyBoard();
  const first = createTask(board, { title: "A", brief: "do a", tier: "standard" });
  const second = createTask(board, { title: "B", brief: "do b", tier: "trivial" });
  assert.equal(first.id, "T1");
  assert.equal(second.id, "T2");
  assert.equal(board.nextTaskNumber, 3);
  assert.equal(first.status, "todo");
});

test("transition accepts every legal lifecycle move", () => {
  const legalMoves: [TaskStatus, TaskStatus][] = [
    ["todo", "running"],
    ["running", "ready_for_review"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["ready_for_review", "approved"],
    ["ready_for_review", "changes_requested"],
    ["changes_requested", "running"],
    ["failed", "running"],
    ["cancelled", "running"],
  ];

  for (const [current, next] of legalMoves) {
    const task = createTask(emptyBoard(), { title: "A", brief: "do a", tier: "standard" });
    forceStatus(task, current);
    transition(task, next);
    assert.equal(task.status, next, `${current} → ${next}`);
  }
});

test("transition rejects illegal lifecycle moves with a useful error", () => {
  const task = createTask(emptyBoard(), { title: "A", brief: "do a", tier: "standard" });
  assert.throws(() => transition(task, "approved"), /Illegal.*todo.*approved/);
  forceStatus(task, "approved");
  assert.throws(() => transition(task, "running"), /Illegal.*approved.*running/);
});

test("forceStatus permits a manual lifecycle override", () => {
  const task = createTask(emptyBoard(), { title: "A", brief: "do a", tier: "standard" });
  forceStatus(task, "approved");
  assert.equal(task.status, "approved");
  assert.ok(task.updatedAt > 0);
});

test("findTask is case-insensitive", () => {
  const board = emptyBoard();
  createTask(board, { title: "A", brief: "do a", tier: "standard" });
  assert.equal(findTask(board, "t1")?.id, "T1");
  assert.equal(findTask(board, " T1 ")?.id, "T1");
  assert.equal(findTask(board, "T9"), undefined);
});

test("isRunnable requires approved dependencies", () => {
  const board = emptyBoard();
  const dep = createTask(board, { title: "A", brief: "do a", tier: "standard" });
  const task = createTask(board, {
    title: "B",
    brief: "do b",
    tier: "standard",
    dependsOn: [dep.id],
  });

  assert.equal(isRunnable(board, dep), true);
  assert.equal(isRunnable(board, task), false);
  assert.equal(blockedReason(board, task), "blocked by T1");

  setStatus(dep, "approved");
  assert.equal(isRunnable(board, task), true);
  assert.equal(blockedReason(board, task), undefined);
});

test("changes_requested tasks are runnable again", () => {
  const board = emptyBoard();
  const task = createTask(board, { title: "A", brief: "do a", tier: "standard" });
  setStatus(task, "changes_requested");
  assert.equal(isRunnable(board, task), true);
  setStatus(task, "ready_for_review");
  assert.equal(isRunnable(board, task), false);
});

test("failed and cancelled tasks are runnable only when explicitly named", () => {
  const board = emptyBoard();
  const task = createTask(board, { title: "A", brief: "do a", tier: "standard" });
  setStatus(task, "failed");
  assert.equal(isRunnable(board, task), false);
  assert.equal(isRunnable(board, task, true), true);
  setStatus(task, "cancelled");
  assert.equal(isRunnable(board, task), false);
  assert.equal(isRunnable(board, task, true), true);
  setStatus(task, "approved");
  assert.equal(isRunnable(board, task, true), false);
});

test("updateTask mutates against fresh state so concurrent writers do not clobber", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const board = emptyBoard();
    createTask(board, { title: "A", brief: "a", tier: "standard" });
    createTask(board, { title: "B", brief: "b", tier: "standard" });
    saveBoard(cwd, board);

    // Two "workers" holding stale copies update different tasks.
    updateTask(cwd, "T1", (task) => {
      task.status = "ready_for_review";
    });
    updateTask(cwd, "T2", (task) => {
      task.status = "failed";
    });

    const fresh = loadBoard(cwd);
    assert.equal(findTask(fresh, "T1")?.status, "ready_for_review");
    assert.equal(findTask(fresh, "T2")?.status, "failed");
    assert.equal(
      updateTask(cwd, "T9", () => {}),
      undefined
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("saveBoard/loadBoard round-trips and increments revisions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const board = emptyBoard();
    createTask(board, { title: "A", brief: "do a", tier: "complex" });
    saveBoard(cwd, board);
    assert.equal(board.revision, 1);

    saveBoard(cwd, board);
    assert.equal(board.revision, 2);

    const loaded = loadBoard(cwd);
    assert.equal(loaded.tasks.length, 1);
    assert.equal(loaded.tasks[0]?.tier, "complex");
    assert.equal(loaded.nextTaskNumber, 2);
    assert.equal(loaded.revision, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("updateTask records exactly one line for a status change", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const board = emptyBoard();
    createTask(board, { title: "A", brief: "do a", tier: "standard" });
    saveBoard(cwd, board);

    updateTask(cwd, "T1", (task) => {
      task.title = "Renamed";
    });
    const historyFile = join(cwd, ".pi", "maestro", "history.jsonl");
    assert.equal(existsSync(historyFile), false);

    updateTask(cwd, "T1", (task) => {
      task.status = "running";
      task.title = "Running";
    });
    const lines = readFileSync(historyFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record), ["ts", "taskId", "from", "to", "revision"]);
    assert.equal(typeof record.ts, "string");
    assert.equal(record.taskId, "T1");
    assert.equal(record.from, "todo");
    assert.equal(record.to, "running");
    assert.equal(record.revision, 3);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadStatusHistory returns recorded status changes and distinguishes a missing file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    assert.equal(loadStatusHistory(cwd), undefined);

    const board = emptyBoard();
    createTask(board, { title: "A", brief: "do a", tier: "standard" });
    saveBoard(cwd, board);
    updateTask(cwd, "T1", (task) => transition(task, "running"));

    const history = loadStatusHistory(cwd);
    assert.equal(history?.length, 1);
    assert.equal(history?.[0]?.taskId, "T1");
    assert.equal(history?.[0]?.from, "todo");
    assert.equal(history?.[0]?.to, "running");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("archiveBoard copies the current board and returns its path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    assert.equal(archiveBoard(cwd), undefined);
    assert.equal(existsSync(join(cwd, ".pi", "maestro", "archive")), false);

    const board = emptyBoard();
    saveBoard(cwd, board);
    const boardContents = readFileSync(join(cwd, ".pi", "maestro", "board.json"), "utf-8");
    const archive = archiveBoard(cwd);

    assert.ok(archive);
    assert.match(archive, /archive[/\\].+-board\.json$/);
    assert.equal(readFileSync(archive, "utf-8"), boardContents);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadBoard returns an empty board when the file is missing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    assert.deepEqual(loadBoard(cwd), emptyBoard());
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadBoard archives a corrupt board before returning an empty board", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  const directory = join(cwd, ".pi", "maestro");
  const file = join(directory, "board.json");
  const corruptContents = "not json";
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, corruptContents);

    assert.deepEqual(loadBoard(cwd), emptyBoard());
    assert.equal(existsSync(file), false);

    const archives = readdirSync(directory).filter((name) =>
      /^board\.json\.corrupt-\d+$/.test(name)
    );
    assert.equal(archives.length, 1);
    assert.equal(readFileSync(join(directory, archives[0] as string), "utf-8"), corruptContents);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
