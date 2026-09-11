import assert from "node:assert/strict";
import test from "node:test";
import { createTask } from "../src/board.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { calculateProjectedCost, type ProjectedCostEstimate } from "../src/cost-forecast-policy.js";
import {
  assertPlanTaskLimit,
  formatWorkflowPreflight,
  preflightWorkflow,
  taskShapeWarnings,
} from "../src/preflight.js";
import { type Board, type MaestroConfig } from "../src/types.js";

function config(): MaestroConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function boardWithTasks(count: number): Board {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  for (let index = 1; index <= count; index += 1) {
    createTask(board, {
      title: `Task ${index}`,
      brief: `Implement task ${index}`,
      tier: "standard",
      writePaths: [`src/task-${index}.ts`],
      successCriteria: [`Task ${index} works`],
    });
  }
  return board;
}

test("workflow preflight derives natural dependency waves and launch bounds", () => {
  const board = boardWithTasks(3);
  const first = board.tasks[0];
  const second = board.tasks[1];
  const third = board.tasks[2];
  assert.ok(first && second && third);
  second.dependsOn = [first.id];
  second.reviewPolicy = "confirm";
  second.verificationProfile = "check";
  third.reviewPolicy = "find-and-refute";
  const settings = config();
  settings.tiers.standard = { thinking: "low", fallbacks: ["backup"] };
  settings.verificationProfiles = { check: { command: "true", timeoutSeconds: 1 } };

  const preflight = preflightWorkflow(board, settings);

  assert.deepEqual(preflight.waves, [["T1", "T3"], ["T2"]]);
  assert.equal(preflight.configuredConcurrency, 3);
  assert.equal(preflight.effectiveConcurrency, 2);
  assert.equal(preflight.executorLaunchUpperBound, 18);
  assert.equal(preflight.reviewerLaunchUpperBound, 15);
  assert.equal(preflight.totalLaunchUpperBound, 33);
  assert.deepEqual(preflight.verificationProfileUsage, [
    { profile: "(none)", tasks: 2 },
    { profile: "check", tasks: 1 },
  ]);
});

test("workflow preflight size guidance and confirmation thresholds are deterministic", () => {
  assert.equal(preflightWorkflow(boardWithTasks(8), config()).size, "small");
  assert.equal(preflightWorkflow(boardWithTasks(9), config()).size, "medium");
  const large = preflightWorkflow(boardWithTasks(25), config());
  assert.equal(large.size, "large");
  assert.equal(large.requiresConfirmation, true);
  assert.match(large.warnings.join("\n"), /confirmationPlanTasks/);
  assert.equal(preflightWorkflow(boardWithTasks(25), config()).signature, large.signature);

  const report = formatWorkflowPreflight(large);
  assert.match(report, /dependency waves:/);
  assert.match(report, /raw launch upper bounds:/);
  assert.match(report, /projected cost estimate: \$.*upper-bound launches/i);
  assert.equal(large.projectedCost.assumptions.inputTokensPerLaunch, 20_000);
  assert.equal(large.projectedCost.assumptions.outputTokensPerLaunch, 4_000);
  assert.ok(report.length <= 4_000);
});

test("plan task limit is enforced with an actionable error", () => {
  const settings = config();
  settings.maxPlanTasks = 2;
  assert.throws(() => assertPlanTaskLimit(3, settings), /3 tasks.*maxPlanTasks is 2/);
});

test("approved work is omitted and satisfies unresolved dependency waves", () => {
  const board = boardWithTasks(2);
  const predecessor = board.tasks[0];
  const successor = board.tasks[1];
  assert.ok(predecessor && successor);
  predecessor.status = "approved";
  successor.dependsOn = [predecessor.id];

  const remaining = preflightWorkflow(board, config());
  assert.equal(remaining.taskCount, 1);
  assert.deepEqual(remaining.waves, [[successor.id]]);

  successor.status = "approved";
  const completed = preflightWorkflow(board, config(), [successor.id]);
  assert.equal(completed.taskCount, 0);
  assert.equal(completed.totalLaunchUpperBound, 0);
});

test("preflight warns at the plan gate when reviewers project to dominate spend", () => {
  const board = boardWithTasks(3);
  const settings = config();
  settings.reviewPolicy = "confirm";
  settings.reviewRequiredApprovals = 2;
  settings.maxAttempts = 3;
  settings.tiers.standard = { model: "cheap/executor", thinking: "low" };
  settings.tiers.review = { model: "premium/reviewer", thinking: "max", tools: "read,grep" };

  // Executors: 3 tasks × 3 attempts at $0.03 = $0.27. Reviewers: one logical
  // reviewer per task × 3 attempts at $0.15 = $1.35 — 5× the executor spend,
  // the shape of the measured 94.7%-review drive.
  const lopsided: ProjectedCostEstimate = {
    estimatedUsd: 1.62,
    byKind: { executor: 0.27, reviewer: 1.35 },
    launchUpperBound: 18,
    sourceLaunches: { historical: 0, modelMetadata: 18, staticFallback: 0 },
    historicalSamples: 0,
    assumptions: {
      inputTokensPerLaunch: 20_000,
      outputTokensPerLaunch: 4_000,
      staticCostPerLaunch: 0.1,
    },
  };
  const warned = preflightWorkflow(board, settings, undefined, lopsided);
  const warning = warned.warnings.find((entry) => /projected review spend/.test(entry));
  assert.ok(warning, `expected a review-spend warning, got ${JSON.stringify(warned.warnings)}`);
  assert.match(warning, /5\.0× the projected executor spend/);
  assert.match(warning, /reviewPolicy "single"/);
  assert.match(warning, /cheaper review-tier model/);
  // `maxCostPerReview: 0` inherits the per-attempt cap silently; the warning
  // names the effective number and its source.
  assert.match(warning, /up to \$5\.00 before the maxCostPerTask cap stops it/);
  assert.match(
    preflightWorkflow(
      board,
      { ...settings, maxCostPerReview: 2 },
      undefined,
      lopsided
    ).warnings.find((entry) => /projected review spend/.test(entry)) ?? "",
    /up to \$2\.00 before the maxCostPerReview cap stops it/
  );
  // The gate report carries the same warning, and the warning itself names
  // both sides of the split (the plan-review viewport is height-bounded, so
  // the preflight line itself stays its original length).
  const report = formatWorkflowPreflight(warned);
  assert.match(report, /warning: projected review spend \(\$1\.35\)/);
  assert.match(report, /projected executor spend \(\$0\.27\)/);

  // A balanced projection stays quiet apart from the normal thresholds.
  const balanced = preflightWorkflow(board, settings, undefined, {
    ...lopsided,
    estimatedUsd: 1.0,
    byKind: { executor: 0.6, reviewer: 0.4 },
  });
  assert.equal(
    balanced.warnings.some((entry) => /projected review spend/.test(entry)),
    false
  );

  // A lopsided ratio on trivial money is not worth a warning.
  const trivial = preflightWorkflow(board, settings, undefined, {
    ...lopsided,
    estimatedUsd: 0.09,
    byKind: { executor: 0.01, reviewer: 0.08 },
  });
  assert.equal(
    trivial.warnings.some((entry) => /projected review spend/.test(entry)),
    false
  );
});

test("cost-aware preflight counts executor and reviewer demand separately", () => {
  const board = boardWithTasks(2);
  const settings = config();
  settings.tiers.standard = { model: "cheap/executor", thinking: "low" };
  settings.tiers.review = { model: "premium/reviewer", thinking: "max" };

  // $0.02 per executor launch, $0.08 per reviewer launch.
  const estimate = calculateProjectedCost(
    [
      { tier: "standard", kind: "executor", launches: 6, modelCost: { input: 1, output: 0 } },
      { tier: "review", kind: "reviewer", launches: 4, modelCost: { input: 4, output: 0 } },
    ],
    []
  );
  assert.ok(Math.abs(estimate.byKind.executor - 0.12) < 1e-9);
  assert.ok(Math.abs(estimate.byKind.reviewer - 0.32) < 1e-9);
  assert.ok(
    Math.abs(estimate.byKind.executor + estimate.byKind.reviewer - estimate.estimatedUsd) < 1e-9
  );

  const preflight = preflightWorkflow(board, settings, undefined, estimate);
  assert.equal(preflight.projectedCost.byKind.reviewer, estimate.byKind.reviewer);
});

test("taskShapeWarnings flags omnibus tasks and stays quiet for narrow ones", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const narrow = createTask(board, {
    title: "Narrow",
    brief: "one thing",
    tier: "standard",
    writePaths: ["src/a.ts", "test/a.test.ts"],
    successCriteria: ["a works", "a is tested"],
  });
  const manyCriteria = createTask(board, {
    title: "Omnibus criteria",
    brief: "many things",
    tier: "complex",
    writePaths: ["src/b.ts"],
    successCriteria: Array.from({ length: 6 }, (_, index) => `outcome ${index + 1}`),
  });
  const manyPaths = createTask(board, {
    title: "Omnibus paths",
    brief: "many files",
    tier: "complex",
    writePaths: Array.from({ length: 8 }, (_, index) => `src/file-${index + 1}.ts`),
    successCriteria: ["everything works"],
  });

  assert.deepEqual(taskShapeWarnings([narrow]), []);
  const criteriaWarnings = taskShapeWarnings([manyCriteria]);
  assert.equal(criteriaWarnings.length, 1);
  assert.match(criteriaWarnings[0] ?? "", /6 success criteria/);
  assert.match(criteriaWarnings[0] ?? "", /consider splitting/);
  const pathWarnings = taskShapeWarnings([manyPaths]);
  assert.equal(pathWarnings.length, 1);
  assert.match(pathWarnings[0] ?? "", /8 write paths/);
  // The workflow preflight surfaces the same warnings.
  const preflight = preflightWorkflow(board, config());
  assert.ok(preflight.warnings.some((warning) => warning.includes("6 success criteria")));
});
