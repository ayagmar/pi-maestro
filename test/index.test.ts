import assert from "node:assert/strict";
import test from "node:test";
import { maestroBoardCwd, previousBoardSession } from "../src/index.js";

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

test("does not restore unrelated sessions or cross executor boundaries", () => {
  assert.equal(previousBoardSession(other, owner, [owner], [executor]), undefined);
  assert.equal(previousBoardSession(executor, other, [owner], [executor]), undefined);
  assert.equal(
    previousBoardSession(executor, "/sessions/reviewer.jsonl", [owner], [executor]),
    undefined
  );
  assert.equal(previousBoardSession(owner, executor, undefined, [executor]), undefined);
});
