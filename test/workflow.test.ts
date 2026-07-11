import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTask, findTask, forceStatus, loadBoard, saveBoard } from "../src/board.js";
import { type ExecutorHandle, type RunOutcome } from "../src/runner.js";
import { type Attempt, type Board, type MaestroConfig, type Task } from "../src/types.js";
import {
  driveBoard,
  executeTask,
  reviewTask,
  type StartExecutor,
  taskCommitMessage,
} from "../src/workflow.js";

const tier = { thinking: "low" };
const config: MaestroConfig = {
  maxParallel: 1,
  planGate: false,
  useWorktrees: false,
  autoCommit: false,
  maxAttempts: 3,
  maxCostPerTask: 0,
  maxRunCost: 0,
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

test("driveBoard approves dependent tasks across multiple rounds", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-drive-test-"));
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const first = createTask(board, {
      title: "First task",
      brief: "Complete the prerequisite",
      tier: "standard",
    });
    const second = createTask(board, {
      title: "Second task",
      brief: "Use the prerequisite",
      tier: "standard",
      dependsOn: [first.id],
    });
    saveBoard(cwd, board);
    const startExecutor: StartExecutor = (options) =>
      executor({
        finalReport: options.prompt.includes("adversarial code reviewer")
          ? "Verified.\nVERDICT: APPROVE"
          : "Work completed",
      })(options);

    const result = await driveBoard({
      cwd,
      config,
      resolvedTiers: new Map([
        ["standard", tier],
        ["review", tier],
      ]),
      startExecutor,
      onUpdate,
      trackRun,
    });

    assert.equal(result.rounds, 2);
    assert.equal(result.stoppedBecause.code, "completed");
    assert.deepEqual(
      result.tasks.map((task) => [task.id, task.status]),
      [
        [first.id, "approved"],
        [second.id, "approved"],
      ]
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("driveBoard stops repeated executor failures at the attempt cap", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-drive-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);

    const result = await driveBoard({
      cwd,
      config: { ...config, maxAttempts: 2 },
      resolvedTiers: new Map([
        ["standard", tier],
        ["review", tier],
      ]),
      startExecutor: executor({
        exitCode: 1,
        errorMessage: "mechanical failure",
        usage: { input: 1, output: 1, cost: 0, turns: 1 },
      }),
      onUpdate,
      trackRun,
    });

    assert.equal(result.rounds, 2);
    assert.equal(result.stoppedBecause.code, "attempt_cap");
    assert.deepEqual(result.stoppedBecause.taskIds, [task.id]);
    assert.match(result.stoppedBecause.message, /attempt cap reached \(2\)/);
    assert.equal(result.tasks[0]?.attempts, 2);
    assert.equal(result.tasks[0]?.status, "failed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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

test("successful main-tree execution captures only touched-file changes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-workflow-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@local");
    git("config", "user.name", "Test");
    writeFileSync(join(cwd, "task.txt"), "base\n");
    writeFileSync(join(cwd, "unrelated.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);

    await executeTask({
      cwd,
      board,
      task,
      tier,
      config,
      startExecutor: (options) => {
        writeFileSync(join(options.cwd, "task.txt"), "executor change\n");
        writeFileSync(join(options.cwd, "unrelated.txt"), "unrelated change\n");
        return executor({ finalReport: "Work completed", touchedFiles: ["task.txt"] })(options);
      },
      onUpdate,
      trackRun,
    });

    const diff = findTask(loadBoard(cwd), task.id)?.attempts.at(-1)?.diff ?? "";
    assert.match(diff, /executor change/);
    assert.doesNotMatch(diff, /unrelated change/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("worktree execution records metadata and starts the executor in that checkout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-workflow-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);
    const seenCwds: string[] = [];
    const startExecutor: StartExecutor = (options) => {
      seenCwds.push(options.cwd);
      return executor({ finalReport: "Work completed" })(options);
    };
    const worktree = { worktreePath: join(cwd, "task-worktree"), branch: "maestro/t1-attempt-1" };

    await executeTask({
      cwd,
      board,
      task,
      tier,
      config,
      worktree,
      startExecutor,
      onUpdate,
      trackRun,
    });

    const recorded = findTask(loadBoard(cwd), task.id)?.attempts.at(-1);
    assert.deepEqual(seenCwds, [worktree.worktreePath]);
    assert.equal(recorded?.worktreePath, worktree.worktreePath);
    assert.equal(recorded?.branch, worktree.branch);
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

test("execution forwards a dependency executor session, not its review session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-workflow-test-"));
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const dependency = createTask(board, {
      title: "Dependency",
      brief: "Complete the prerequisite",
      tier: "standard",
    });
    forceStatus(dependency, "approved");
    const dependencyAttempt = attempt("Dependency completed");
    dependencyAttempt.sessionFile = "/sessions/dependency-executor.jsonl";
    dependencyAttempt.reviewSessionFile = "/sessions/dependency-review.jsonl";
    dependency.attempts.push(dependencyAttempt);
    const task = createTask(board, {
      title: "Dependent",
      brief: "Use the prerequisite",
      tier: "standard",
      dependsOn: [dependency.id],
    });
    saveBoard(cwd, board);
    let prompt = "";

    await executeTask({
      cwd,
      board,
      task,
      tier,
      config,
      startExecutor: (options) => {
        prompt = options.prompt;
        return executor({ finalReport: "Dependent completed" })(options);
      },
      onUpdate,
      trackRun,
    });

    assert.match(
      prompt,
      /Full transcript \(read sparingly, only if this report is insufficient\): \/sessions\/dependency-executor\.jsonl/
    );
    assert.doesNotMatch(prompt, /dependency-review\.jsonl/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("zero-turn provider failure is persisted and retries on fallback without consuming maxAttempts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-workflow-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);
    const selectedModels: (string | undefined)[] = [];
    let call = 0;
    const fallbackExecutor: StartExecutor = (options) => {
      selectedModels.push(options.tier.model);
      const failed = call++ === 0;
      const usage = { input: 0, output: 0, cost: 0, turns: failed ? 0 : 1 };
      const runAttempt = attempt();
      runAttempt.usage = usage;
      return {
        attempt: runAttempt,
        outcome: Promise.resolve({
          exitCode: failed ? 1 : 0,
          usage,
          finalReport: failed ? "" : "fallback succeeded",
          touchedFiles: [],
          aborted: false,
          ...(failed ? { errorMessage: "primary provider unavailable" } : {}),
        }),
        steer: () => {},
        abort: () => {},
      };
    };

    const result = await executeTask({
      cwd,
      board,
      task,
      tier: { model: "provider/primary", fallbacks: ["provider/fallback"], thinking: "low" },
      config: { ...config, maxAttempts: 1 },
      startExecutor: fallbackExecutor,
      onUpdate,
      trackRun,
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(result.status, "ready_for_review");
    assert.deepEqual(selectedModels, ["provider/primary", "provider/fallback"]);
    assert.equal(persisted?.attempts.length, 2);
    assert.equal(persisted?.attempts[0]?.exitCode, 1);
    assert.equal(persisted?.attempts[0]?.errorMessage, "primary provider unavailable");
    assert.equal(persisted?.attempts[0]?.providerFailure, true);
    assert.equal(persisted?.attempts[1]?.usage.turns, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("nonzero-turn failures do not use a configured fallback", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-workflow-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);
    let calls = 0;
    const used = executor({
      exitCode: 1,
      usage: { input: 1, output: 1, cost: 0, turns: 1 },
      errorMessage: "task failed",
    });
    await executeTask({
      cwd,
      board,
      task,
      tier: { model: "primary", fallbacks: ["fallback"], thinking: "low" },
      config,
      startExecutor: (options) => {
        calls += 1;
        return used(options);
      },
      onUpdate,
      trackRun,
    });
    assert.equal(calls, 1);
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

test("taskCommitMessage prefers the planned message and falls back to feat: title", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const planned = createTask(board, {
    title: "Handle empty board",
    brief: "x",
    tier: "standard",
    commitMessage: "fix: handle empty board on reset",
  });
  assert.equal(taskCommitMessage(planned), "fix: handle empty board on reset");
  const bare = createTask(board, { title: "Add history command", brief: "x", tier: "standard" });
  assert.equal(taskCommitMessage(bare), "feat: add history command");
});

test("approval auto-commits the task's touched files as one conventional commit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-autocommit-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@local");
    git("config", "user.name", "Test");
    writeFileSync(join(cwd, "base.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "chore: base");

    const { board, task } = boardWithTask("ready_for_review");
    task.commitMessage = "fix: adjust the widget";
    const done = attempt("Executor completed the task");
    done.touchedFiles = ["widget.txt"];
    task.attempts.push(done);
    saveBoard(cwd, board);
    // The task's file plus an unrelated dirty file that must NOT be committed.
    writeFileSync(join(cwd, "widget.txt"), "fixed\n");
    writeFileSync(join(cwd, "unrelated.txt"), "untouched\n");

    await reviewTask({
      cwd,
      task,
      tier,
      startExecutor: executor({ finalReport: "Verified.\nVERDICT: APPROVE" }),
      autoCommit: true,
      onUpdate,
      trackRun,
    });

    assert.equal(git("log", "-1", "--pretty=%s"), "fix: adjust the widget");
    const committed = git("show", "--name-only", "--pretty=format:", "HEAD");
    assert.match(committed, /widget\.txt/);
    assert.doesNotMatch(committed, /unrelated\.txt/);
    assert.match(git("status", "--porcelain"), /unrelated\.txt/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
