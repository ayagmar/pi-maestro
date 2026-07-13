import assert from "node:assert/strict";
import test from "node:test";
import { createTask } from "../src/board.js";
import { formatStatusProjection, projectStatus } from "../src/status.js";
import { type Board } from "../src/types.js";

test("status projection uses one deterministic phase and accounting model", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const task = createTask(board, { title: "Work", brief: "Do work", tier: "standard" });
  assert.equal(projectStatus(board).code, "ready");
  assert.equal(projectStatus(board, [task.id]).code, "running");
  board.planPending = true;
  assert.equal(projectStatus(board, [task.id]).code, "plan_pending");
  delete board.planPending;
  task.status = "approved";
  const complete = projectStatus(board);
  assert.equal(complete.code, "complete");
  assert.match(formatStatusProjection(complete), /complete · 1\/1 approved/);
});
