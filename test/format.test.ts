import assert from "node:assert/strict";
import test from "node:test";
import {
  boardUsage,
  boardUsageSummary,
  describeProgressDelta,
  formatBoardProgress,
  formatCostSummary,
  formatTokens,
  formatUsage,
  runBudgetWarning,
  taskLine,
  taskUsage,
  truncateText,
} from "../src/format.js";
import { type Attempt, type Task, type TaskStatus } from "../src/types.js";

function makeAttempt(cost: number, turns: number): Attempt {
  return {
    index: 1,
    sessionDir: "/tmp/x",
    logFile: "/tmp/x.jsonl",
    thinking: "medium",
    startedAt: 0,
    usage: { input: 1000, output: 500, cost, turns },
    touchedFiles: [],
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "T1",
    title: "Do thing",
    brief: "brief",
    tier: "standard",
    status: "todo",
    dependsOn: [],
    attempts: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("describeProgressDelta reports net status changes between pulses", () => {
  const first = [makeTask({ id: "T1", status: "todo" }), makeTask({ id: "T2", status: "running" })];

  // No baseline on the first pulse: nothing to compare against yet.
  assert.equal(describeProgressDelta(undefined, first), undefined);

  const baseline = new Map<string, TaskStatus>([
    ["T1", "todo"],
    ["T2", "running"],
  ]);
  const advanced = [
    makeTask({ id: "T1", status: "running" }),
    makeTask({ id: "T2", status: "ready_for_review" }),
  ];
  assert.equal(
    describeProgressDelta(baseline, advanced),
    "Advanced since last pulse: T1 todo → running, T2 running → ready for review"
  );

  assert.equal(describeProgressDelta(baseline, first), "No status change since last pulse.");
});

test("formatTokens scales units", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12345), "12k");
  assert.equal(formatTokens(2_500_000), "2.5M");
});

test("taskUsage sums attempts and boardUsage sums tasks", () => {
  const task = makeTask({ attempts: [makeAttempt(0.01, 2), makeAttempt(0.02, 3)] });
  assert.equal(taskUsage(task).cost.toFixed(2), "0.03");
  assert.equal(taskUsage(task).turns, 5);
  const total = boardUsage([task, makeTask({ attempts: [makeAttempt(0.1, 1)] })]);
  assert.equal(total.cost.toFixed(2), "0.13");
});

test("boardUsageSummary reports attempts, meaningful average cost, models, and providers", () => {
  const openAiAttempt = makeAttempt(0.02, 1);
  openAiAttempt.model = "openai/gpt-5-mini";
  const emptyProviderFailure = makeAttempt(0, 0);
  emptyProviderFailure.usage.input = 0;
  emptyProviderFailure.usage.output = 0;
  emptyProviderFailure.model = "openai/gpt-5-mini";
  const anthropicAttempt = makeAttempt(0.04, 2);
  anthropicAttempt.model = "anthropic/claude-sonnet";

  assert.deepEqual(
    boardUsageSummary([
      makeTask({ attempts: [openAiAttempt, emptyProviderFailure] }),
      makeTask({ attempts: [anthropicAttempt] }),
    ]),
    {
      totalAttempts: 3,
      totalCost: 0.06,
      averageMeaningfulCost: 0.03,
      models: ["openai/gpt-5-mini", "anthropic/claude-sonnet"],
      providers: ["openai", "anthropic"],
    }
  );
  assert.deepEqual(boardUsageSummary([]), {
    totalAttempts: 0,
    totalCost: 0,
    averageMeaningfulCost: 0,
    models: [],
    providers: [],
  });
});

test("formatCostSummary stays compact and omits unavailable identities", () => {
  const attempt = makeAttempt(0.02, 1);
  attempt.model = "openai/gpt-5-mini";
  assert.equal(
    formatCostSummary([makeTask({ attempts: [attempt] })]),
    "1 attempt · $0.0200 total · $0.0200 avg billed attempt · models: openai/gpt-5-mini · providers: openai"
  );
  assert.equal(formatCostSummary([]), "0 attempts · $0.0000 total · $0.0000 avg billed attempt");
});

test("formatBoardProgress excludes cancelled tasks from active progress", () => {
  const tasks = [
    makeTask({ id: "T1", status: "approved" }),
    makeTask({ id: "T2", status: "approved" }),
    makeTask({ id: "T3", status: "cancelled" }),
  ];

  assert.equal(formatBoardProgress(tasks), "2/2 · 1 cancelled");
  assert.equal(formatBoardProgress(tasks.slice(0, 2)), "2/2");
});

test("run budget gates only when total board cost exceeds a positive cap", () => {
  const tasks = [makeTask({ attempts: [makeAttempt(5, 1)] })];
  assert.equal(runBudgetWarning(tasks, 0), undefined);
  assert.equal(runBudgetWarning(tasks, 5), undefined);
  assert.equal(runBudgetWarning(tasks, 4), "run budget exceeded ($5.0000 of $4)");
});

test("formatUsage renders compact parts", () => {
  const text = formatUsage({ input: 12000, output: 800, cost: 0.0512, turns: 4 });
  assert.equal(text, "4 turns ↑12k ↓800 $0.0512");
});

test("taskLine shows status, retries, and cost", () => {
  const task = makeTask({
    status: "ready_for_review",
    attempts: [makeAttempt(0.01, 2), makeAttempt(0.02, 1)],
  });
  const line = taskLine(task);
  assert.match(line, /● T1 Do thing · ready for review/);
  assert.match(line, /attempt 2/);
  assert.match(line, /\$0.0300/);
});

test("truncateText keeps short text and truncates long text", () => {
  assert.equal(truncateText("a\nb", 5), "a\nb");
  const truncated = truncateText("1\n2\n3\n4\n5", 2);
  assert.match(truncated, /^1\n2\n… \(3 more lines\)$/);
});
