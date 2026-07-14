import assert from "node:assert/strict";
import test from "node:test";
import { createTask } from "../src/board.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  comparePlans,
  exportPlan,
  formatPlanComparison,
  importPlan,
} from "../src/plan-serialization.js";
import { type Board } from "../src/types.js";

test("plan export/import is versioned and excludes run evidence", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const first = createTask(board, {
    title: "First",
    brief: "Implement first",
    tier: "standard",
    writePaths: ["src/a.ts"],
    successCriteria: ["A works"],
    verificationProfile: "check",
    reviewPolicy: "confirm",
  });
  first.attempts.push({
    index: 1,
    logFile: "secret-log",
    thinking: "medium",
    startedAt: 1,
    usage: { input: 1, output: 1, cost: 1, turns: 1 },
    touchedFiles: ["src/a.ts"],
  });
  createTask(board, {
    title: "Second",
    brief: "Implement second",
    tier: "standard",
    dependsOn: [first.id],
    writePaths: ["src/b.ts"],
    successCriteria: ["B works"],
  });

  const text = exportPlan(board);
  assert.doesNotMatch(text, /secret-log|attempts/);
  const imported = importPlan(text, ["standard"], ["check"]);
  assert.equal(imported.planPending, true);
  assert.equal(imported.tasks.length, 2);
  assert.deepEqual(imported.tasks[1]?.dependsOn, ["T1"]);
  assert.equal(imported.tasks[0]?.attempts.length, 0);
  assert.equal(imported.tasks[0]?.reviewPolicy, "confirm");
});

test("plan import rejects malformed, cyclic, and unknown-profile plans", () => {
  assert.throws(() => importPlan("{}", ["standard"], []), /kind or version/);
  const cyclic = JSON.stringify({
    kind: "pi-maestro-plan",
    version: 1,
    tasks: [
      {
        id: "T1",
        title: "One",
        brief: "Work",
        tier: "standard",
        dependsOn: ["T1"],
        writePaths: ["a"],
        successCriteria: ["done"],
      },
    ],
  });
  assert.throws(() => importPlan(cyclic, ["standard"], []), /cycle/i);
  assert.throws(
    () =>
      importPlan(
        exportPlan({
          version: 1,
          nextTaskNumber: 1,
          tasks: [
            {
              id: "T1",
              title: "One",
              brief: "Work",
              tier: "standard",
              dependsOn: [],
              writePaths: ["a"],
              successCriteria: ["done"],
              verificationProfile: "missing",
              status: "todo",
              attempts: [],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
        ["standard"],
        []
      ),
    /Unknown verification profile/
  );
});

test("plan export and import preserve strict discovery contracts", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  createTask(board, {
    title: "Discover",
    brief: "Read-only investigation with no-file changes",
    tier: "standard",
    writePaths: [],
    discovery: { allowedWritePaths: ["src/**"] },
  });

  const imported = importPlan(exportPlan(board), ["standard"], []);
  assert.deepEqual(imported.tasks[0]?.discovery?.allowedWritePaths, ["src/**"]);
  const malformed = JSON.parse(exportPlan(board)) as {
    tasks: Array<Record<string, unknown>>;
  };
  const first = malformed.tasks[0];
  assert.ok(first);
  first.discovery = { allowedWritePaths: ["src/**"], command: "touch owned" };
  assert.throws(() => importPlan(JSON.stringify(malformed), ["standard"], []), /malformed/);
});

test("plan comparison is pure and reports contracts, fingerprints, waves, and concurrency", () => {
  const current: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const first = createTask(current, {
    title: "First",
    brief: "Implement first",
    tier: "standard",
    writePaths: ["src/a.ts"],
    successCriteria: ["A works"],
  });
  createTask(current, {
    title: "Removed",
    brief: "Remove me",
    tier: "standard",
    dependsOn: [first.id],
    writePaths: ["src/removed.ts"],
    successCriteria: ["Removed works"],
  });
  const candidate = importPlan(
    JSON.stringify({
      kind: "pi-maestro-plan",
      version: 1,
      tasks: [
        {
          id: "T1",
          title: "First",
          brief: "Implement first differently",
          tier: "complex",
          dependsOn: [],
          writePaths: ["src/a.ts", "src/shared.ts"],
          successCriteria: ["A works", "A is covered"],
          reviewPolicy: "confirm",
        },
        {
          id: "T3",
          title: "Added",
          brief: "Add a dependent task",
          tier: "standard",
          dependsOn: ["T1"],
          writePaths: ["src/added.ts"],
          successCriteria: ["Added works"],
        },
      ],
    }),
    Object.keys(DEFAULT_CONFIG.tiers),
    []
  );
  const before = JSON.stringify({ current, candidate });
  const comparison = comparePlans(current, candidate, DEFAULT_CONFIG);
  const report = formatPlanComparison(comparison, "/maestro plan compare candidate.json");

  assert.equal(JSON.stringify({ current, candidate }), before);
  assert.deepEqual(comparison.added, ["T3"]);
  assert.deepEqual(comparison.removed, ["T2"]);
  assert.deepEqual(comparison.changed[0]?.fields, [
    "brief",
    "success criteria",
    "write scope",
    "tier",
    "review policy",
  ]);
  assert.deepEqual(comparison.changed[0]?.fingerprintEffects, ["contract", "execution"]);
  assert.match(report, /success criteria, write scope, tier, review policy/);
  assert.match(report, /fingerprint contract\+execution/);
  assert.match(report, /waves:.*→/);
  assert.match(report, /concurrency:.*→/);
  assert.match(report, /launch bounds:/);
  assert.match(report, /verification profiles:/);
  assert.equal(comparison.reference.length, 16);
});

test("bounded comparison output gives a deterministic task-detail reference", () => {
  const current: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const candidate: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  for (let index = 0; index < 30; index += 1) {
    createTask(current, {
      title: `Before ${index}`,
      brief: `Before ${index}`,
      tier: "standard",
      writePaths: [`src/${index}.ts`],
      successCriteria: ["before"],
    });
    createTask(candidate, {
      title: `After ${index}`,
      brief: `After ${index}`,
      tier: "complex",
      writePaths: [`lib/${index}.ts`],
      successCriteria: ["after"],
    });
  }
  const comparison = comparePlans(current, candidate, DEFAULT_CONFIG);
  const first = formatPlanComparison(
    comparison,
    "/maestro plan compare large.json",
    undefined,
    500
  );
  const second = formatPlanComparison(
    comparison,
    "/maestro plan compare large.json",
    undefined,
    500
  );
  assert.equal(first, second);
  assert.ok(first.length <= 500);
  assert.match(first, new RegExp(`reference ${comparison.reference}`));
  assert.match(first, /<taskId>/);
});
