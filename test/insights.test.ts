import assert from "node:assert/strict";
import test from "node:test";
import { deriveModelInsights, formatModelInsights } from "../src/insights.js";
import { type Attempt, type Board, type Task } from "../src/types.js";

function attempt(
  index: number,
  model: string,
  cost: number,
  verdict?: "approve" | "request_changes"
): Attempt {
  return {
    index,
    logFile: `/tmp/${model}-${index}.jsonl`,
    model,
    provider: "openai",
    thinking: "medium",
    startedAt: index,
    usage: { input: 100, output: 20, cost, turns: 1 },
    ...(verdict
      ? {
          reviewLaunches: [
            {
              id: `review-${model}-${index}`,
              startedAt: index + 10,
              verdict,
              usage: { input: 10, output: 2, cost: 0, turns: 1 },
            },
          ],
        }
      : {}),
    touchedFiles: [],
  };
}

function task(id: string, tier: string, status: Task["status"], attempts: Attempt[]): Task {
  return {
    id,
    title: `Task ${id}`,
    brief: "work",
    tier,
    status,
    dependsOn: [],
    attempts,
    createdAt: Number(id.slice(1)),
    updatedAt: 10,
  };
}

test("model insights aggregate attempts, review outcomes, costs, and failures by model and tier", () => {
  const approved = attempt(1, "model-a", 0.3, "approve");
  const rejected = attempt(2, "model-a", 0.2, "request_changes");
  rejected.failureReason = {
    kind: "reviewer_rejection",
    message: "changes requested",
    retryable: true,
  };
  const providerFailure = attempt(1, "model-b", 0.05);
  providerFailure.provider = "anthropic";
  providerFailure.failureReason = {
    kind: "provider_failure",
    message: "quota",
    retryable: true,
  };
  const board: Board = {
    version: 1,
    nextTaskNumber: 4,
    tasks: [
      task("T1", "standard", "approved", [approved]),
      task("T2", "standard", "changes_requested", [rejected]),
      task("T3", "complex", "failed", [providerFailure]),
    ],
  };

  const insights = deriveModelInsights([board, structuredClone(board)]);

  assert.equal(insights.attempts, 3, "duplicate archive snapshots must not double count");
  assert.deepEqual(insights.groups, [
    {
      model: "anthropic/model-b",
      tier: "complex",
      attempts: 1,
      firstReviews: 0,
      firstReviewApprovals: 0,
      approvedTasks: 0,
      approvedTaskCost: 0,
      failures: { provider_failure: 1 },
      reviewerVerdicts: 0,
      reviewerRejections: 0,
    },
    {
      model: "openai/model-a",
      tier: "standard",
      attempts: 2,
      firstReviews: 2,
      firstReviewApprovals: 1,
      approvedTasks: 1,
      approvedTaskCost: 0.3,
      failures: { reviewer_rejection: 1 },
      reviewerVerdicts: 2,
      reviewerRejections: 1,
    },
  ]);

  const report = formatModelInsights(insights, 2);
  assert.match(report, /standard · openai\/model-a/);
  assert.match(report, /first-review approval 50\.0% \(1\/2\)/);
  assert.match(report, /avg cost \/ approved task \$0\.3000 \(1 task\)/);
  assert.match(report, /reviewer rejection 50\.0% \(1\/2\)/);
  assert.match(report, /reviewer_rejection:1/);
});

test("model insights render empty and bounded reports", () => {
  assert.match(
    formatModelInsights(deriveModelInsights([]), 0),
    /No recorded model attempts in current or archived boards/
  );

  const boards: Board[] = [
    {
      version: 1,
      nextTaskNumber: 20,
      tasks: Array.from({ length: 12 }, (_, index) => {
        const entry = attempt(1, `model-${index}`, 0.01, "approve");
        entry.provider = `provider-${index}`;
        return task(`T${index + 1}`, `tier-${index}`, "approved", [entry]);
      }),
    },
  ];
  const bounded = formatModelInsights(deriveModelInsights(boards), 0, 450);
  assert.ok(bounded.length <= 450);
  assert.match(bounded, /group\(s\) omitted by report bound/);
});
