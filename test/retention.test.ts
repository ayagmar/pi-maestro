import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTask, saveBoard, stateDir } from "../src/board.js";
import {
  captureBoardLogs,
  cleanupStaleLogs,
  inspectLogRetention,
  pruneStaleLogs,
  pruneTaskLogs,
} from "../src/retention.js";
import { type Board } from "../src/types.js";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-retention-"));
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const task = createTask(board, { title: "Task", brief: "Brief", tier: "standard" });
  task.status = "approved";
  task.attempts = [1, 2].map((index) => ({
    index,
    logFile: join(stateDir(cwd), "logs", `${task.id}-attempt-${index}.jsonl`),
    thinking: "low" as const,
    startedAt: index,
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
  }));
  saveBoard(cwd, board);
  const logs = join(stateDir(cwd), "logs");
  mkdirSync(logs, { recursive: true });
  for (const name of [
    "T1-attempt-1.jsonl",
    "T1-review-1-launch-1.jsonl",
    "T1-attempt-2.jsonl",
    "T1-review-2-launch-1.jsonl",
    "removed-attempt-1.jsonl",
  ]) {
    writeFileSync(join(logs, name), name);
  }
  return { cwd, board, task, logs };
}

test("retention classifies latest settled logs as retained and older/removed logs as stale", () => {
  const { cwd, board } = fixture();
  try {
    const states = new Map(
      inspectLogRetention(cwd, board).map((entry) => [entry.file.split("/").at(-1), entry.state])
    );
    assert.equal(states.get("T1-attempt-2.jsonl"), "retained");
    assert.equal(states.get("T1-review-2-launch-1.jsonl"), "retained");
    assert.equal(states.get("T1-attempt-1.jsonl"), "stale");
    assert.equal(states.get("removed-attempt-1.jsonl"), "stale");
    assert.equal(inspectLogRetention(cwd, board, new Set(["T1"]))[0]?.state, "active");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("approval pruning removes only the approved task's superseded logs", () => {
  const { cwd, board } = fixture();
  try {
    const result = pruneTaskLogs(
      cwd,
      "T1",
      () => board,
      () => false
    );
    assert.deepEqual(result.removed.map((entry) => entry.file.split("/").at(-1)).sort(), [
      "T1-attempt-1.jsonl",
      "T1-review-1-launch-1.jsonl",
    ]);
    assert.equal(
      inspectLogRetention(cwd, board).some((entry) => entry.file.endsWith("T1-attempt-2.jsonl")),
      true
    );
    assert.equal(
      inspectLogRetention(cwd, board).some((entry) =>
        entry.file.endsWith("removed-attempt-1.jsonl")
      ),
      true
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cleanup rechecks liveness immediately before deletion", () => {
  const { cwd, board, logs } = fixture();
  try {
    const file = join(logs, "removed-attempt-1.jsonl");
    let checks = 0;
    const result = cleanupStaleLogs(
      cwd,
      new Set([file]),
      () => board,
      () => ++checks === 2
    );
    assert.equal(result.removed.length, 0);
    assert.equal(result.preserved[0]?.state, "active");
    assert.equal(
      inspectLogRetention(cwd, board).some((entry) => entry.file === file),
      true
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("inspection and deletion failures are contained in bounded warnings", () => {
  const { cwd, board, logs } = fixture();
  try {
    const directoryLog = join(logs, "failure-attempt-1.jsonl");
    mkdirSync(directoryLog);
    const result = cleanupStaleLogs(
      cwd,
      new Set([directoryLog]),
      () => board,
      () => false
    );
    assert.equal(result.removed.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok((result.warnings[0]?.length ?? 0) <= 240);
    assert.equal(result.warnings[0]?.includes(cwd), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("approval pruning emits a generic warning when board reinspection fails", () => {
  const { cwd } = fixture();
  try {
    const sensitivePath = join(tmpdir(), "another-project", "credentials.json");
    const sensitivePayload = "token=retention-review-secret";
    const result = pruneTaskLogs(
      cwd,
      "T1",
      () => {
        throw new Error(`could not read ${sensitivePath}: ${sensitivePayload}`);
      },
      () => false
    );

    assert.equal(result.removed.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /^could not inspect logs due to a filesystem error$/);
    assert.equal(result.warnings[0]?.includes(sensitivePath), false);
    assert.equal(result.warnings[0]?.includes(sensitivePayload), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("archive pruning is limited to the captured board snapshot", () => {
  const { cwd, board, logs } = fixture();
  try {
    const snapshot = captureBoardLogs(cwd, board);
    const unrelated = join(logs, "unrelated-attempt-1.jsonl");
    const reusedTaskId = join(logs, "T1-attempt-99.jsonl");
    writeFileSync(unrelated, "unrelated");
    writeFileSync(reusedTaskId, "from another board using the same task id");
    const result = pruneStaleLogs(
      cwd,
      snapshot.entries,
      () => ({ version: 1, nextTaskNumber: 1, tasks: [] }),
      () => false
    );
    assert.equal(
      result.removed.some((entry) => entry.file === unrelated),
      false
    );
    assert.equal(
      inspectLogRetention(cwd, board).some((entry) => entry.file === unrelated),
      true
    );
    assert.equal(
      inspectLogRetention(cwd, board).some((entry) => entry.file === reusedTaskId),
      true
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("archive capture does not claim a reused task id's review log without review evidence", () => {
  const { cwd, board, logs } = fixture();
  try {
    const collidingReview = join(logs, "T1-review-1.jsonl");
    writeFileSync(collidingReview, "review from an older board that also used T1");

    const snapshot = captureBoardLogs(cwd, board);
    assert.equal(
      snapshot.entries.some((entry) => entry.file === collidingReview),
      false
    );

    const result = pruneStaleLogs(
      cwd,
      snapshot.entries,
      () => ({ version: 1, nextTaskNumber: 1, tasks: [] }),
      () => false
    );
    assert.equal(
      result.removed.some((entry) => entry.file === collidingReview),
      false
    );
    assert.equal(
      inspectLogRetention(cwd, board).some((entry) => entry.file === collidingReview),
      true
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("archive capture includes review logs backed by persisted launch evidence", () => {
  const { cwd, board, task, logs } = fixture();
  try {
    const attempt = task.attempts[0];
    assert.ok(attempt);
    attempt.reviewLaunches = [
      { startedAt: 1, usage: { input: 0, output: 0, cost: 0, turns: 0 }, exitCode: 0 },
    ];

    const snapshot = captureBoardLogs(cwd, board);
    assert.equal(
      snapshot.entries.some((entry) => entry.file === join(logs, "T1-review-1-launch-1.jsonl")),
      true
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("confirmed cleanup rechecks removed-board live runs and deletes only confirmed candidates", () => {
  const { cwd, board, logs } = fixture();
  try {
    const removed = join(logs, "removed-attempt-1.jsonl");
    const older = join(logs, "T1-attempt-1.jsonl");
    const result = cleanupStaleLogs(
      cwd,
      new Set([removed, older]),
      () => board,
      (id) => id === "removed"
    );
    assert.deepEqual(
      result.removed.map((entry) => entry.file),
      [older]
    );
    assert.equal(
      result.preserved.some((entry) => entry.file === removed && entry.state === "active"),
      true
    );
    assert.equal(
      inspectLogRetention(cwd, board).some(
        (entry) => entry.file === join(logs, "T1-review-1-launch-1.jsonl")
      ),
      true
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
