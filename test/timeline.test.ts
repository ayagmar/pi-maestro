import assert from "node:assert/strict";
import test from "node:test";
import { createTask, forceStatus } from "../src/board.js";
import { deriveRunTimeline, formatRunTimeline } from "../src/timeline.js";
import { type Board } from "../src/types.js";

test("timeline derivation is deterministic, filterable, and bounded", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const first = createTask(board, { title: "First", brief: "work", tier: "standard" });
  const second = createTask(board, { title: "Second", brief: "work", tier: "standard" });
  first.createdAt = 10;
  second.createdAt = 10;
  first.attempts.push({
    index: 1,
    logFile: "attempt.log",
    thinking: "low",
    startedAt: 20,
    endedAt: 30,
    exitCode: 1,
    failureReason: { kind: "executor_failure", message: "failed", retryable: true },
    usage: { input: 1, output: 1, cost: 0.25, turns: 2 },
    touchedFiles: [],
  });
  forceStatus(first, "approved");
  first.approvalKind = "manual";
  first.updatedAt = 40;

  const timeline = deriveRunTimeline(board);
  assert.deepEqual(
    timeline.map((event) => `${event.taskId}:${event.kind}`),
    ["T1:planned", "T2:planned", "T1:dispatch", "T1:execute", "T1:approval"]
  );
  assert.deepEqual(
    deriveRunTimeline(board, "t2").map((event) => event.taskId),
    ["T2"]
  );
  assert.ok(formatRunTimeline(timeline, 180).length <= 180);
});
