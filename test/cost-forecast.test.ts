import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateProjectedCost,
  FORECAST_STATIC_COST_PER_LAUNCH,
  historicalLaunchCosts,
} from "../src/cost-forecast-policy.js";
import { type Board } from "../src/types.js";

test("projected cost prefers matching historical launch averages", () => {
  const estimate = calculateProjectedCost(
    [
      {
        tier: "standard",
        kind: "executor",
        launches: 3,
        model: "openai/model-a",
        modelCost: { input: 1, output: 2 },
      },
    ],
    [
      { tier: "standard", kind: "executor", model: "openai/model-a", cost: 0.2 },
      { tier: "standard", kind: "executor", model: "openai/model-a", cost: 0.4 },
    ]
  );

  assert.ok(Math.abs(estimate.estimatedUsd - 0.9) < Number.EPSILON);
  assert.deepEqual(estimate.sourceLaunches, {
    historical: 3,
    modelMetadata: 0,
    staticFallback: 0,
  });
  assert.equal(estimate.historicalSamples, 2);
});

test("projected cost uses token assumptions for metadata and a static unresolved fallback", () => {
  const estimate = calculateProjectedCost(
    [
      {
        tier: "complex",
        kind: "executor",
        launches: 2,
        model: "anthropic/model-b",
        modelCost: { input: 2, output: 10 },
      },
      { tier: "review", kind: "reviewer", launches: 1 },
    ],
    []
  );

  // 20k input at $2/M + 4k output at $10/M = $0.08 per metadata-priced launch.
  assert.equal(estimate.estimatedUsd, 0.26);
  assert.equal(estimate.launchUpperBound, 3);
  assert.deepEqual(estimate.sourceLaunches, {
    historical: 0,
    modelMetadata: 2,
    staticFallback: 1,
  });
  assert.equal(estimate.assumptions.staticCostPerLaunch, FORECAST_STATIC_COST_PER_LAUNCH);
});

test("archived launch history separates executor cost from aggregated review cost", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 2,
    tasks: [
      {
        id: "T1",
        title: "Task",
        brief: "Implement it",
        tier: "standard",
        status: "approved",
        dependsOn: [],
        attempts: [
          {
            index: 1,
            logFile: "executor.jsonl",
            model: "model-a",
            provider: "openai",
            thinking: "low",
            startedAt: 1,
            usage: { input: 30, output: 10, cost: 0.5, turns: 2 },
            reviewUsage: { input: 10, output: 5, cost: 0.2, turns: 1 },
            reviewLaunches: [
              {
                id: "review-1",
                model: "model-r",
                provider: "anthropic",
                startedAt: 2,
                usage: { input: 10, output: 5, cost: 0.2, turns: 1 },
              },
            ],
            touchedFiles: [],
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  };

  assert.deepEqual(historicalLaunchCosts([board, structuredClone(board)]), [
    {
      tier: "standard",
      kind: "executor",
      model: "openai/model-a",
      cost: 0.3,
    },
    {
      tier: "review",
      kind: "reviewer",
      model: "anthropic/model-r",
      cost: 0.2,
    },
  ]);
});
