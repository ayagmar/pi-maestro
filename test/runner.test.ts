import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  applyAssistantMessage,
  cappedLogWriter,
  classifyFailure,
  mapWithConcurrencyLimit,
  projectSessionDir,
  type RunOutcome,
  redactFailureMessage,
  runVerification,
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
    console.log(JSON.stringify({ type: "agent_settled" }));
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

test("executor sessions are nested under the main project Pi directory and hidden from resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-sessions-"));
  const projectCwd = join(root, "project");
  const worktreeCwd = join(root, "worktree");
  const fakePi = join(root, "fake-pi.mjs");
  const argsFile = join(root, "args.json");
  mkdirSync(projectCwd, { recursive: true });
  mkdirSync(worktreeCwd, { recursive: true });
  writeFileSync(
    fakePi,
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, "child.jsonl");
writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    if (command.type === "get_state") console.log(JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionFile } }));
    if (command.type === "prompt") console.log(JSON.stringify({ type: "agent_settled" }));
  }
});
process.stdin.on("end", () => process.exit(0));
`
  );

  const originalScript = process.argv[1];
  if (originalScript === undefined) throw new Error("test runner script path is unavailable");
  process.argv[1] = fakePi;
  try {
    const sessionRoot = projectSessionDir(projectCwd);
    mkdirSync(sessionRoot, { recursive: true });
    writeFileSync(
      join(sessionRoot, "human.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "human", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectCwd })}\n`
    );

    const run = startExecutor({
      stateDir: join(projectCwd, ".pi", "maestro"),
      runId: "../../escape reviewer",
      cwd: worktreeCwd,
      projectCwd,
      prompt: "run",
      tier: { thinking: "low" },
    });
    await run.outcome;

    assert.ok(run.attempt.sessionDir);
    assert.equal(dirname(run.attempt.sessionDir), join(sessionRoot, ".maestro"));
    assert.match(
      relative(join(sessionRoot, ".maestro"), run.attempt.sessionDir),
      /^escape-reviewer-[0-9a-f-]+$/u
    );
    assert.equal(dirname(run.attempt.sessionFile ?? ""), run.attempt.sessionDir);

    const invocationArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    const sessionDirIndex = invocationArgs.indexOf("--session-dir");
    assert.notEqual(sessionDirIndex, -1);
    assert.equal(invocationArgs[sessionDirIndex + 1], run.attempt.sessionDir);

    const visibleSessions = await SessionManager.list(projectCwd);
    assert.deepEqual(
      visibleSessions.map((session) => session.id),
      ["human"]
    );
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor signal termination is recorded as a process failure", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-signal-"));
  const fakePi = join(root, "signal-pi.mjs");
  writeFileSync(
    fakePi,
    `process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString().split("\\n")) {
    if (line && JSON.parse(line).type === "prompt") process.kill(process.pid, "SIGTERM");
  }
});
`
  );

  const originalScript = process.argv[1];
  if (originalScript === undefined) throw new Error("test runner script path is unavailable");
  process.argv[1] = fakePi;
  try {
    const run = startExecutor({
      stateDir: root,
      runId: "signal",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
    });
    const outcome = await run.outcome;
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.failureCause, "process");
    assert.equal(outcome.failureReason?.kind, "executor_failure");
    assert.match(outcome.errorMessage ?? "", /terminated by SIGTERM/);
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor steering and follow-up send exact RPC payloads", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-messages-"));
  const fakePi = join(root, "fake-pi.mjs");
  const commandsFile = join(root, "commands.jsonl");
  writeFileSync(
    fakePi,
    `import { appendFileSync } from "node:fs";
let buffer = "";
let finishTimer;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    appendFileSync(${JSON.stringify(commandsFile)}, JSON.stringify(command) + "\\n");
    if (command.type === "prompt" && !finishTimer) {
      finishTimer = setTimeout(() => {
        console.log(JSON.stringify({ type: "agent_end" }));
        console.log(JSON.stringify({ type: "agent_settled" }));
      }, 40);
    }
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
      runId: "messages",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
    });
    run.steer("change direction");
    run.followUp("then summarize");
    await run.outcome;

    const messages = readFileSync(commandsFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((command) => command.type === "steer" || command.type === "follow_up");
    assert.deepEqual(messages, [
      { type: "steer", message: "change direction" },
      { type: "follow_up", message: "then summarize" },
    ]);
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor remains available through continuation events until agent_settled", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-settled-"));
  const fakePi = join(root, "fake-pi.mjs");
  const lifecycleFile = join(root, "lifecycle.jsonl");
  writeFileSync(
    fakePi,
    `import { appendFileSync } from "node:fs";
let buffer = "";
let settled = false;
process.on("SIGTERM", () => appendFileSync(${JSON.stringify(lifecycleFile)}, JSON.stringify({ event: "sigterm", settled }) + "\\n"));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    if (command.type !== "prompt") continue;
    console.log(JSON.stringify({ type: "agent_end", willRetry: true }));
    setTimeout(() => {
      console.log(JSON.stringify({ type: "auto_retry_start", attempt: 1 }));
      console.log(JSON.stringify({ type: "agent_start" }));
      console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "continued after retry" }] } }));
      settled = true;
      console.log(JSON.stringify({ type: "agent_settled" }));
      setTimeout(() => process.exit(0), 10);
    }, 20);
  }
});
process.stdin.on("end", () => appendFileSync(${JSON.stringify(lifecycleFile)}, JSON.stringify({ event: "stdin-end", settled }) + "\\n"));
`
  );

  const originalScript = process.argv[1];
  if (originalScript === undefined) throw new Error("test runner script path is unavailable");
  process.argv[1] = fakePi;
  try {
    const run = startExecutor({
      stateDir: root,
      runId: "settled",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
    });
    const outcome = await run.outcome;
    const lifecycle = readFileSync(lifecycleFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; settled: boolean });

    assert.equal(outcome.finalReport, "continued after retry");
    assert.deepEqual(lifecycle, [{ event: "stdin-end", settled: true }]);
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor decodes a UTF-8 JSON character split across stdout chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-utf8-"));
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
    const event = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "café" }] } }) + "\\n");
    const character = Buffer.from("é");
    const splitAt = event.indexOf(character) + 1;
    process.stdout.write(event.subarray(0, splitAt));
    setTimeout(() => {
      process.stdout.write(event.subarray(splitAt));
      console.log(JSON.stringify({ type: "agent_end" }));
      setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 5);
    }, 5);
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
      runId: "utf8",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
    });
    const outcome = await run.outcome;

    assert.equal(outcome.finalReport, "café");
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted verification bounds output and reports pass, failure, and timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-verification-"));
  const passed = await runVerification({
    cwd: root,
    stateDir: root,
    name: "pass",
    command: `${process.execPath} -e "console.log('ok')"`,
    timeoutSeconds: 1,
  });
  assert.equal(passed.ok, true);
  assert.match(passed.outputTail, /ok/);

  const failed = await runVerification({
    cwd: root,
    stateDir: root,
    name: "fail",
    command: `${process.execPath} -e "process.exit(3)"`,
    timeoutSeconds: 1,
  });
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.ok, false);

  const timedOut = await runVerification({
    cwd: root,
    stateDir: root,
    name: "timeout",
    command: `${process.execPath} -e "setTimeout(() => {}, 1000)"`,
    timeoutSeconds: 0.02,
  });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.ok, false);

  if (process.platform !== "win32") {
    const startedAt = Date.now();
    const ignoredTerm = await runVerification({
      cwd: root,
      stateDir: root,
      name: "ignored-term",
      command: `${process.execPath} -e "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"`,
      timeoutSeconds: 0.02,
    });
    assert.equal(ignoredTerm.timedOut, true);
    assert.ok(Date.now() - startedAt < 1000);
  }
});

test("wall-clock watchdog steers once and aborts a silent executor as stalled", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-watchdog-"));
  const fakePi = join(root, "silent-pi.mjs");
  writeFileSync(
    fakePi,
    `let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    if (command.type === "steer") console.error("steered");
    if (command.type === "abort") process.exit(1);
  }
});
`
  );
  const originalScript = process.argv[1];
  if (originalScript === undefined) throw new Error("test runner script path is unavailable");
  process.argv[1] = fakePi;
  try {
    const run = startExecutor({
      stateDir: root,
      runId: "silent",
      cwd: root,
      prompt: "hang",
      tier: { thinking: "low" },
      watchdogIdleSeconds: 0.02,
      watchdogWarningTurns: 12,
      watchdogTerminationTurns: 4,
    });
    const outcome = await run.outcome;
    assert.equal(outcome.failureCause, "stalled");
    assert.equal(outcome.failureReason?.kind, "stalled");
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
