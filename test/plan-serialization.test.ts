import assert from "node:assert/strict";
import test from "node:test";
import { createTask } from "../src/board.js";
import { exportPlan, importPlan } from "../src/plan-serialization.js";
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
