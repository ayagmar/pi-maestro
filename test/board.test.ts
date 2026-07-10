import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  blockedReason,
  createTask,
  findTask,
  isRunnable,
  loadBoard,
  saveBoard,
  setStatus,
} from "../src/board.js";
import { type Board } from "../src/types.js";

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

test("saveBoard/loadBoard round-trips", () => {
  const cwd = mkdtempSync(join(tmpdir(), "conductor-test-"));
  try {
    const board = emptyBoard();
    createTask(board, { title: "A", brief: "do a", tier: "complex" });
    saveBoard(cwd, board);
    const loaded = loadBoard(cwd);
    assert.equal(loaded.tasks.length, 1);
    assert.equal(loaded.tasks[0]?.tier, "complex");
    assert.equal(loaded.nextTaskNumber, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadBoard returns empty board when missing or corrupt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "conductor-test-"));
  try {
    assert.deepEqual(loadBoard(cwd).tasks, []);
    mkdirSync(join(cwd, ".pi", "conductor"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "conductor", "board.json"), "not json");
    assert.deepEqual(loadBoard(cwd).tasks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
