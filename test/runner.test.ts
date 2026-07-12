import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAssistantMessage,
  classifyFailure,
  mapWithConcurrencyLimit,
  redactFailureMessage,
  type RunOutcome,
  touchedFile,
} from "../src/runner.js";
import { type Attempt } from "../src/types.js";

test("touchedFile picks up write/edit paths from tool_execution_start", () => {
  // pi's JSON stream carries args on tool_execution_start; tool_execution_end has args: null
  assert.equal(
    touchedFile(
      { type: "tool_execution_start", toolName: "write", args: { path: "/repo/a.ts" } },
      "/repo"
    ),
    "a.ts"
  );
  assert.equal(
    touchedFile(
      { type: "tool_execution_start", toolName: "edit", args: { path: "src/b.ts" } },
      "/repo"
    ),
    "src/b.ts"
  );
});

test("touchedFile ignores other tools and end events", () => {
  assert.equal(
    touchedFile(
      { type: "tool_execution_start", toolName: "bash", args: { command: "ls" } },
      "/repo"
    ),
    undefined
  );
  assert.equal(
    touchedFile(
      { type: "tool_execution_end", toolName: "write", args: { path: "/repo/a.ts" } },
      "/repo"
    ),
    undefined
  );
});

test("classifyFailure distinguishes provider, executor, user abort, and cost-cap failures", () => {
  const usage = { input: 1, output: 1, cost: 0.01, turns: 1 };

  assert.equal(
    classifyFailure({ aborted: false, exitCode: 1, errorMessage: "quota exhausted", usage })?.kind,
    "provider_failure"
  );
  assert.equal(
    classifyFailure({ aborted: false, exitCode: 1, errorMessage: "HTTP 429", usage })?.kind,
    "provider_failure"
  );
  assert.equal(
    classifyFailure({ aborted: false, exitCode: 1, errorMessage: "tests failed", usage })?.kind,
    "executor_failure"
  );
  assert.equal(classifyFailure({ aborted: true, exitCode: 1, usage })?.kind, "user_abort");
  assert.equal(
    classifyFailure({
      aborted: false,
      exitCode: 1,
      errorMessage: "cost cap exceeded: $1.00 > $0.50",
      usage,
    })?.kind,
    "cost_cap"
  );
});

test("explicit abort and process causes override stale provider text and zero turns", () => {
  const usage = { input: 0, output: 0, cost: 0, turns: 0 };

  assert.equal(
    classifyFailure({
      aborted: true,
      exitCode: 1,
      errorMessage: "quota exhausted",
      failureCause: "user_abort",
      usage,
    })?.kind,
    "user_abort"
  );
  assert.equal(
    classifyFailure({
      aborted: false,
      exitCode: 1,
      errorMessage: "spawn pi ENOENT",
      failureCause: "process",
      usage,
    })?.kind,
    "executor_failure"
  );
});

test("successful assistant event crossing the cost cap retains a cost-cap failure", () => {
  const usage = { input: 0, output: 0, cost: 0, turns: 0 };
  const attempt: Attempt = {
    index: 1,
    logFile: "attempt.jsonl",
    thinking: "low",
    startedAt: 1,
    usage,
    touchedFiles: [],
  };
  const outcome: RunOutcome = {
    exitCode: 0,
    usage,
    finalReport: "",
    touchedFiles: [],
    aborted: false,
    errorMessage: "transient provider error",
    failureCause: "provider",
  };

  const exceeded = applyAssistantMessage(
    outcome,
    attempt,
    {
      role: "assistant",
      usage: { input: 10, output: 5, cost: { total: 0.12 } },
      content: [{ type: "text", text: "Work completed" }],
    },
    0.1
  );

  assert.equal(exceeded, true);
  assert.equal(outcome.errorMessage, "cost cap exceeded: $0.1200 > $0.1 (maxCostPerTask)");
  assert.equal(outcome.failureCause, "cost_cap");
  assert.equal(classifyFailure(outcome)?.kind, "cost_cap");
  assert.equal(outcome.finalReport, "Work completed");
  assert.equal(outcome.usage.cost, 0.12);
});

test("failure messages redact common credentials", () => {
  assert.equal(
    redactFailureMessage("token=top-secret Bearer abc.def sk-abcdefgh12345678"),
    "token=[REDACTED] Bearer [REDACTED] [REDACTED]"
  );
});

test("mapWithConcurrencyLimit preserves order and limits concurrency", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrencyLimit([10, 20, 30, 40, 50], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 2;
  });
  assert.deepEqual(results, [20, 40, 60, 80, 100]);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test("mapWithConcurrencyLimit handles empty input", async () => {
  assert.deepEqual(await mapWithConcurrencyLimit([], 4, async () => 1), []);
});
