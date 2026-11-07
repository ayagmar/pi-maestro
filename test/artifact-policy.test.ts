import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  captureApprovedProvenance,
  completionFreshness,
  taskFingerprint,
} from "../src/artifact-policy.js";
import { createTask, forceStatus } from "../src/board.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { type Board, type MaestroConfig, type Task } from "../src/types.js";

function fixture(): { board: Board; task: Task; config: MaestroConfig } {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const task = createTask(board, {
    title: "Deterministic task",
    brief: "Produce the bounded result",
    tier: "standard",
    writePaths: [],
    successCriteria: ["first", "second"],
  });
  task.attempts.push({
    index: 1,
    logFile: "attempt.jsonl",
    thinking: "medium",
    startedAt: 1,
    usage: { input: 0, output: 0, cost: 0, turns: 1 },
    finalReport: "authoritative result",
    touchedFiles: [],
  });
  return { board, task, config: structuredClone(DEFAULT_CONFIG) };
}

test("task fingerprints are deterministic, normalized, and exclude runtime controls", () => {
  const { board, task, config } = fixture();
  task.writePaths = ["src/b.ts", "src/a.ts", "src/a.ts"];
  task.provenance = { candidateTree: "a".repeat(40), capturedAt: 1 };
  const first = taskFingerprint(board, task, config);
  assert.ok(first);

  task.writePaths = ["src/a.ts", "src/b.ts"];
  task.commitMessage = "excluded";
  task.updatedAt = 999;
  config.maxParallel = 99;
  config.maxAttempts = 99;
  assert.equal(taskFingerprint(board, task, config)?.fingerprint, first.fingerprint);

  task.brief = "changed contract";
  const changed = taskFingerprint(board, task, config);
  assert.notEqual(changed?.fingerprint, first.fingerprint);
  assert.notEqual(changed?.componentHashes.contract, first.componentHashes.contract);
  assert.equal(changed?.componentHashes.execution, first.componentHashes.execution);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
});

test("switching tier models, thinking, or reviewer tools never changes a fingerprint", () => {
  const { board, task, config } = fixture();
  const before = taskFingerprint(board, task, config);
  assert.ok(before);
  config.tiers.standard = { thinking: "high", model: "other-provider/other-model" };
  config.tiers.review = { thinking: "low", model: "another/reviewer", tools: "read" };
  const after = taskFingerprint(board, task, config);
  assert.equal(after?.fingerprint, before.fingerprint);
  assert.equal(after?.componentHashes.execution, before.componentHashes.execution);

  // The review policy and confirm count do remain execution inputs.
  task.reviewPolicy = "confirm";
  const confirm = taskFingerprint(board, task, config);
  assert.notEqual(confirm?.componentHashes.execution, before.componentHashes.execution);
  config.reviewRequiredApprovals = 3;
  assert.notEqual(
    taskFingerprint(board, task, config)?.componentHashes.execution,
    confirm?.componentHashes.execution
  );
});

function approveBySingleReviewer(task: Task): void {
  const attempt = task.attempts.at(-1);
  assert.ok(attempt);
  attempt.reviewLaunches = [
    {
      reviewerIndex: 1,
      role: "single",
      verdict: "approve",
      startedAt: 1,
      usage: { input: 0, output: 0, cost: 0, turns: 1 },
    },
  ];
  attempt.reviewConvergence = {
    policy: "single",
    status: "approved",
    requiredApprovals: 1,
    actualApprovals: 1,
    reviewerCount: 1,
    summary: "approved",
    decidedAt: 1,
  };
}

/** The execution digest the previous release stored, before executionShape 2. */
function previousReleaseExecutionDigest(task: Task, config: MaestroConfig): string {
  const tier = (value: MaestroConfig["tiers"][string] | undefined) =>
    value
      ? { model: value.model ?? null, thinking: value.thinking, tools: value.tools ?? null }
      : undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        tier: task.tier,
        taskTier: tier(config.tiers[task.tier]),
        reviewTier: tier(config.tiers.review),
        reviewPolicy: task.reviewPolicy ?? "single",
        confirmApprovals: task.reviewPolicy === "confirm" ? config.reviewRequiredApprovals : null,
      })
    )
    .digest("hex");
}

test("a legacy proof does not stay fresh after its review policy is strengthened", () => {
  const { board, task, config } = fixture();
  forceStatus(task, "approved");
  const proof = captureApprovedProvenance(board, task, config);
  assert.ok(proof);
  const { executionShape: _shape, ...current } = proof;
  // Approved by one reviewer under the single policy, by the previous release.
  task.approvedProvenance = {
    ...current,
    fingerprint: "f".repeat(64),
    componentHashes: {
      ...proof.componentHashes,
      execution: previousReleaseExecutionDigest(task, config),
    },
  };
  approveBySingleReviewer(task);
  assert.equal(completionFreshness(board, task, config).state, "fresh");

  task.reviewPolicy = "confirm";
  assert.equal(completionFreshness(board, task, config).state, "legacy");

  // Without any review evidence (a manual acceptance), an unchanged
  // configuration still proves the proof's execution inputs exactly.
  task.reviewPolicy = "single";
  const attempt = task.attempts.at(-1);
  assert.ok(attempt);
  delete attempt.reviewConvergence;
  delete attempt.reviewLaunches;
  assert.equal(completionFreshness(board, task, config).state, "fresh");
});

test("legacy-shape proofs stay fresh across a model switch and go stale on a contract change", () => {
  const { board, task, config } = fixture();
  forceStatus(task, "approved");
  const proof = captureApprovedProvenance(board, task, config);
  assert.ok(proof);
  // The record version never moves: validators still running in other pi
  // sessions quarantine a board whose proofs carry any other version.
  assert.equal(proof.version, 1);
  assert.equal(proof.executionShape, 2);
  // Simulate a proof captured by the previous shape: no shape marker, a
  // different execution digest and total fingerprint, but the same
  // contract/verification/dependency/artifact identities.
  const { executionShape: _shape, ...legacy } = proof;
  task.approvedProvenance = {
    ...legacy,
    fingerprint: "f".repeat(64),
    componentHashes: { ...proof.componentHashes, execution: "e".repeat(64) },
  };
  approveBySingleReviewer(task);
  assert.equal(completionFreshness(board, task, config).state, "fresh");
  config.tiers.standard = { thinking: "low", model: "cheaper/model" };
  assert.equal(completionFreshness(board, task, config).state, "fresh");
  task.brief = "changed contract";
  assert.match(completionFreshness(board, task, config).reason, /contract/);
});

test("freshness detects legacy, component, artifact, and transitive dependency staleness", () => {
  const { board, task, config } = fixture();
  forceStatus(task, "approved");
  assert.equal(completionFreshness(board, task, config).state, "legacy");
  const taskProof = captureApprovedProvenance(board, task, config);
  assert.ok(taskProof);
  task.approvedProvenance = taskProof;
  assert.equal(completionFreshness(board, task, config).state, "fresh");

  const dependent = createTask(board, {
    title: "Dependent",
    brief: "consume proof",
    tier: "standard",
    dependsOn: [task.id],
    writePaths: [],
  });
  dependent.attempts.push({
    index: 1,
    logFile: "dependent.jsonl",
    thinking: "medium",
    startedAt: 1,
    usage: { input: 0, output: 0, cost: 0, turns: 1 },
    finalReport: "dependent result",
    touchedFiles: [],
  });
  forceStatus(dependent, "approved");
  const dependentProof = captureApprovedProvenance(board, dependent, config);
  assert.ok(dependentProof);
  dependent.approvedProvenance = dependentProof;
  assert.equal(dependent.approvedProvenance?.dependencyIdentities[0]?.kind, "report");
  assert.equal(completionFreshness(board, dependent, config).state, "fresh");

  task.brief = "changed prerequisite";
  assert.match(completionFreshness(board, task, config).reason, /contract/);
  assert.match(completionFreshness(board, dependent, config).reason, /dependency T1 is stale/);
});

test("file approval keeps an exact Git tree identity", () => {
  const { board, task, config } = fixture();
  task.writePaths = ["src/file.ts"];
  task.provenance = { candidateTree: "b".repeat(40), capturedAt: 1 };
  forceStatus(task, "approved");
  const proof = captureApprovedProvenance(board, task, config);
  assert.ok(proof);
  task.approvedProvenance = proof;
  assert.equal(task.approvedProvenance?.artifact.kind, "git-tree");
  assert.equal(task.approvedProvenance?.artifact.identity, "b".repeat(40));
  assert.equal(completionFreshness(board, task, config).state, "fresh");
});
