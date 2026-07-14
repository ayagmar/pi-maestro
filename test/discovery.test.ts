import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTask, loadBoard, saveBoard } from "../src/board.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  buildDiscoveryBoard,
  DISCOVERY_TOOLS,
  formatDiscoveryPreview,
  MAX_DISCOVERY_ITEMS,
  MAX_DISCOVERY_REPORT_BYTES,
  parseDiscoveryOutput,
} from "../src/discovery.js";
import { type Board, type MaestroConfig, type Task, type TierConfig } from "../src/types.js";
import { executeTask, type StartExecutor } from "../src/workflow.js";

function config(): MaestroConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function discoveryBoard(): { board: Board; task: Task } {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const task = createTask(board, {
    title: "Discover work",
    brief: "Read-only investigation with no-file changes",
    tier: "standard",
    writePaths: [],
    discovery: { allowedWritePaths: ["src/**", "docs/guide.md"] },
  });
  return { board, task };
}

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "pi-maestro-discovery",
    version: 1,
    items: [
      {
        key: "core",
        title: "Implement core",
        brief: "Implement the core behavior",
        tier: "standard",
        writePaths: ["src/core.ts"],
        successCriteria: ["Core works"],
        dependsOn: [],
      },
    ],
    ...overrides,
  });
}

function firstItem(report: string): Record<string, unknown> {
  const parsed = JSON.parse(report) as { items: Array<Record<string, unknown>> };
  const item = parsed.items[0];
  assert.ok(item);
  return item;
}

test("discovery output is strict, bounded, and rejects executable fields", () => {
  for (const field of ["command", "script", "shell", "hooks"]) {
    const item = firstItem(output());
    item[field] = "touch owned";
    assert.throws(() => parseDiscoveryOutput(output({ items: [item] })), /unknown field/i);
  }
  const emptyProfile = firstItem(output());
  emptyProfile.verificationProfile = "";
  assert.throws(
    () => parseDiscoveryOutput(output({ items: [emptyProfile] })),
    /verificationProfile is invalid/
  );
  assert.throws(
    () => parseDiscoveryOutput(`${" ".repeat(MAX_DISCOVERY_REPORT_BYTES)}xx`),
    /exceeds/
  );
  const item = firstItem(output());
  assert.throws(
    () => parseDiscoveryOutput(output({ items: Array(MAX_DISCOVERY_ITEMS + 1).fill(item) })),
    /more than/
  );
});

test("discovery normalizes values and rejects duplicate item keys", () => {
  const first = firstItem(output());
  first.writePaths = ["./src/b.ts", "src/b.ts", "src/a.ts"];
  first.successCriteria = [" A works ", "B works", "A works"];
  first.dependsOn = ["T1", "t1"];
  const normalized = parseDiscoveryOutput(output({ items: [first] }));
  assert.deepEqual(normalized.items[0]?.writePaths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(normalized.items[0]?.successCriteria, ["A works", "B works"]);
  assert.deepEqual(normalized.items[0]?.dependsOn, ["T1"]);

  assert.throws(
    () =>
      parseDiscoveryOutput(
        output({ items: [firstItem(output()), { ...firstItem(output()), key: "CORE" }] })
      ),
    /Duplicate discovery item key/
  );
});

test("discovery rejects unsafe scopes and invalid ordinary task contracts", () => {
  const { board, task } = discoveryBoard();
  const invalid: Array<{ change: (item: Record<string, unknown>) => void; error: RegExp }> = [
    { change: (item) => (item.writePaths = []), error: /non-empty write scope/ },
    { change: (item) => (item.writePaths = ["/tmp/owned"]), error: /repository-relative/ },
    { change: (item) => (item.writePaths = ["../owned"]), error: /repository-relative/ },
    { change: (item) => (item.writePaths = ["test/owned.ts"]), error: /outside.*scope/ },
    { change: (item) => (item.tier = "unknown"), error: /unknown tier/ },
    { change: (item) => (item.verificationProfile = "unknown"), error: /Unknown verification/ },
    { change: (item) => (item.dependsOn = ["missing"]), error: /unknown dependency/ },
  ];
  for (const entry of invalid) {
    const item = firstItem(output());
    entry.change(item);
    assert.throws(
      () => buildDiscoveryBoard(board, task.id, output({ items: [item] }), "append", config()),
      entry.error
    );
  }
});

test("discovery scope semantics require an exact file or an explicit recursive scope", () => {
  const exact = discoveryBoard();
  exact.task.discovery = { allowedWritePaths: ["src"] };
  assert.throws(
    () => buildDiscoveryBoard(exact.board, exact.task.id, output(), "append", config()),
    /outside.*scope/
  );

  exact.task.discovery = { allowedWritePaths: ["src/**"] };
  assert.doesNotThrow(() =>
    buildDiscoveryBoard(exact.board, exact.task.id, output(), "append", config())
  );
});

test("discovery maps dependencies deterministically and always gates the plan", () => {
  const { board, task } = discoveryBoard();
  const first = firstItem(output());
  first.key = "first";
  const second = firstItem(output());
  second.key = "second";
  second.title = "Implement second";
  second.writePaths = ["src/second.ts"];
  second.dependsOn = ["first"];
  second.reviewPolicy = "find-and-refute";

  const appended = buildDiscoveryBoard(
    board,
    task.id,
    output({ items: [first, second] }),
    "append",
    config()
  );
  assert.equal(appended.planPending, true);
  assert.deepEqual(appended.tasks.at(-1)?.dependsOn, ["T2"]);

  const replaced = buildDiscoveryBoard(
    board,
    task.id,
    output({ items: [first, second] }),
    "replace",
    config()
  );
  assert.deepEqual(
    replaced.tasks.map(({ id }) => id),
    ["T1", "T2"]
  );
  assert.deepEqual(replaced.tasks[1]?.dependsOn, ["T1"]);
  assert.equal(replaced.tasks[1]?.reviewPolicy, "find-and-refute");
});

test("discovery preview is deterministic and bounded", () => {
  const item = firstItem(output());
  item.title = "x".repeat(500);
  const parsed = parseDiscoveryOutput(
    output({
      items: Array.from({ length: MAX_DISCOVERY_ITEMS }, (_, index) => ({
        ...item,
        key: `item_${index}`,
      })),
    })
  );
  const first = formatDiscoveryPreview(parsed, "append");
  assert.equal(first, formatDiscoveryPreview(parsed, "append"));
  assert.ok(first.length <= 4_000);
});

test("discovery honors configured generated-task and total-plan limits", () => {
  const { board, task } = discoveryBoard();
  const first = firstItem(output());
  const second = { ...first, key: "second", writePaths: ["src/second.ts"] };
  const settings = config();
  settings.maxDiscoveryGeneratedTasks = 1;
  assert.throws(
    () =>
      buildDiscoveryBoard(board, task.id, output({ items: [first, second] }), "append", settings),
    /more than 1/
  );

  settings.maxDiscoveryGeneratedTasks = 2;
  settings.maxPlanTasks = 2;
  assert.throws(
    () =>
      buildDiscoveryBoard(board, task.id, output({ items: [first, second] }), "append", settings),
    /3 tasks.*maxPlanTasks is 2/
  );
});

test("discovery executors use the narrow read-only tool list without changing regular tasks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-discovery-launch-"));
  try {
    const { board, task } = discoveryBoard();
    saveBoard(cwd, board);
    const seenTools: Array<string | undefined> = [];
    const startExecutor: StartExecutor = (options) => {
      seenTools.push(options.tier.tools);
      return {
        attempt: {
          index: 0,
          logFile: "attempt.jsonl",
          thinking: options.tier.thinking,
          startedAt: Date.now(),
          usage: { input: 0, output: 0, cost: 0, turns: 0 },
          touchedFiles: [],
        },
        outcome: Promise.resolve({
          exitCode: 0,
          usage: { input: 1, output: 1, cost: 0, turns: 1 },
          finalReport: output(),
          touchedFiles: [],
          aborted: false,
        }),
        steer: () => {},
        followUp: () => {},
        abort: () => {},
      };
    };
    const resolvedConfig = config();
    const standardTier = resolvedConfig.tiers.standard;
    assert.ok(standardTier);
    const tier: TierConfig = { ...standardTier, tools: "read,bash" };
    await executeTask({
      cwd,
      board: loadBoard(cwd),
      task,
      tier,
      config: resolvedConfig,
      startExecutor,
      onUpdate: () => {},
      trackRun: () => () => {},
    });
    const regularBoard = loadBoard(cwd);
    const regularTask = createTask(regularBoard, {
      title: "Regular task",
      brief: "Implement regular work",
      tier: "standard",
      writePaths: ["src/regular.ts"],
      successCriteria: ["Regular work passes"],
    });
    saveBoard(cwd, regularBoard);
    await executeTask({
      cwd,
      board: loadBoard(cwd),
      task: regularTask,
      tier,
      config: resolvedConfig,
      startExecutor,
      onUpdate: () => {},
      trackRun: () => () => {},
    });
    assert.deepEqual(seenTools, [DISCOVERY_TOOLS, "read,bash"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
