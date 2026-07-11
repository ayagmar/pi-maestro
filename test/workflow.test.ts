import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTask, findTask, forceStatus, loadBoard, saveBoard } from "../src/board.js";
import { type ExecutorHandle, type RunOutcome } from "../src/runner.js";
import { type Attempt, type Board, type MaestroConfig, type Task } from "../src/types.js";
import { executeTask, reviewTask, type StartExecutor } from "../src/workflow.js";

const tier = { thinking: "low" };
const config: MaestroConfig = {
  maxParallel: 1,
  maxAttempts: 3,
  maxCostPerTask: 0,
  tiers: { standard: tier },
};

function attempt(finalReport?: string): Attempt {
  const result: Attempt = {
    index: 0,
    logFile: "stub.jsonl",
    thinking: "low",
    startedAt: Date.now(),
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
  };
  if (finalReport !== undefined) result.finalReport = finalReport;
  return result;
}

function executor(outcome: Partial<RunOutcome>): StartExecutor {
  return () => {
    const result: RunOutcome = {
      exitCode: 0,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      finalReport: "executor report",
      touchedFiles: [],
      aborted: false,
      ...outcome,
    };
    const handle: ExecutorHandle = {
      attempt: attempt(),
      outcome: Promise.resolve(result),
      steer: () => {},
      abort: () => {},
    };
    return handle;
  };
}

function boardWithTask(status: Task["status"] = "todo"): { board: Board; task: Task } {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const task = createTask(board, { title: "Test task", brief: "Do the work", tier: "standard" });
  forceStatus(task, status);
  return { board, task };
}

const onUpdate = () => {};
const trackRun = () => () => {};

test("successful execution persists ready_for_review", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-workflow-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);

    await executeTask({
      cwd,
      board,
      task,
      tier,
      config,
      startExecutor: executor({ finalReport: "Work completed" }),
      onUpdate,
      trackRun,
    });

    assert.equal(findTask(loadBoard(cwd), task.id)?.status, "ready_for_review");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("failed execution persists failed status and returns the error note", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-workflow-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);

    const result = await executeTask({
      cwd,
      board,
      task,
      tier,
      config,
      startExecutor: executor({ exitCode: 1, errorMessage: "stub executor failed" }),
      onUpdate,
      trackRun,
    });

    assert.equal(findTask(loadBoard(cwd), task.id)?.status, "failed");
    assert.equal(result.note, "stub executor failed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("approved review persists approved status and clears review notes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-workflow-test-"));
  try {
    const { board, task } = boardWithTask("ready_for_review");
    task.reviewNotes = "Previous findings";
    task.attempts.push(attempt("Executor completed the task"));
    saveBoard(cwd, board);

    await reviewTask({
      cwd,
      task,
      tier,
      startExecutor: executor({ finalReport: "Everything is correct.\nVERDICT: APPROVE" }),
      onUpdate,
      trackRun,
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(persisted?.status, "approved");
    assert.equal(persisted?.reviewNotes, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("requested changes persist changes_requested status and reviewer notes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-workflow-test-"));
  try {
    const { board, task } = boardWithTask("ready_for_review");
    task.attempts.push(attempt("Executor completed the task"));
    saveBoard(cwd, board);
    const notes = "1. Fix src/example.ts behavior.";

    await reviewTask({
      cwd,
      task,
      tier,
      startExecutor: executor({ finalReport: `VERDICT: REQUEST_CHANGES\n${notes}` }),
      onUpdate,
      trackRun,
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(persisted?.status, "changes_requested");
    assert.equal(persisted?.reviewNotes, notes);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
