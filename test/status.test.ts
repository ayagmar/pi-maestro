import assert from "node:assert/strict";
import test from "node:test";
import { createTask } from "../src/board.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  formatStatusProjection,
  projectRunPhases,
  projectStatus,
  RUN_PHASES,
} from "../src/status.js";
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
  assert.match(formatStatusProjection(complete), /complete · 1 approved · 0 cancelled/);
});

test("stale approved work is blocked instead of reported complete", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const stale = createTask(board, { title: "Stale", brief: "old work", tier: "standard" });
  stale.status = "approved";

  const status = projectStatus(board, undefined, DEFAULT_CONFIG);

  assert.equal(status.code, "blocked");
  assert.equal(status.phase, "recovery");
  assert.equal(status.approved, 0);
  assert.equal(status.blocked, 1);
});

test("status projection distinguishes live review from live execution", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const task = createTask(board, { title: "Review", brief: "inspect work", tier: "standard" });
  task.status = "ready_for_review";

  const status = projectStatus(board, [task.id], undefined, new Map([[task.id, "review"]]));

  assert.equal(status.code, "running");
  assert.equal(status.phase, "review");
});

test("all-cancelled and mixed settled boards agree on complete status and phase", () => {
  const allCancelled: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const firstCancelled = createTask(allCancelled, {
    title: "Cancelled one",
    brief: "cancelled",
    tier: "standard",
  });
  firstCancelled.status = "cancelled";
  const secondCancelled = createTask(allCancelled, {
    title: "Cancelled two",
    brief: "cancelled",
    tier: "standard",
  });
  secondCancelled.status = "cancelled";

  const cancelledStatus = projectStatus(allCancelled);
  assert.equal(cancelledStatus.code, "complete");
  assert.equal(cancelledStatus.phase, "complete");
  assert.equal(cancelledStatus.approved, 0);
  assert.equal(cancelledStatus.cancelled, 2);
  assert.equal(cancelledStatus.blocked, 0);
  assert.match(formatStatusProjection(cancelledStatus), /0 approved · 2 cancelled/);

  const mixed: Board = structuredClone(allCancelled);
  const approved = mixed.tasks[0];
  assert.ok(approved);
  approved.status = "approved";
  const mixedStatus = projectStatus(mixed);
  assert.equal(mixedStatus.code, "complete");
  assert.equal(projectRunPhases(mixed).find((phase) => phase.current)?.id, "complete");
  assert.equal(mixedStatus.approved, 1);
  assert.equal(mixedStatus.cancelled, 1);
});

test("phase projection always returns all phases with deterministic precedence and membership", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
  const discovery = createTask(board, { title: "Discover", brief: "inspect", tier: "standard" });
  discovery.discovery = { allowedWritePaths: ["src/**"] };
  discovery.status = "failed";
  discovery.attempts.push({
    index: 1,
    logFile: "attempt.log",
    thinking: "low",
    startedAt: 1,
    usage: { input: 1, output: 1, cost: 0, turns: 1 },
    finalReport: "result",
    reviewReport: "VERDICT: APPROVE",
    touchedFiles: [],
  });
  discovery.verificationProfile = "required";
  discovery.verificationSummary = "passed";
  discovery.provenance = {
    candidateTree: "candidate",
    capturedAt: 2,
    integratedCommit: "commit",
    integratedTree: "integrated",
    verifiedAt: 3,
  };

  let phases = projectRunPhases(board, new Map([[discovery.id, "review"]]));
  assert.deepEqual(
    phases.map((phase) => phase.id),
    RUN_PHASES
  );
  assert.equal(phases.find((phase) => phase.current)?.id, "plan_approval");
  for (const id of [
    "discovery",
    "plan_approval",
    "execution",
    "review",
    "integration",
    "verification",
    "recovery",
  ]) {
    assert.ok(phases.find((phase) => phase.id === id)?.taskIds.includes(discovery.id), id);
  }

  delete board.planPending;
  assert.equal(
    projectRunPhases(board, new Map([[discovery.id, "review"]])).find((phase) => phase.current)?.id,
    "recovery"
  );
  discovery.status = "ready_for_review";
  assert.equal(
    projectRunPhases(board, new Map([[discovery.id, "review"]])).find((phase) => phase.current)?.id,
    "review"
  );
  discovery.status = "approved";
  phases = projectRunPhases(board);
  assert.equal(phases.find((phase) => phase.current)?.id, "complete");
  assert.ok(phases.find((phase) => phase.id === "complete")?.taskIds.includes(discovery.id));
});

test("phase projection separates unresolved recovery from retained recovery evidence", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const cancelled = createTask(board, { title: "Old", brief: "old", tier: "standard" });
  cancelled.status = "cancelled";
  const runnable = createTask(board, { title: "Next", brief: "next", tier: "standard" });

  let phases = projectRunPhases(board);
  assert.equal(phases.find((phase) => phase.current)?.id, "execution");
  assert.ok(phases.find((phase) => phase.id === "recovery")?.taskIds.includes(cancelled.id));

  runnable.status = "approved";
  phases = projectRunPhases(board);
  assert.equal(phases.find((phase) => phase.current)?.id, "complete");

  runnable.status = "running";
  runnable.discovery = { allowedWritePaths: ["src/**"] };
  assert.equal(projectRunPhases(board).find((phase) => phase.current)?.id, "discovery");
  assert.equal(
    projectRunPhases(board, new Map([[cancelled.id, "review"]])).find((phase) => phase.current)?.id,
    "review"
  );
});

test("recovery membership includes durable unresolved and retained references", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const finding = createTask(board, { title: "Finding", brief: "work", tier: "standard" });
  finding.findings = [
    { fingerprint: "open", message: "fix", status: "open", firstAttempt: 1, lastAttempt: 1 },
  ];
  const retained = createTask(board, { title: "Retained", brief: "work", tier: "standard" });
  retained.attempts.push({
    index: 1,
    logFile: "attempt.log",
    thinking: "low",
    startedAt: 1,
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    worktreePath: "/tmp/worktree",
    branch: "maestro/t2",
    reviewConvergence: {
      policy: "confirm",
      status: "disagreement",
      requiredApprovals: 2,
      actualApprovals: 1,
      reviewerCount: 2,
      summary: "unresolved",
      decidedAt: 2,
    },
    touchedFiles: [],
  });
  const scoped = createTask(board, { title: "Scoped", brief: "work", tier: "standard" });
  board.activeDecision = {
    id: "decision",
    kind: "recovery",
    taskIds: [scoped.id],
    evidence: "input required",
    allowedInterventions: ["steer"],
    createdAt: 3,
  };
  board.pausedDrive = { taskIds: [scoped.id] };

  const recovery = projectRunPhases(board).find((phase) => phase.id === "recovery");
  assert.deepEqual(recovery?.taskIds, [finding.id, retained.id, scoped.id]);
  assert.equal(projectRunPhases(board).find((phase) => phase.current)?.id, "recovery");
});
