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
  applyPlanTaskEdits,
  approvePlan,
  archiveBoard,
  attemptFailureCause,
  blockedReason,
  createTask,
  filterTasksByGroup,
  findTask,
  forceStatus,
  groupTasks,
  isRunnable,
  loadBoard,
  loadStatusHistory,
  rejectPlan,
  restoreArchivedBoard,
  saveBoard,
  setStatus,
  taskFailureCause,
  taskGroup,
  transition,
  updateTask,
  validatePlan,
} from "../src/board.js";
import { type Attempt, type Board, type TaskStatus } from "../src/types.js";

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

test("isRunnable refuses every task while plan approval is pending", () => {
  const board = emptyBoard();
  const task = createTask(board, { title: "A", brief: "do a", tier: "standard" });
  board.planPending = true;

  assert.equal(isRunnable(board, task), false);
  assert.equal(isRunnable(board, task, true), false);
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

test("failure causes distinguish provider, executor, cost cap, review rejection, and abort", () => {
  const attempt = (overrides: Partial<Attempt>): Attempt => ({
    index: 1,
    logFile: "executor.log",
    thinking: "medium",
    startedAt: 1,
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
    ...overrides,
  });

  assert.equal(attemptFailureCause(attempt({ providerFailure: true })), "provider_failure");
  assert.equal(
    attemptFailureCause(attempt({ errorMessage: "primary provider unavailable", exitCode: 1 })),
    "provider_failure"
  );
  assert.equal(attemptFailureCause(attempt({ exitCode: 1 })), "executor_failure");
  assert.equal(
    attemptFailureCause(attempt({ errorMessage: "cost cap exceeded: $2 > $1" })),
    "cost_cap"
  );

  const board = emptyBoard();
  const task = createTask(board, { title: "A", brief: "a", tier: "standard" });
  forceStatus(task, "changes_requested");
  assert.equal(taskFailureCause(task), "reviewer_rejection");
  forceStatus(task, "cancelled");
  assert.equal(taskFailureCause(task), "user_abort");
  forceStatus(task, "failed");
  task.attempts.push(
    attempt({
      errorMessage: "tests failed",
      usage: { input: 100, output: 20, cost: 0.01, turns: 1 },
    })
  );
  assert.equal(taskFailureCause(task), "executor_failure");
});

test("tasks can be classified, filtered, and grouped by board state", () => {
  const board = emptyBoard();
  const dependency = createTask(board, { title: "Dependency", brief: "a", tier: "standard" });
  const blocked = createTask(board, {
    title: "Blocked",
    brief: "b",
    tier: "standard",
    dependsOn: [dependency.id],
  });
  const ready = createTask(board, { title: "Ready", brief: "c", tier: "standard" });
  const statuses: [TaskStatus, string][] = [
    ["running", "running"],
    ["ready_for_review", "review-needed"],
    ["approved", "approved"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ];
  for (const [status] of statuses) {
    const task = createTask(board, { title: status, brief: status, tier: "standard" });
    forceStatus(task, status);
  }

  assert.equal(taskGroup(board, blocked), "blocked");
  assert.equal(taskGroup(board, ready), "ready");
  assert.deepEqual(
    filterTasksByGroup(board, "blocked").map((task) => task.id),
    [blocked.id]
  );

  const groups = groupTasks(board);
  assert.deepEqual(
    groups.ready.map((task) => task.id),
    [dependency.id, ready.id]
  );
  for (const [, group] of statuses) assert.equal(groups[group as keyof typeof groups].length, 1);
});

test("validatePlan reports missing dependency references and dependency cycles", () => {
  const board = emptyBoard();
  const first = createTask(board, {
    title: "First",
    brief: "a",
    tier: "standard",
    dependsOn: ["T2", "missing"],
  });
  createTask(board, {
    title: "Second",
    brief: "b",
    tier: "standard",
    dependsOn: [first.id.toLowerCase()],
  });
  createTask(board, {
    title: "Self cycle",
    brief: "c",
    tier: "standard",
    dependsOn: ["T3"],
  });

  assert.deepEqual(validatePlan(board), {
    missingDependencies: [{ taskId: "T1", dependencyId: "missing" }],
    dependencyCycles: [
      ["T1", "T2", "T1"],
      ["T3", "T3"],
    ],
    invalidTiers: [],
  });
});

test("validatePlan accepts an acyclic plan", () => {
  const board = emptyBoard();
  const first = createTask(board, { title: "First", brief: "a", tier: "standard" });
  createTask(board, {
    title: "Second",
    brief: "b",
    tier: "standard",
    dependsOn: [first.id],
  });

  assert.deepEqual(validatePlan(board), {
    missingDependencies: [],
    dependencyCycles: [],
    invalidTiers: [],
  });
});

test("plan edits update every editable field and can cancel or reactivate a task", () => {
  const task = createTask(emptyBoard(), { title: "Old", brief: "old brief", tier: "standard" });

  applyPlanTaskEdits(
    task,
    {
      title: " New title ",
      brief: " New brief ",
      tier: "complex",
      dependsOn: [" t2 ", "T3"],
      cancelled: true,
    },
    ["trivial", "standard", "complex"]
  );

  assert.equal(task.title, "New title");
  assert.equal(task.brief, "New brief");
  assert.equal(task.tier, "complex");
  assert.deepEqual(task.dependsOn, ["T2", "T3"]);
  assert.equal(task.status, "cancelled");

  applyPlanTaskEdits(task, { cancelled: false }, ["trivial", "standard", "complex"]);
  assert.equal(task.status, "todo");
});

test("changing the brief or tier resets the reviewer rejection counter", () => {
  const task = createTask(emptyBoard(), { title: "Task", brief: "brief", tier: "standard" });
  task.reviewRejections = 2;

  applyPlanTaskEdits(task, { tier: "complex" }, ["standard", "complex"]);
  assert.equal(task.reviewRejections, undefined);

  task.reviewRejections = 2;
  applyPlanTaskEdits(task, { brief: "reworked brief" }, ["standard", "complex"]);
  assert.equal(task.reviewRejections, undefined);
});

test("plan edits reject empty fields and unknown tiers without changing them", () => {
  const task = createTask(emptyBoard(), { title: "Title", brief: "brief", tier: "standard" });

  assert.throws(() => applyPlanTaskEdits(task, { title: " " }, ["standard"]), /title/);
  assert.throws(() => applyPlanTaskEdits(task, { brief: " " }, ["standard"]), /brief/);
  assert.throws(() => applyPlanTaskEdits(task, { tier: "huge" }, ["standard"]), /unknown tier/);
  assert.deepEqual(
    { title: task.title, brief: task.brief, tier: task.tier },
    { title: "Title", brief: "brief", tier: "standard" }
  );
});

test("approval reports invalid references, cycles, and tiers without changing the board", () => {
  const board = emptyBoard();
  board.planPending = true;
  const first = createTask(board, {
    title: "First",
    brief: "a",
    tier: "unknown",
    dependsOn: ["T2", "missing"],
  });
  createTask(board, { title: "Second", brief: "b", tier: "standard", dependsOn: [first.id] });
  const before = structuredClone(board);

  const validation = approvePlan(board, ["standard"]);

  assert.deepEqual(board, before);
  assert.deepEqual(validation.missingDependencies, [{ taskId: "T1", dependencyId: "missing" }]);
  assert.deepEqual(validation.dependencyCycles, [["T1", "T2", "T1"]]);
  assert.deepEqual(validation.invalidTiers, [{ taskId: "T1", tier: "unknown" }]);
});

test("approval clears the gate only for a valid complete plan", () => {
  const board = emptyBoard();
  board.planPending = true;
  createTask(board, { title: "First", brief: "a", tier: "standard" });

  approvePlan(board, ["standard"]);

  assert.equal(board.planPending, false);
});

test("rejectPlan archives the gated plan before clearing the board", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-reject-plan-test-"));
  try {
    const board = emptyBoard();
    board.planPending = true;
    createTask(board, { title: "First", brief: "a", tier: "standard" });
    saveBoard(cwd, board);

    const archivePath = rejectPlan(cwd);

    assert.ok(archivePath);
    const archived = JSON.parse(readFileSync(archivePath, "utf-8")) as Board;
    assert.equal(archived.planPending, true);
    assert.equal(archived.tasks[0]?.title, "First");
    assert.deepEqual(loadBoard(cwd).tasks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
    board.planPending = true;
    createTask(board, { title: "A", brief: "do a", tier: "complex" });
    saveBoard(cwd, board);
    assert.equal(board.revision, 1);

    saveBoard(cwd, board);
    assert.equal(board.revision, 2);

    const loaded = loadBoard(cwd);
    assert.equal(loaded.tasks.length, 1);
    assert.equal(loaded.planPending, true);
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

test("restoreArchivedBoard makes the selected board live and archives the current board", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const selected = emptyBoard();
    createTask(selected, { title: "Archived", brief: "old work", tier: "standard" });
    saveBoard(cwd, selected);
    const selectedFile = archiveBoard(cwd);
    assert.ok(selectedFile);

    const current = emptyBoard();
    createTask(current, { title: "Current", brief: "new work", tier: "complex" });
    saveBoard(cwd, current);

    const restored = restoreArchivedBoard(cwd, selectedFile);

    assert.equal(loadBoard(cwd).tasks[0]?.title, "Archived");
    assert.ok(restored.archivedCurrent);
    const preRestore = JSON.parse(readFileSync(restored.archivedCurrent, "utf-8")) as Board;
    assert.equal(preRestore.tasks[0]?.title, "Current");
    assert.equal(restored.selectedFile, selectedFile);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("restoreArchivedBoard rejects malformed and non-Board files without replacing live board", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const current = emptyBoard();
    createTask(current, { title: "Current", brief: "work", tier: "standard" });
    saveBoard(cwd, current);
    const directory = join(cwd, ".pi", "maestro", "archive");
    mkdirSync(directory, { recursive: true });

    const invalidArchives: [string, string][] = [
      ["malformed-board.json", "not json"],
      ["object-board.json", JSON.stringify({ tasks: [] })],
    ];
    for (const [name, contents] of invalidArchives) {
      const file = join(directory, name);
      writeFileSync(file, contents);
      assert.throws(() => restoreArchivedBoard(cwd, file), /not a valid maestro board/);
      assert.equal(loadBoard(cwd).tasks[0]?.title, "Current");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("restoreArchivedBoard rejects invalid optional Attempt fields without replacing live board", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const current = emptyBoard();
    createTask(current, { title: "Current", brief: "work", tier: "standard" });
    saveBoard(cwd, current);

    const archived = emptyBoard();
    const archivedTask = createTask(archived, {
      title: "Archived",
      brief: "old work",
      tier: "standard",
    });
    archivedTask.attempts.push({
      index: 1,
      logFile: "executor.log",
      thinking: "high",
      startedAt: 1,
      usage: { input: 1, output: 2, cost: 0.01, turns: 3 },
      touchedFiles: [],
    });

    const invalidOptionalFields: [string, unknown][] = [
      ["sessionFile", 1],
      ["sessionDir", 1],
      ["model", 1],
      ["provider", 1],
      ["endedAt", "1"],
      ["exitCode", "0"],
      ["errorMessage", 1],
      ["failureReason", { kind: "unknown", message: "x", retryable: true }],
      ["consumesAttempt", "false"],
      ["providerFailure", "false"],
      ["finalReport", 1],
      ["diff", 1],
      ["worktreePath", 1],
      ["branch", 1],
      ["reviewReport", 1],
      ["reviewNotes", 1],
      ["reviewModel", 1],
      ["reviewProvider", 1],
      ["reviewLaunches", [{ startedAt: 1, usage: { input: 1 } }]],
      ["reviewUsage", { input: 1 }],
      ["reviewSessionFile", 1],
    ];
    const directory = join(cwd, ".pi", "maestro", "archive");
    mkdirSync(directory, { recursive: true });

    for (const [field, invalidValue] of invalidOptionalFields) {
      const invalidBoard = structuredClone(archived);
      Object.assign(invalidBoard.tasks[0]?.attempts[0] as object, { [field]: invalidValue });
      const file = join(directory, `${field}-board.json`);
      writeFileSync(file, JSON.stringify(invalidBoard));

      assert.throws(() => restoreArchivedBoard(cwd, file), /not a valid maestro board/, field);
      assert.equal(loadBoard(cwd).tasks[0]?.title, "Current", field);
    }
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
