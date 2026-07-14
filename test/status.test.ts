import assert from "node:assert/strict";
import test from "node:test";
import { createTask } from "../src/board.js";
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
  assert.match(formatStatusProjection(complete), /complete · 1\/1 approved/);
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
