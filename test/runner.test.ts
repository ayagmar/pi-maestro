import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  applyAssistantMessage,
  cappedLogWriter,
  classifyFailure,
  mapWithConcurrencyLimit,
  redactFailureMessage,
  type RunOutcome,
  startExecutor,
  touchedFile,
} from "../src/runner.js";
import { type Attempt } from "../src/types.js";

test("capped run logs stop at the byte limit without stopping outcome tracking", () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const writeLogLine = cappedLogWriter(output, 12);

  writeLogLine("1234567");
  writeLogLine("abcdefgh");
  writeLogLine("ignored");

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
  };
  applyAssistantMessage(outcome, attempt, {
    role: "assistant",
    usage: { input: 3, output: 2, cost: { total: 0.01 } },
    content: [{ type: "text", text: "completed after log cap" }],
  });

  assert.equal(Buffer.concat(chunks).length, 12);
  assert.equal(Buffer.concat(chunks).toString(), "1234567\nabcd");
  assert.equal(outcome.finalReport, "completed after log cap");
  assert.equal(outcome.usage.turns, 1);
});

test("a zero log cap leaves logging unlimited", () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const writeLogLine = cappedLogWriter(output, 0);

  writeLogLine("first");
  writeLogLine("second");

  assert.equal(Buffer.concat(chunks).toString(), "first\nsecond\n");
});

test("startExecutor caps its actual log while continuing to track later events", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-"));
  const fakePi = join(root, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    `let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    if (command.type !== "prompt") continue;
    console.log(JSON.stringify({ type: "noise", data: "x".repeat(200) }));
    console.log(JSON.stringify({ type: "tool_execution_start", toolName: "write", args: { path: "after-cap.ts" } }));
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "test/model", usage: { input: 7, output: 3, cost: { total: 0.25 } }, content: [{ type: "text", text: "finished after cap" }] } }));
    console.log(JSON.stringify({ type: "agent_end" }));
  }
});
process.stdin.on("end", () => process.exit(0));
`
  );

  const originalScript = process.argv[1];
  if (originalScript === undefined) throw new Error("test runner script path is unavailable");
  process.argv[1] = fakePi;
  try {
    const run = startExecutor({
      stateDir: root,
      runId: "capped",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
      maxLogBytes: 64,
    });
    const outcome = await run.outcome;

    assert.equal(readFileSync(run.attempt.logFile).byteLength, 64);
    assert.equal(outcome.finalReport, "finished after cap");
    assert.deepEqual(outcome.touchedFiles, ["after-cap.ts"]);
    assert.deepEqual(outcome.usage, { input: 7, output: 3, cost: 0.25, turns: 1 });
    assert.equal(outcome.model, "test/model");
    assert.equal(outcome.exitCode, 0);
  } finally {
    process.argv[1] = originalScript;
  }
});

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
