import assert from "node:assert/strict";
import test from "node:test";
import {
  assertKnownTaskIds,
  maestroBoardCwd,
  previousBoardSession,
  sessionCanControlDrive,
  sessionSwitchBlocked,
} from "../src/index.js";
import { createTask } from "../src/board.js";
import { type Board } from "../src/types.js";

const owner = "/sessions/orchestrator.jsonl";
const executor = "/sessions/executor.jsonl";
const other = "/sessions/other.jsonl";

test("restores owner → worktree executor → owner navigation", () => {
  const boardCwd = maestroBoardCwd("/repo/.pi/maestro/worktrees/t7-attempt-1");
  assert.equal(boardCwd, "/repo");

  assert.equal(previousBoardSession(owner, executor, [owner], [executor]), owner);
  assert.equal(previousBoardSession(executor, owner, [owner], [executor]), executor);
});

test("supports repeated back toggling between a board owner and executor", () => {
  let current = executor;
  let previous = previousBoardSession(owner, current, [owner], [executor]);

  for (const expected of [owner, executor, owner, executor]) {
    assert.equal(previous, expected);
    const nextCurrent = previous;
    previous = previousBoardSession(current, nextCurrent, [owner], [executor]);
    current = nextCurrent;
  }
});

test("drive controls stay with their owning session", () => {
  assert.equal(sessionCanControlDrive(owner, owner), true);
  assert.equal(sessionCanControlDrive(owner, other), false);
  assert.equal(sessionCanControlDrive(undefined, other), true);
  assert.equal(sessionCanControlDrive(owner, undefined), true);
});

test("session switches are blocked for active drive ownership or live executors", () => {
  assert.equal(sessionSwitchBlocked(true, 0), true);
  assert.equal(sessionSwitchBlocked(false, 1), true);
  assert.equal(sessionSwitchBlocked(true, 2), true);
  assert.equal(sessionSwitchBlocked(false, 0), false);
});

test("explicit dispatch rejects unknown task ids", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  createTask(board, { title: "Known", brief: "work", tier: "standard" });

  assert.doesNotThrow(() => assertKnownTaskIds(board, ["t1"]));
  assert.throws(() => assertKnownTaskIds(board, ["T1", "T99"]), /Unknown task id.*T99/);
});

test("does not restore unrelated sessions or cross executor boundaries", () => {
  assert.equal(previousBoardSession(other, owner, [owner], [executor]), undefined);
  assert.equal(previousBoardSession(executor, other, [owner], [executor]), undefined);
  assert.equal(
    previousBoardSession(executor, "/sessions/reviewer.jsonl", [owner], [executor]),
    undefined
  );
  assert.equal(previousBoardSession(owner, executor, undefined, [executor]), undefined);
});
