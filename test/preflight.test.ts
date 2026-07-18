import assert from "node:assert/strict";
import test from "node:test";
import { createTask } from "../src/board.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  assertPlanTaskLimit,
  formatWorkflowPreflight,
  preflightWorkflow,
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
