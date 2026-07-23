import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureApprovedProvenance, completionFreshness } from "../src/artifact-policy.js";
import {
  applyPlanTaskEdits,
  approvePlan,
  archiveBoard,
  attemptFailureCause,
  blockedReason,
  consumeQuarantineNotice,
  createTask,
  filterTasksByGroup,
  findTask,
  forceStatus,
  groupTasks,
  humanRetryEligibility,
  humanRetryRiskToken,
  isReadOnlyTask,
  isRunnable,
  latestArchiveFile,
  listArchivedBoards,
  loadBoard,
  loadBoardView,
  loadStatusHistory,
  normalizeTaskContract,
  planValidationMessage,
  rejectPlan,
  replaceBoard,
  replaceBoardWithArchive,
  restoreArchivedBoard,
  saveBoard,
  setStatus,
  sweepDispatchState,
  taskFailureCause,
  taskGroup,
  transition,
  updateBoard,
  updateBoardAsync,
  updateTask,
  updateTaskAsync,
  validatePlan,
} from "../src/board.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { parseDiscoveryOutput } from "../src/discovery.js";
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

test("human retry eligibility is centralized across execution, review, caps, and risk", () => {
  const board = emptyBoard();
  const task = createTask(board, { title: "Retry", brief: "work", tier: "standard" });
  const eligibility = () =>
    humanRetryEligibility(board, task.id, { maxAttempts: 1, isLive: () => false });

  assert.equal(eligibility().code, "not_retryable");
  task.status = "running";
  assert.equal(eligibility().code, "active");
  task.status = "failed";
  task.attempts.push({
    index: 1,
    logFile: "provider.log",
    thinking: "low",
    startedAt: 1,
    consumesAttempt: false,
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
  });
  assert.deepEqual(
    { code: eligibility().code, kind: eligibility().kind },
    { code: "eligible", kind: "execute" }
  );
  const recorded = task.attempts[0];
  assert.ok(recorded);
  recorded.consumesAttempt = true;
  assert.equal(eligibility().code, "attempt_cap");
  assert.match(eligibility().message, /supersedesTaskId to T1/);

  task.status = "ready_for_review";
  recorded.reviewConvergence = {
    policy: "single",
    status: "operational_failure",
    requiredApprovals: 1,
    actualApprovals: 0,
    reviewerCount: 1,
    summary: "provider failed",
    decidedAt: 2,
  };
  assert.deepEqual(
    { code: eligibility().code, kind: eligibility().kind },
    { code: "eligible", kind: "review" }
  );
  recorded.reviewConvergence.status = "disagreement";
  assert.equal(eligibility().code, "review_disagreement");

  delete recorded.reviewConvergence;
  task.status = "approved";
  recorded.consumesAttempt = false;
  assert.equal(eligibility().requiresConfirmation, true);
  task.status = "failed";
  const dependency = createTask(board, { title: "Dependency", brief: "work", tier: "standard" });
  task.dependsOn = [dependency.id];
  assert.equal(eligibility().code, "dependency_blocked");
  board.planPending = true;
  assert.equal(eligibility().code, "plan_pending");
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

test("validatePlan bounds overlap examples and diagnostics", () => {
  const board = emptyBoard();
  for (let index = 0; index < 512; index += 1) {
    createTask(board, {
      title: `Task ${index}`,
      brief: "write the shared path",
      tier: "standard",
      writePaths: ["shared.txt"],
    });
  }
  const validation = validatePlan(board);
  assert.equal(validation.writePathOverlapCount, (512 * 511) / 2);
  assert.equal(validation.writePathOverlaps?.length, 100);
  const message = planValidationMessage(validation);
  assert.ok(message);
  assert.ok(message.length <= 16_000);
  assert.match(message, /additional problem/);
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
      reviewPolicy: "confirm",
      writePaths: [" src/one.ts "],
      commitMessage: " fix: update task ",
      cancelled: true,
    },
    ["trivial", "standard", "complex"]
  );

  assert.equal(task.title, "New title");
  assert.equal(task.brief, "New brief");
  assert.equal(task.tier, "complex");
  assert.deepEqual(task.dependsOn, ["T2", "T3"]);
  assert.equal(task.reviewPolicy, "confirm");
  assert.deepEqual(task.writePaths, ["src/one.ts"]);
  assert.equal(task.commitMessage, "fix: update task");
  assert.equal(task.status, "cancelled");

  applyPlanTaskEdits(task, { writePaths: [], commitMessage: "" }, ["standard"]);
  assert.deepEqual(task.writePaths, []);
  assert.equal(task.commitMessage, undefined);

  applyPlanTaskEdits(task, { cancelled: false }, ["trivial", "standard", "complex"]);
  assert.equal(task.status, "todo");
});

test("changing review policy clears only a terminal unresolved convergence marker", () => {
  const task = createTask(emptyBoard(), { title: "Task", brief: "brief", tier: "standard" });
  task.attempts.push({
    index: 1,
    logFile: "review.jsonl",
    thinking: "low",
    startedAt: 1,
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
    reviewConvergence: {
      policy: "find-and-refute",
      status: "disagreement",
      requiredApprovals: 1,
      actualApprovals: 1,
      reviewerCount: 2,
      summary: "reviewers disagreed",
      decidedAt: 2,
    },
  });

  applyPlanTaskEdits(task, { reviewPolicy: "confirm" }, ["standard"]);

  assert.equal(task.reviewPolicy, "confirm");
  assert.equal(task.attempts[0]?.reviewConvergence, undefined);
  assert.equal(task.attempts[0]?.logFile, "review.jsonl");
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

    const archivePath = rejectPlan(cwd, loadBoard(cwd).revision ?? 0);

    assert.ok(archivePath);
    const archived = JSON.parse(readFileSync(archivePath, "utf-8")) as Board;
    assert.equal(archived.planPending, true);
    assert.equal(archived.tasks[0]?.title, "First");
    assert.deepEqual(loadBoard(cwd).tasks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("whole-board replacement preserves a concurrent plan and creates no archive", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-board-replace-conflict-"));
  try {
    saveBoard(cwd, emptyBoard());
    const emptyRevision = loadBoard(cwd).revision ?? 0;
    updateBoard(cwd, (concurrent) => {
      createTask(concurrent, { title: "Concurrent", brief: "new plan", tier: "standard" });
    });

    assert.throws(
      () =>
        replaceBoard(
          cwd,
          { version: 1, nextTaskNumber: 1, goal: "stale goal", tasks: [] },
          emptyRevision
        ),
      /stale maestro board/
    );
    assert.equal(loadBoard(cwd).tasks[0]?.title, "Concurrent");
    assert.equal(listArchivedBoards(cwd).length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("archived replacement is CAS-safe and archives the exact cleared revision", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-board-archive-cas-"));
  try {
    const original = emptyBoard();
    original.goal = "original";
    createTask(original, { title: "Original", brief: "work", tier: "standard" });
    saveBoard(cwd, original);
    const snapshot = loadBoard(cwd);

    const archive = replaceBoardWithArchive(
      cwd,
      () => ({ version: 1, nextTaskNumber: 1, tasks: [] }),
      snapshot.revision ?? 0
    );

    assert.ok(archive);
    const archived = JSON.parse(readFileSync(archive, "utf8")) as Board;
    assert.equal(archived.revision, snapshot.revision);
    assert.equal(archived.goal, "original");
    assert.equal(archived.tasks[0]?.title, "Original");
    assert.deepEqual(loadBoard(cwd).tasks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("plan rejection conflicts instead of clearing work added after confirmation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-reject-plan-conflict-"));
  try {
    const board = emptyBoard();
    board.planPending = true;
    createTask(board, { title: "Reviewed", brief: "work", tier: "standard" });
    saveBoard(cwd, board);
    const reviewedRevision = loadBoard(cwd).revision ?? 0;
    updateBoard(cwd, (current) => {
      createTask(current, { title: "Concurrent", brief: "new work", tier: "standard" });
    });

    assert.throws(() => rejectPlan(cwd, reviewedRevision), /stale maestro board/);
    assert.deepEqual(
      loadBoard(cwd).tasks.map((task) => task.title),
      ["Reviewed", "Concurrent"]
    );
    assert.equal(listArchivedBoards(cwd).length, 0);
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

test("runtime state and evidence files are private on POSIX", () => {
  if (process.platform === "win32") return;
  const cwd = mkdtempSync(join(tmpdir(), "maestro-private-state-"));
  try {
    const board = emptyBoard();
    createTask(board, { title: "A", brief: "do a", tier: "standard" });
    saveBoard(cwd, board);
    updateTask(cwd, "T1", (task) => {
      task.status = "running";
    });
    const archive = archiveBoard(cwd);
    assert.ok(archive);
    assert.equal(statSync(join(cwd, ".pi", "maestro")).mode & 0o777, 0o700);
    assert.equal(statSync(join(cwd, ".pi", "maestro", "board.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(cwd, ".pi", "maestro", "history.jsonl")).mode & 0o777, 0o600);
    assert.equal(statSync(join(cwd, ".pi", "maestro", "archive")).mode & 0o777, 0o700);
    assert.equal(statSync(archive).mode & 0o777, 0o600);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("saveBoard bounds persisted executor and reviewer reports", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-bounded-reports-"));
  try {
    const board = emptyBoard();
    const task = createTask(board, { title: "A", brief: "do a", tier: "standard" });
    task.reviewNotes = "r".repeat(100_000);
    task.attempts.push({
      index: 1,
      logFile: "executor.log",
      thinking: "low",
      startedAt: 1,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      finalReport: "f".repeat(100_000),
      reviewReport: "v".repeat(100_000),
      reviewNotes: "n".repeat(100_000),
      touchedFiles: [],
    });
    saveBoard(cwd, board);
    const saved = loadBoard(cwd).tasks[0];
    assert.ok(saved);
    assert.ok((saved.reviewNotes?.length ?? 0) <= 16_000);
    assert.ok((saved.attempts[0]?.finalReport?.length ?? 0) <= 16_000);
    assert.match(saved.attempts[0]?.finalReport ?? "", /report truncated/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("saveBoard preserves valid discovery JSON above the ordinary report limit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-discovery-report-"));
  try {
    const board = emptyBoard();
    const task = createTask(board, {
      title: "Discover work",
      brief: "return discovery JSON",
      tier: "standard",
      kind: "investigation",
      writePaths: [],
    });
    task.discovery = { allowedWritePaths: ["src/**"] };
    const report = JSON.stringify({
      kind: "pi-maestro-discovery",
      version: 1,
      items: [
        {
          key: "large",
          title: "Large discovered task",
          brief: "x".repeat(17_000),
          tier: "standard",
          writePaths: ["src/**"],
          successCriteria: ["complete"],
          dependsOn: [],
        },
      ],
    });
    task.attempts.push({
      index: 1,
      logFile: "discovery.log",
      thinking: "low",
      startedAt: 1,
      usage: { input: 0, output: 0, cost: 0, turns: 1 },
      finalReport: report,
      touchedFiles: [],
    });

    saveBoard(cwd, board);
    const persisted = loadBoard(cwd).tasks[0]?.attempts[0]?.finalReport;
    assert.equal(persisted, report);
    assert.ok(Buffer.byteLength(persisted ?? "", "utf8") <= 64_000);
    assert.equal(parseDiscoveryOutput(persisted ?? "").items.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("saveBoard never invalidates an approved report artifact identity", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-approved-report-"));
  try {
    const board = emptyBoard();
    const task = createTask(board, {
      title: "Approved report",
      brief: "retain authoritative evidence",
      tier: "standard",
      kind: "investigation",
      writePaths: [],
    });
    const report = "authoritative ".repeat(1_300);
    task.attempts.push({
      index: 1,
      logFile: "report.log",
      thinking: "low",
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      usage: { input: 0, output: 0, cost: 0, turns: 1 },
      finalReport: report,
      touchedFiles: [],
    });
    forceStatus(task, "approved");
    const proof = captureApprovedProvenance(board, task, DEFAULT_CONFIG);
    assert.ok(proof);
    task.approvedProvenance = proof;
    assert.equal(completionFreshness(board, task, DEFAULT_CONFIG).state, "fresh");

    saveBoard(cwd, board);
    const persistedBoard = loadBoard(cwd);
    const persistedTask = persistedBoard.tasks[0];
    assert.ok(persistedTask);
    assert.equal(persistedTask.attempts[0]?.finalReport, report);
    assert.equal(completionFreshness(persistedBoard, persistedTask, DEFAULT_CONFIG).state, "fresh");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("saveBoard preserves legacy approved reports that predate provenance capture", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-legacy-approved-report-"));
  try {
    const board = emptyBoard();
    const task = createTask(board, {
      title: "Legacy approved",
      brief: "investigate",
      tier: "standard",
      kind: "investigation",
      writePaths: [],
    });
    const report = "legacy evidence ".repeat(2_000);
    task.attempts.push({
      index: 1,
      logFile: "legacy.log",
      thinking: "low",
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      usage: { input: 0, output: 0, cost: 0, turns: 1 },
      finalReport: report,
      touchedFiles: [],
    });
    // Legacy boards have approved tasks without approvedProvenance; their
    // latest report is still the authoritative artifact for dependencies.
    forceStatus(task, "approved");
    saveBoard(cwd, board);
    assert.equal(loadBoard(cwd).tasks[0]?.attempts[0]?.finalReport, report);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("saveBoard/loadBoard preserves a bounded reviewer log reference", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-review-log-test-"));
  try {
    const board = emptyBoard();
    const task = createTask(board, { title: "A", brief: "do a", tier: "standard" });
    task.attempts.push({
      index: 1,
      logFile: "executor.log",
      thinking: "low",
      startedAt: 1,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      reviewLaunches: [
        {
          startedAt: 2,
          logFile: "reviewer.log",
          usage: { input: 0, output: 0, cost: 0, turns: 0 },
        },
      ],
      touchedFiles: [],
    });

    saveBoard(cwd, board);

    assert.equal(
      loadBoard(cwd).tasks[0]?.attempts[0]?.reviewLaunches?.[0]?.logFile,
      "reviewer.log"
    );
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
    assert.equal(history?.entries.length, 1);
    assert.equal(history?.entries[0]?.taskId, "T1");
    assert.equal(history?.entries[0]?.from, "todo");
    assert.equal(history?.entries[0]?.to, "running");
    assert.equal(history?.skipped, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadStatusHistory skips malformed JSON and invalid entry shapes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const directory = join(cwd, ".pi", "maestro");
    mkdirSync(directory, { recursive: true });
    const valid = {
      ts: "2026-07-14T12:00:00.000Z",
      taskId: "T1",
      from: "todo",
      to: "running",
      revision: 1,
    };
    writeFileSync(
      join(directory, "history.jsonl"),
      [
        JSON.stringify(valid),
        "null",
        "{}",
        JSON.stringify({ ts: "now", taskId: "T1", from: "todo", to: "done" }),
        "{",
      ].join("\n")
    );
    const history = loadStatusHistory(cwd);
    assert.deepEqual(history?.entries, [valid]);
    assert.equal(history?.skipped, 4);
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
    assert.match(
      archive,
      /archive[/\\]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?Z-board\.json$/
    );
    assert.doesNotMatch(archive, /:/);
    assert.equal(readFileSync(archive, "utf-8"), boardContents);
    const latest = latestArchiveFile(cwd);
    assert.ok(latest);
    assert.match(latest.timestamp, /T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    assert.equal(Number.isFinite(Date.parse(latest.timestamp)), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("latestArchiveFile reads only the newest suffixed archive name", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const directory = join(cwd, ".pi", "maestro", "archive");
    mkdirSync(directory, { recursive: true });
    const name = "2026-07-14T12:00:00.000Z-1-board.json";
    writeFileSync(join(directory, name), "not readable JSON");

    const latest = latestArchiveFile(cwd);

    assert.equal(latest?.file, join(directory, name));
    assert.equal(latest?.timestamp, "2026-07-14T12:00:00.000Z");
    assert.equal(Number.isFinite(Date.parse(latest?.timestamp ?? "")), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("latestArchiveFile picks the highest numeric suffix among same-timestamp archives", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const directory = join(cwd, ".pi", "maestro", "archive");
    mkdirSync(directory, { recursive: true });
    const prefix = "2026-07-14T12:00:00.000Z";
    writeFileSync(join(directory, `${prefix}-board.json`), "oldest");
    writeFileSync(join(directory, `${prefix}-1-board.json`), "middle");
    writeFileSync(join(directory, `${prefix}-2-board.json`), "newest");

    const latest = latestArchiveFile(cwd);

    assert.equal(latest?.file, join(directory, `${prefix}-2-board.json`));
    assert.equal(latest?.timestamp, prefix);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("latestArchiveFile prefers a newer ISO prefix over an older unsuffixed one", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const directory = join(cwd, ".pi", "maestro", "archive");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "2026-07-14T12:00:00.000Z-board.json"), "older");
    writeFileSync(join(directory, "2026-07-14T13:00:00.000Z-board.json"), "newer");

    const latest = latestArchiveFile(cwd);

    assert.equal(latest?.file, join(directory, "2026-07-14T13:00:00.000Z-board.json"));
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

    const restored = restoreArchivedBoard(cwd, selectedFile, loadBoard(cwd).revision ?? 0);

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
      assert.throws(
        () => restoreArchivedBoard(cwd, file, loadBoard(cwd).revision ?? 0),
        /not a valid maestro board/
      );
      assert.equal(loadBoard(cwd).tasks[0]?.title, "Current");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("boards with a stalled attempt stay valid and survive archive/restore", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const selected = emptyBoard();
    const task = createTask(selected, { title: "Stalled", brief: "work", tier: "standard" });
    forceStatus(task, "failed");
    task.attempts.push({
      index: 1,
      logFile: "executor.log",
      thinking: "medium",
      startedAt: 1,
      endedAt: 2,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      touchedFiles: [],
      failureReason: {
        kind: "stalled",
        message: "no progress before watchdog termination",
        retryable: true,
      },
    });
    saveBoard(cwd, selected);
    const selectedFile = archiveBoard(cwd);
    assert.ok(selectedFile);

    const current = emptyBoard();
    createTask(current, { title: "Current", brief: "new work", tier: "complex" });
    saveBoard(cwd, current);

    const restored = restoreArchivedBoard(cwd, selectedFile, loadBoard(cwd).revision ?? 0);

    assert.equal(restored.selectedFile, selectedFile);
    const live = loadBoard(cwd);
    assert.equal(live.tasks[0]?.title, "Stalled");
    assert.equal(live.tasks[0]?.attempts[0]?.failureReason?.kind, "stalled");
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

      assert.throws(
        () => restoreArchivedBoard(cwd, file, loadBoard(cwd).revision ?? 0),
        /not a valid maestro board/,
        field
      );
      assert.equal(loadBoard(cwd).tasks[0]?.title, "Current", field);
    }

    const invalidReviewLog = structuredClone(archived);
    const invalidAttempt = invalidReviewLog.tasks[0]?.attempts[0];
    assert.ok(invalidAttempt);
    Object.assign(invalidAttempt, {
      reviewLaunches: [
        {
          startedAt: 1,
          usage: { input: 0, output: 0, cost: 0, turns: 0 },
          logFile: 1,
        },
      ],
    });
    const invalidReviewLogFile = join(directory, "review-log-board.json");
    writeFileSync(invalidReviewLogFile, JSON.stringify(invalidReviewLog));
    assert.throws(
      () => restoreArchivedBoard(cwd, invalidReviewLogFile, loadBoard(cwd).revision ?? 0),
      /not a valid maestro board/
    );
    assert.equal(loadBoard(cwd).tasks[0]?.title, "Current");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("startup sweep defers exited detached attempts to lifecycle log replay", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-detached-sweep-test-"));
  try {
    const board = emptyBoard();
    const task = createTask(board, { title: "Detached", brief: "work", tier: "standard" });
    forceStatus(task, "running");
    task.dispatchClaim = {
      id: "detached-claim",
      kind: "execute",
      claimedAt: 1,
      expiresAt: 2,
    };
    task.attempts.push({
      index: 1,
      logFile: join(cwd, "detached.jsonl"),
      controlFile: join(cwd, "detached.control"),
      detached: true,
      pid: 999_999_999,
      processStartId: "dead",
      thinking: "low",
      startedAt: 1,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      touchedFiles: [],
    });
    saveBoard(cwd, board);

    assert.deepEqual(sweepDispatchState(cwd), []);
    const recovered = findTask(loadBoard(cwd), task.id);
    assert.equal(recovered?.status, "running");
    assert.equal(recovered?.dispatchClaim?.id, "detached-claim");
    assert.equal(recovered?.attempts[0]?.endedAt, undefined);
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

test("approved provenance round-trips a SHA-1 Git tree and kind-aware report dependency", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-test-"));
  try {
    const board = emptyBoard();
    const task = createTask(board, { title: "Proof", brief: "proof", tier: "standard" });
    task.approvedProvenance = {
      version: 1,
      fingerprint: "a".repeat(64),
      componentHashes: {
        contract: "b".repeat(64),
        execution: "c".repeat(64),
        verification: "d".repeat(64),
        dependencies: "e".repeat(64),
      },
      artifact: { kind: "git-tree", identity: "f".repeat(40) },
      dependencyIdentities: [{ taskId: "T0", kind: "report", identity: "1".repeat(64) }],
      approvedAt: 1,
    };
    saveBoard(cwd, board);

    assert.deepEqual(loadBoard(cwd).tasks[0]?.approvedProvenance, task.approvedProvenance);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("task contract accepts explicit investigation kind regardless of brief phrasing", () => {
  // Explicit kind: no magic words needed in the brief.
  const contract = normalizeTaskContract({
    brief: "Determine why the cache misses spike under load and summarize root causes",
    kind: "investigation",
    writePaths: [],
  });
  assert.deepEqual(contract.writePaths, []);
  assert.equal(contract.kind, "investigation");

  // Legacy phrasing still works for boards planned before the kind field,
  // but is flagged so planning surfaces a deprecation notice.
  const legacy = normalizeTaskContract({
    brief: "Read-only investigation with no-file changes",
    writePaths: [],
  });
  assert.equal(legacy.kind, "investigation");
  assert.equal(legacy.legacyInvestigationBrief, true);
  // The explicit kind is the supported path and carries no deprecation flag.
  assert.equal(contract.legacyInvestigationBrief, undefined);

  // Investigation kind with a write scope is a contradiction.
  assert.throws(
    () =>
      normalizeTaskContract({
        brief: "whatever",
        kind: "investigation",
        writePaths: ["src/index.ts"],
      }),
    /investigation tasks must use writePaths/
  );

  // Empty scope without the kind and without legacy phrasing stays rejected.
  assert.throws(
    () => normalizeTaskContract({ brief: "Do something vague", writePaths: [] }),
    /empty writePaths requires kind/
  );
});

test("isReadOnlyTask covers explicit kind, discovery, and legacy briefs", () => {
  assert.equal(isReadOnlyTask({ kind: "investigation", brief: "anything", writePaths: [] }), true);
  assert.equal(
    isReadOnlyTask({
      brief: "anything",
      writePaths: [],
      discovery: { allowedWritePaths: ["src/**"] },
    }),
    true
  );
  assert.equal(
    isReadOnlyTask({ brief: "Read-only investigation with no-file changes", writePaths: [] }),
    true
  );
  assert.equal(isReadOnlyTask({ brief: "Implement the feature", writePaths: ["src/a.ts"] }), false);
});

test("human retry risk token ignores unrelated board touches but tracks acceptance evidence", () => {
  const board = emptyBoard();
  const task = createTask(board, { title: "Work", brief: "do it", tier: "standard" });
  const before = humanRetryRiskToken(task);

  // An unrelated metadata touch (updatedAt) must not invalidate a confirmed retry.
  task.updatedAt += 1000;
  assert.equal(humanRetryRiskToken(task), before);

  // Acceptance/integration evidence changes must invalidate it.
  task.integratedCommit = "abc123";
  assert.notEqual(humanRetryRiskToken(task), before);
});

test("async board helpers persist mutations and honor the false-result veto", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-async-board-"));
  try {
    const board = emptyBoard();
    const task = createTask(board, { title: "Async", brief: "work", tier: "standard" });
    saveBoard(cwd, board);

    await updateBoardAsync(cwd, (fresh) => {
      fresh.goal = "async goal";
      return true;
    });
    assert.equal(loadBoard(cwd).goal, "async goal");

    // A false result is never persisted.
    await updateBoardAsync(cwd, (fresh) => {
      fresh.goal = "discarded";
      return false;
    });
    assert.equal(loadBoard(cwd).goal, "async goal");

    const updated = await updateTaskAsync(cwd, task.id, (fresh) => {
      fresh.title = "Async updated";
    });
    assert.equal(updated?.title, "Async updated");
    assert.equal(findTask(loadBoard(cwd), task.id)?.title, "Async updated");
    assert.equal(await updateTaskAsync(cwd, "T999", () => {}), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadBoardView tracks writes without cloning and loadBoard callers cannot corrupt it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-board-view-"));
  try {
    const board = emptyBoard();
    createTask(board, { title: "View", brief: "work", tier: "standard" });
    saveBoard(cwd, board);

    const view = loadBoardView(cwd);
    assert.equal(view.tasks[0]?.title, "View");
    // Same identity, same cached object: zero-copy on repeat reads.
    assert.equal(loadBoardView(cwd), view);

    // A mutable loadBoard copy does not alias the shared view.
    const copy = loadBoard(cwd);
    const copyTask = copy.tasks[0];
    assert.ok(copyTask);
    copyTask.title = "mutated copy";
    assert.equal(loadBoardView(cwd).tasks[0]?.title, "View");

    // A persisted write invalidates the view by file identity.
    updateTask(cwd, "T1", (task) => {
      task.title = "Written";
    });
    assert.equal(loadBoardView(cwd).tasks[0]?.title, "Written");
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
    assert.match(consumeQuarantineNotice() ?? "", /board\.json\.corrupt-/);
    assert.equal(consumeQuarantineNotice(), undefined);

    const archives = readdirSync(directory).filter((name) =>
      /^board\.json\.corrupt-\d+$/.test(name)
    );
    assert.equal(archives.length, 1);
    assert.equal(readFileSync(join(directory, archives[0] as string), "utf-8"), corruptContents);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
