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
  formatDriveSummary,
  reviewTask,
  type StartExecutor,
  sessionLabel,
  snapshot,
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
  statusWaitSeconds: 60,
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

test("sessionLabel numbers attempts and reviews while preserving the label format", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const task = createTask(board, {
    title: "A deliberately long title that exceeds forty characters",
    brief: "x",
    tier: "standard",
  });

  assert.equal(
    sessionLabel(task, "attempt", 1),
    "T1 A deliberately long title that exceeds f… · attempt 1"
  );
  assert.equal(
    sessionLabel(task, "attempt", 2),
    "T1 A deliberately long title that exceeds f… · attempt 2"
  );
  assert.equal(
    sessionLabel(task, "review", 1),
    "T1 A deliberately long title that exceeds f… · review 1"
  );
  assert.equal(
    sessionLabel(task, "review", 2),
    "T1 A deliberately long title that exceeds f… · review 2"
  );
});

test("formatDriveSummary reports outcomes, attempts, meaningful cost, and identities", () => {
  const summary = formatDriveSummary({
    rounds: 2,
    tasks: [
      {
        id: "T1",
        title: "Done",
        status: "approved",
        tier: "standard",
        attempts: 2,
        cost: 0.06,
        turns: 3,
        history: [
          {
            attempt: 1,
            model: "openai/gpt-5",
            provider: "openai",
            turns: 0,
            cost: 0,
            touchedFiles: [],
          },
          {
            attempt: 2,
            reviewModel: "anthropic/claude",
            reviewProvider: "anthropic",
            turns: 3,
            cost: 0.06,
            touchedFiles: [],
          },
        ],
      },
      {
        id: "T2",
        title: "Failed",
        status: "failed",
        tier: "standard",
        attempts: 0,
        cost: 0,
        turns: 0,
        history: [],
      },
      {
        id: "T3",
        title: "Waiting",
        status: "todo",
        tier: "standard",
        attempts: 0,
        cost: 0,
        turns: 0,
        history: [],
      },
    ],
    stoppedBecause: { code: "blocked", message: "dependency unavailable" },
  });

  assert.match(summary, /1 approved · 1 failed · 0 cancelled · 1 blocked/);
  assert.match(summary, /2 attempts · \$0\.0600 total · \$0\.0600 avg billed attempt/);
  assert.match(summary, /models: openai\/gpt-5, anthropic\/claude/);
  assert.match(summary, /providers: openai, anthropic/);
  assert.match(summary, /dependency unavailable$/);
});

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

test("driveBoard summary reports only the selected task scope", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-drive-scope-test-"));
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const target = createTask(board, {
      title: "Driven task",
      brief: "Do the driven work",
      tier: "standard",
    });
    const bystander = createTask(board, {
      title: "Untouched task",
      brief: "Should not appear in the summary",
      tier: "standard",
    });
    forceStatus(bystander, "failed");
    saveBoard(cwd, board);

    const summary = await driveBoard({
      cwd,
      config,
      resolvedTiers: new Map([
        ["standard", tier],
        ["review", tier],
      ]),
      taskIds: [target.id],
      startExecutor: executor({ finalReport: "Verified.\nVERDICT: APPROVE" }),
      onUpdate,
      trackRun,
    });

    assert.equal(summary.stoppedBecause.code, "completed");
    assert.deepEqual(
      summary.tasks.map((task) => task.id),
      [target.id]
    );
    assert.match(formatDriveSummary(summary), /1 approved · 0 failed · 0 cancelled · 0 blocked/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("driveBoard normalizes scoped task ids and still dispatches them", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-drive-normalize-test-"));
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const task = createTask(board, {
      title: "Scoped task",
      brief: "Run me by lowercase id",
      tier: "standard",
    });
    saveBoard(cwd, board);

    let dispatches = 0;
    const startExecutor: StartExecutor = (options) => {
      dispatches += 1;
      return executor({
        usage: { input: 0, output: 0, cost: 0, turns: 1 },
        finalReport: options.prompt.includes("adversarial code reviewer")
          ? "Verified.\nVERDICT: APPROVE"
          : "Work completed",
      })(options);
    };

    const result = await driveBoard({
      cwd,
      config,
      resolvedTiers: new Map([
        ["standard", tier],
        ["review", tier],
      ]),
      taskIds: [` ${task.id.toLowerCase()} `],
      startExecutor,
      onUpdate,
      trackRun,
    });

    assert.ok(dispatches > 0, "expected the scoped task to be dispatched");
    assert.equal(result.stoppedBecause.code, "completed");
    assert.deepEqual(
      result.tasks.map((entry) => [entry.id, entry.status]),
      [[task.id, "approved"]]
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("driveBoard pauses after active executors finish and resumes from fresh board state", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-drive-pause-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);
    let pauseRequested = false;
    let activeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      activeStarted = resolve;
    });
    let finishActive!: (outcome: RunOutcome) => void;
    const activeOutcome = new Promise<RunOutcome>((resolve) => {
      finishActive = resolve;
    });
    let abortCalls = 0;
    const activeExecutor: StartExecutor = () => {
      activeStarted();
      return {
        attempt: attempt(),
        outcome: activeOutcome,
        steer: () => {},
        abort: () => {
          abortCalls += 1;
        },
      };
    };

    const pausedRun = driveBoard({
      cwd,
      config,
      resolvedTiers: new Map([
        ["standard", tier],
        ["review", tier],
      ]),
      startExecutor: activeExecutor,
      shouldPause: () => pauseRequested,
      onUpdate,
      trackRun,
    });
    await started;
    pauseRequested = true;
    finishActive({
      exitCode: 0,
      usage: { input: 1, output: 1, cost: 0, turns: 1 },
      finalReport: "Work completed",
      touchedFiles: [],
      aborted: false,
    });

    const paused = await pausedRun;
    assert.equal(paused.stoppedBecause.code, "paused");
    assert.equal(paused.rounds, 1);
    assert.equal(abortCalls, 0, "pause must not abort an active executor");
    assert.equal(findTask(loadBoard(cwd), task.id)?.status, "ready_for_review");

    const resumed = await driveBoard({
      cwd,
      config,
      resolvedTiers: new Map([
        ["standard", tier],
        ["review", tier],
      ]),
      startExecutor: executor({ finalReport: "Verified.\nVERDICT: APPROVE" }),
      onUpdate,
      trackRun,
    });
    assert.equal(resumed.stoppedBecause.code, "completed");
    assert.equal(resumed.rounds, 1);
    assert.equal(findTask(loadBoard(cwd), task.id)?.status, "approved");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("driveBoard aborts active executors through the existing AbortSignal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-drive-abort-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);
    const controller = new AbortController();
    let activeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      activeStarted = resolve;
    });
    const abortingExecutor: StartExecutor = (options) => {
      activeStarted();
      const outcome = new Promise<RunOutcome>((resolve) => {
        options.signal?.addEventListener("abort", () => {
          resolve({
            exitCode: 1,
            usage: { input: 0, output: 0, cost: 0, turns: 0 },
            finalReport: "",
            touchedFiles: [],
            aborted: true,
          });
        });
      });
      return { attempt: attempt(), outcome, steer: () => {}, abort: () => {} };
    };

    const running = driveBoard({
      cwd,
      config,
      resolvedTiers: new Map([
        ["standard", tier],
        ["review", tier],
      ]),
      startExecutor: abortingExecutor,
      signal: controller.signal,
      onUpdate,
      trackRun,
    });
    await started;
    controller.abort();

    const result = await running;
    assert.equal(result.stoppedBecause.code, "aborted");
    assert.equal(findTask(loadBoard(cwd), task.id)?.status, "cancelled");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("driveBoard gives plan gates precedence and rechecks cost caps after pause", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-drive-gates-test-"));
  try {
    const { board, task } = boardWithTask();
    board.planPending = true;
    const costly = attempt();
    costly.usage.cost = 2;
    task.attempts.push(costly);
    saveBoard(cwd, board);
    const options = {
      cwd,
      config: { ...config, maxRunCost: 1 },
      resolvedTiers: new Map([
        ["standard", tier],
        ["review", tier],
      ]),
      startExecutor: executor({}),
      onUpdate,
      trackRun,
    };

    const gated = await driveBoard({ ...options, shouldPause: () => true });
    assert.equal(gated.stoppedBecause.code, "plan_gate");
    assert.equal(gated.rounds, 0);

    const approvedPlan = loadBoard(cwd);
    approvedPlan.planPending = false;
    saveBoard(cwd, approvedPlan);
    const paused = await driveBoard({ ...options, shouldPause: () => true });
    assert.equal(paused.stoppedBecause.code, "paused");
    assert.equal(paused.rounds, 0);

    const budgetBlocked = await driveBoard(options);
    assert.equal(budgetBlocked.stoppedBecause.code, "budget_blocked");
    assert.equal(findTask(loadBoard(cwd), task.id)?.attempts.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("driveBoard blocks invalid plans before dispatch and leaves the board unchanged", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-drive-invalid-plan-test-"));
  try {
    const { board, task } = boardWithTask();
    task.dependsOn = ["T2"];
    createTask(board, {
      title: "Cycle",
      brief: "work",
      tier: "unknown",
      dependsOn: [task.id],
    });
    saveBoard(cwd, board);
    const before = loadBoard(cwd);
    let dispatches = 0;

    const result = await driveBoard({
      cwd,
      config,
      resolvedTiers: new Map([["standard", tier]]),
      startExecutor: () => {
        dispatches += 1;
        return executor({})({
          stateDir: cwd,
          runId: "unused",
          cwd,
          prompt: "unused",
          tier,
          sessionLabel: "unused",
          onUpdate: () => {},
        });
      },
      onUpdate,
      trackRun,
    });

    assert.equal(result.stoppedBecause.code, "error");
    assert.match(result.stoppedBecause.message, /dependency cycle: T1 → T2 → T1/);
    assert.match(result.stoppedBecause.message, /T2 uses unknown tier "unknown"/);
    assert.equal(dispatches, 0);
    assert.deepEqual(loadBoard(cwd), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejected executor outcomes persist a redacted failure and return a retryable snapshot", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-drive-cleanup-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);
    let tracked = 0;
    const result = await driveBoard({
      cwd,
      config: { ...config, maxAttempts: 1 },
      resolvedTiers: new Map([
        ["standard", tier],
        ["review", tier],
      ]),
      startExecutor: () => {
        const runAttempt = attempt();
        runAttempt.model = "acme/executor";
        runAttempt.usage = { input: 8, output: 3, cost: 0.04, turns: 1 };
        runAttempt.touchedFiles = ["src/rejected.ts"];
        return {
          attempt: runAttempt,
          outcome: Promise.reject(new Error("executor promise failed token=top-secret")),
          steer: () => {},
          abort: () => {},
        };
      },
      onUpdate,
      trackRun: () => {
        tracked += 1;
        return () => {
          tracked -= 1;
        };
      },
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    const failed = result.tasks.find((item) => item.id === task.id);
    assert.equal(result.stoppedBecause.code, "attempt_cap");
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.attempts[0]?.failureReason?.kind, "executor_failure");
    assert.equal(
      persisted?.attempts[0]?.failureReason?.message,
      "executor promise failed token=[REDACTED]"
    );
    assert.equal(failed?.history[0]?.cost, 0.04);
    assert.equal(failed?.history[0]?.turns, 1);
    assert.deepEqual(failed?.history[0]?.touchedFiles, ["src/rejected.ts"]);
    assert.equal(failed?.history[0]?.model, "acme/executor");
    assert.equal(failed?.history[0]?.provider, "acme");
    assert.equal(failed?.retryAction, 'maestro_run ["T1"]');
    assert.match(failed?.note ?? "", /executor promise failed token=\[REDACTED\]/);
    assert.equal(tracked, 0);
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
      startExecutor: executor({
        exitCode: 1,
        errorMessage: "stub executor failed",
        usage: { input: 10, output: 2, cost: 0.02, turns: 1 },
        touchedFiles: ["src/failure.ts"],
        model: "acme/test-model",
      }),
      onUpdate,
      trackRun,
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.attempts[0]?.failureReason?.kind, "executor_failure");
    assert.equal(persisted?.attempts[0]?.usage.cost, 0.02);
    assert.deepEqual(persisted?.attempts[0]?.touchedFiles, ["src/failure.ts"]);
    assert.equal(persisted?.attempts[0]?.model, "acme/test-model");
    assert.equal(persisted?.attempts[0]?.provider, "acme");
    assert.match(result.note ?? "", /stub executor failed/);
    assert.match(result.note ?? "", /Retry: maestro_run \["T1"\]/);
    assert.equal(result.retryAction, 'maestro_run ["T1"]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("user abort persists a retryable structured reason", async () => {
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
      startExecutor: executor({ exitCode: 1, aborted: true }),
      onUpdate,
      trackRun,
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(persisted?.status, "cancelled");
    assert.equal(persisted?.attempts[0]?.failureReason?.kind, "user_abort");
    assert.equal(result.retryAction, 'maestro_run ["T1"]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cost-cap failure is not recorded as a user abort", async () => {
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
      startExecutor: executor({
        exitCode: 1,
        aborted: false,
        errorMessage: "cost cap exceeded: $0.1200 > $0.1 (maxCostPerTask)",
        usage: { input: 20, output: 5, cost: 0.12, turns: 1 },
      }),
      onUpdate,
      trackRun,
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.attempts[0]?.failureReason?.kind, "cost_cap");
    assert.equal(persisted?.attempts[0]?.usage.cost, 0.12);
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
    assert.equal(persisted?.attempts[0]?.failureReason?.kind, "provider_failure");
    assert.equal(persisted?.attempts[0]?.provider, "provider");
    assert.equal(persisted?.attempts[1]?.usage.turns, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("zero-turn process failure keeps its cause while using configured fallback accounting", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-process-fallback-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);
    let calls = 0;
    const processThenSuccess: StartExecutor = (options) => {
      calls += 1;
      if (calls === 1) {
        return executor({
          exitCode: 1,
          errorMessage: "spawn pi ENOENT",
          failureCause: "process",
        })(options);
      }
      return executor({
        finalReport: "fallback succeeded",
        usage: { input: 1, output: 1, cost: 0.01, turns: 1 },
      })(options);
    };

    const result = await executeTask({
      cwd,
      board,
      task,
      tier: { model: "provider/primary", fallbacks: ["provider/fallback"], thinking: "low" },
      config: { ...config, maxAttempts: 1 },
      startExecutor: processThenSuccess,
      onUpdate,
      trackRun,
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(calls, 2, "zero-turn failure should retain existing fallback behavior");
    assert.equal(result.status, "ready_for_review");
    assert.equal(persisted?.attempts[0]?.providerFailure, true);
    assert.equal(persisted?.attempts[0]?.failureReason?.kind, "executor_failure");
    assert.equal(persisted?.attempts[0]?.failureReason?.message, "spawn pi ENOENT");
    assert.equal(persisted?.attempts.filter((item) => !item.providerFailure).length, 1);
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

test("rejected reviewer outcomes persist a redacted failure and return a retryable snapshot", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-review-rejection-test-"));
  try {
    const { board, task } = boardWithTask("ready_for_review");
    const completed = attempt("Executor completed the task");
    completed.index = 1;
    completed.usage = { input: 10, output: 4, cost: 0.03, turns: 2 };
    completed.touchedFiles = ["src/executor.ts"];
    task.attempts.push(completed);
    saveBoard(cwd, board);
    let tracked = 0;

    const result = await reviewTask({
      cwd,
      task,
      tier,
      startExecutor: () => {
        const reviewAttempt = attempt();
        reviewAttempt.model = "reviewco/model";
        reviewAttempt.usage = { input: 5, output: 2, cost: 0.02, turns: 1 };
        return {
          attempt: reviewAttempt,
          outcome: Promise.reject(new Error("review promise failed secret=hunter2")),
          steer: () => {},
          abort: () => {},
        };
      },
      onUpdate,
      trackRun: () => {
        tracked += 1;
        return () => {
          tracked -= 1;
        };
      },
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(persisted?.status, "ready_for_review");
    assert.equal(persisted?.attempts[0]?.failureReason?.kind, "reviewer_failure");
    assert.equal(
      persisted?.attempts[0]?.failureReason?.message,
      "review promise failed secret=[REDACTED]"
    );
    assert.deepEqual(persisted?.attempts[0]?.reviewUsage, {
      input: 5,
      output: 2,
      cost: 0.02,
      turns: 1,
    });
    assert.equal(persisted?.attempts[0]?.usage.cost, 0.05);
    assert.deepEqual(persisted?.attempts[0]?.touchedFiles, ["src/executor.ts"]);
    assert.equal(persisted?.attempts[0]?.reviewModel, "reviewco/model");
    assert.equal(persisted?.attempts[0]?.reviewProvider, "reviewco");
    assert.equal(result.history[0]?.failureReason?.kind, "reviewer_failure");
    assert.equal(result.retryAction, 'maestro_review ["T1"]');
    assert.match(result.note ?? "", /review promise failed secret=\[REDACTED\]/);
    assert.equal(tracked, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("production-shaped reviewer failure is reclassified and stays reviewable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-workflow-test-"));
  try {
    const { board, task } = boardWithTask("ready_for_review");
    task.attempts.push(attempt("Executor completed the task"));
    saveBoard(cwd, board);
    const executorReason = {
      kind: "executor_failure" as const,
      message: "review process failed",
      retryable: true,
    };
    const reviewerExecutor: StartExecutor = (options) => {
      const run = executor({
        exitCode: 1,
        errorMessage: "review process failed",
        failureCause: "process",
        failureReason: executorReason,
        usage: { input: 2, output: 1, cost: 0.01, turns: 1 },
      })(options);
      run.attempt.failureReason = executorReason;
      return run;
    };

    const result = await reviewTask({
      cwd,
      task,
      tier,
      startExecutor: reviewerExecutor,
      onUpdate,
      trackRun,
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(persisted?.status, "ready_for_review");
    assert.equal(persisted?.attempts[0]?.failureReason?.kind, "reviewer_failure");
    assert.equal(result.retryAction, 'maestro_review ["T1"]');
    assert.match(result.note ?? "", /review process failed/);
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
    assert.equal(persisted?.attempts[0]?.reviewNotes, notes);
    assert.equal(persisted?.attempts[0]?.failureReason?.kind, "reviewer_rejection");
    const snap = snapshot(persisted as Task);
    assert.equal(snap.retryAction, 'maestro_run ["T1"]');
    assert.match(snap.note ?? "", /Fix src\/example\.ts behavior/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("retry receives reviewer notes and preserves prior attempt history", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-retry-test-"));
  try {
    const { board, task } = boardWithTask("ready_for_review");
    const first = attempt("Initial implementation");
    first.index = 1;
    first.model = "provider-a/model-a";
    first.provider = "provider-a";
    first.usage = { input: 10, output: 5, cost: 0.04, turns: 2 };
    first.touchedFiles = ["src/initial.ts"];
    task.attempts.push(first);
    saveBoard(cwd, board);
    const notes = "Add a regression test for the retry path.";

    await reviewTask({
      cwd,
      task,
      tier,
      startExecutor: executor({
        finalReport: `VERDICT: REQUEST_CHANGES\n${notes}`,
        usage: { input: 3, output: 2, cost: 0.01, turns: 1 },
      }),
      onUpdate,
      trackRun,
    });

    const rejected = findTask(loadBoard(cwd), task.id) as Task;
    let retryPrompt = "";
    await executeTask({
      cwd,
      board: loadBoard(cwd),
      task: rejected,
      tier: { thinking: "low", model: "provider-b/model-b" },
      config,
      startExecutor: (options) => {
        retryPrompt = options.prompt;
        return executor({
          finalReport: "Retry completed",
          model: "provider-b/model-b",
          usage: { input: 8, output: 4, cost: 0.03, turns: 2 },
          touchedFiles: ["test/retry.test.ts"],
        })(options);
      },
      onUpdate,
      trackRun,
    });

    assert.match(retryPrompt, /Add a regression test for the retry path/);
    const persisted = findTask(loadBoard(cwd), task.id) as Task;
    assert.equal(persisted.attempts.length, 2);
    assert.equal(persisted.attempts[0]?.reviewNotes, notes);
    assert.equal(persisted.attempts[0]?.usage.cost, 0.05);
    assert.deepEqual(persisted.attempts[0]?.touchedFiles, ["src/initial.ts"]);
    assert.equal(persisted.attempts[1]?.index, 2);
    assert.equal(persisted.attempts[1]?.provider, "provider-b");
    assert.equal(persisted.attempts[1]?.usage.cost, 0.03);
    assert.deepEqual(persisted.attempts[1]?.touchedFiles, ["test/retry.test.ts"]);
    assert.deepEqual(
      snapshot(persisted).history.map((item) => [item.attempt, item.cost, item.touchedFiles]),
      [
        [1, 0.05, ["src/initial.ts"]],
        [2, 0.03, ["test/retry.test.ts"]],
      ]
    );
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

test("mid-run quota exhaustion falls back to the next model without consuming attempts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-quota-test-"));
  try {
    const { board, task } = boardWithTask();
    saveBoard(cwd, board);

    let calls = 0;
    const flaky: StartExecutor = (options) => {
      calls += 1;
      const failing = calls === 1;
      const result: RunOutcome = failing
        ? {
            exitCode: 1,
            usage: { input: 100, output: 50, cost: 0.01, turns: 3 },
            finalReport: "",
            touchedFiles: [],
            aborted: false,
            errorMessage: "Codex error: The usage limit has been reached",
          }
        : {
            exitCode: 0,
            usage: { input: 100, output: 50, cost: 0.01, turns: 2 },
            finalReport: "done",
            touchedFiles: [],
            aborted: false,
          };
      return {
        attempt: { ...attempt(), model: options.tier.model ?? "" },
        outcome: Promise.resolve(result),
        steer: () => {},
        abort: () => {},
      };
    };

    const snap = await executeTask({
      cwd,
      board,
      task,
      tier: { thinking: "low", model: "provider-a/model-a", fallbacks: ["provider-b/model-b"] },
      config,
      startExecutor: flaky,
      onUpdate,
      trackRun,
    });

    assert.equal(calls, 2, "fallback model should have been tried");
    assert.equal(snap.status, "ready_for_review");
    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(persisted?.attempts.filter((a) => !a.providerFailure).length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
