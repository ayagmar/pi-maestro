import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  applyAssistantMessage,
  boundedReportBytes,
  cappedLogWriter,
  classifyFailure,
  detachedAttemptIsLive,
  mapWithConcurrencyLimit,
  projectSessionDir,
  type RunOutcome,
  reattachDetachedExecutor,
  redactFailureMessage,
  runVerification,
  startExecutor,
  touchedFile,
  windowsTaskkillArguments,
} from "../src/runner.js";
import { type Attempt } from "../src/types.js";

const wait = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

test("byte-bounded reports do not split UTF-8 or exceed their limit", () => {
  const bounded = boundedReportBytes("é".repeat(40_000), 64_000);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 64_000);
  assert.doesNotMatch(bounded, /�/);
});

test("byte-bounded reports preserve legitimate replacement characters in content", () => {
  const report = `${"A".repeat(10)}\uFFFD${"B".repeat(40_000)}`;
  const started = Date.now();
  const bounded = boundedReportBytes(report, 16_000);
  assert.ok(Date.now() - started < 1_000, "bounding must not scan character by character");
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 16_000);
  // The head half of the bound is ~7,900 bytes; the legitimate U+FFFD at
  // offset 10 must survive instead of being trimmed away as a split artifact.
  assert.ok(bounded.startsWith(`${"A".repeat(10)}\uFFFD`));
});

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

test("detached executor transport persists PID-safe control and event files", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-detached-"));
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
    console.log(JSON.stringify({ type: "tool_execution_start", toolName: "write", args: { path: "detached.ts" } }));
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "test/model", usage: { input: 4, output: 2, cost: { total: 0.03 } }, content: [{ type: "text", text: "detached complete" }] } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
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
      runId: "detached",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
      detached: true,
    });
    const reattached = reattachDetachedExecutor(structuredClone(run.attempt), root);
    const [outcome, recoveredOutcome] = await Promise.all([run.outcome, reattached.outcome]);

    assert.equal(run.survivesShutdown, true);
    assert.equal(run.attempt.detached, true);
    assert.ok(run.attempt.pid);
    assert.ok(run.attempt.processStartId || process.platform !== "linux");
    assert.match(readFileSync(run.attempt.controlFile ?? "", "utf-8"), /"type":"prompt"/);
    assert.match(readFileSync(run.attempt.logFile, "utf-8"), /agent_settled/);
    assert.deepEqual(outcome.touchedFiles, ["detached.ts"]);
    assert.equal(outcome.finalReport, "detached complete");
    assert.equal(outcome.usage.turns, 1);
    assert.equal(outcome.exitCode, 0);
    assert.equal(reattached.survivesShutdown, true);
    assert.equal(recoveredOutcome.finalReport, "detached complete");
    assert.equal(recoveredOutcome.usage.turns, 1);
    assert.equal(recoveredOutcome.exitCode, 0);
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached supervision cancels UI requests and enforces compact byte-bounded logs", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-detached-safety-"));
  const fakePi = join(root, "fake-pi.mjs");
  const responseFile = join(root, "ui-response.json");
  writeFileSync(
    fakePi,
    `import { writeFileSync } from "node:fs";
let buffer = "";
let asked = false;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    if (command.type === "prompt" && !asked) {
      asked = true;
      console.log(JSON.stringify({ type: "extension_ui_request", id: "approval-1" }));
      for (let index = 0; index < 100; index++) console.log(JSON.stringify({ type: "noise", data: "x".repeat(200) }));
    }
    if (command.type === "extension_ui_response") {
      writeFileSync(${JSON.stringify(responseFile)}, JSON.stringify(command));
      console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0.01 } }, content: [{ type: "text", text: "detached UI handled" }] } }));
      console.log(JSON.stringify({ type: "agent_settled" }));
    }
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
      runId: "detached-safety",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
      detached: true,
      logEvents: "compact",
      maxLogBytes: 512,
    });
    const outcome = await run.outcome;
    const response = JSON.parse(readFileSync(responseFile, "utf8")) as Record<string, unknown>;
    const log = readFileSync(run.attempt.logFile, "utf8");
    assert.equal(response.cancelled, true);
    assert.equal(outcome.finalReport, "detached UI handled");
    assert.ok(statSync(run.attempt.logFile).size <= 512);
    assert.doesNotThrow(() => {
      for (const line of log.split("\n").filter(Boolean)) JSON.parse(line);
    });
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached supervision reports a cost-cap abort", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-detached-cost-"));
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
    if (command.type === "prompt") console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 1 } }, content: [{ type: "text", text: "over budget" }] } }));
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
      runId: "detached-cost",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
      detached: true,
      maxCost: 0.1,
    });
    const outcome = await run.outcome;
    assert.equal(outcome.failureCause, "cost_cap");
    assert.equal(outcome.aborted, false);
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached watchdog gives post-steer work its grace period", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-watchdog-"));
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
    if (command.type === "steer") setTimeout(() => {
      console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "detached finished after steer" }] } }));
      console.log(JSON.stringify({ type: "agent_settled" }));
    }, 30);
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
      runId: "detached-watchdog",
      cwd: root,
      prompt: "finish after steering",
      tier: { thinking: "low" },
      detached: true,
      watchdogIdleSeconds: 0.02,
      watchdogWarningTurns: 12,
      watchdogTerminationTurns: 20,
    });
    const outcome = await run.outcome;
    assert.equal(outcome.failureCause, undefined);
    assert.equal(outcome.finalReport, "detached finished after steer");
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached full logs reach their cap without partial records or lost outcomes", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-full-log-"));
  const fakePi = join(root, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    `let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (JSON.parse(line).type !== "prompt") continue;
    for (let index = 0; index < 30; index++) console.log(JSON.stringify({ type: "noise", index, data: "é".repeat(100) }));
    const event = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "café after cap" }] } }) + "\\n");
    const split = event.indexOf(Buffer.from("é")) + 1;
    process.stdout.write(event.subarray(0, split));
    setTimeout(() => {
      process.stdout.write(event.subarray(split));
      console.log(JSON.stringify({ type: "agent_settled" }));
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
      runId: "detached-full-log",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
      detached: true,
      logEvents: "full",
      maxLogBytes: 600,
    });
    const outcome = await run.outcome;
    const log = readFileSync(run.attempt.logFile, "utf8");
    const records = log.split("\n").filter(Boolean);
    assert.ok(Buffer.byteLength(log) > 400);
    assert.ok(Buffer.byteLength(log) <= 600);
    assert.ok(records.length < 30, "the generated full event stream must actually hit the cap");
    for (const record of records) assert.doesNotThrow(() => JSON.parse(record));
    assert.equal(outcome.finalReport, "café after cap");
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached transport preserves reports within an explicitly raised bound", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-report-limit-"));
  const fakePi = join(root, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    `let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) if (JSON.parse(line).type === "prompt") {
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(17_000) }] } }));
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
      runId: "detached-report-limit",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
      detached: true,
      maxReportChars: 64_000,
      maxReportBytes: 64_000,
    });
    const outcome = await run.outcome;
    assert.equal(outcome.finalReport, "x".repeat(17_000));
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached process failures retain bounded stderr and one terminal outcome", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-process-failure-"));
  const fakePi = join(root, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    `process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString().split("\\n")) {
    if (line && JSON.parse(line).type === "prompt") {
      process.stderr.write("x".repeat(20_000) + "END-OF-STDERR");
      process.exit(7);
    }
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
      runId: "detached-process-failure",
      cwd: root,
      prompt: "fail",
      tier: { thinking: "low" },
      detached: true,
    });
    let resolutions = 0;
    void run.outcome.then(() => {
      resolutions += 1;
    });
    const outcome = await run.outcome;
    await wait(150);
    assert.equal(outcome.exitCode, 7);
    assert.equal(outcome.failureCause, "process");
    assert.match(outcome.errorMessage ?? "", /END-OF-STDERR/);
    assert.ok(statSync(run.attempt.stderrFile ?? "").size <= 16_000);
    assert.equal(resolutions, 1);
    const terminal = JSON.parse(readFileSync(run.attempt.exitFile ?? "", "utf8")) as {
      version: number;
      exitCode: number;
    };
    assert.deepEqual(
      { version: terminal.version, exitCode: terminal.exitCode },
      { version: 1, exitCode: 7 }
    );
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached monitor handles UTF-8 splits and log truncation incrementally", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-tail-"));
  const logFile = join(root, "events.jsonl");
  const controlFile = join(root, "control.jsonl");
  const exitFile = join(root, "exit.json");
  writeFileSync(logFile, "");
  writeFileSync(controlFile, "");
  const attempt: Attempt = {
    index: 1,
    logFile,
    thinking: "low",
    startedAt: Date.now(),
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
    detached: true,
    pid: process.pid,
    controlFile,
    exitFile,
  };
  try {
    const run = reattachDetachedExecutor(attempt, root);
    const first = Buffer.from(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "café before truncation" }] } })}\n`
    );
    const split = first.indexOf(Buffer.from("é")) + 1;
    appendFileSync(logFile, first.subarray(0, split));
    await wait(150);
    appendFileSync(logFile, first.subarray(split));
    await wait(150);

    truncateSync(logFile, 0);
    appendFileSync(
      logFile,
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "after truncation" }] } })}\n`
    );
    await wait(150);
    writeFileSync(exitFile, `${JSON.stringify({ version: 1, exitCode: 0 })}\n`);
    const outcome = await run.outcome;
    assert.equal(outcome.finalReport, "after truncation");
    assert.equal(outcome.usage.turns, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean detached terminal outcome outranks a racing local abort", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-abort-race-"));
  const logFile = join(root, "events.jsonl");
  const controlFile = join(root, "control.jsonl");
  const exitFile = join(root, "exit.json");
  writeFileSync(logFile, "");
  writeFileSync(controlFile, "");
  // A real live process in its own group so abort's group kill has a safe target.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const attempt: Attempt = {
    index: 1,
    logFile,
    thinking: "low",
    startedAt: Date.now(),
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
    detached: true,
    pid: sleeper.pid ?? 0,
    controlFile,
    exitFile,
  };
  try {
    const run = reattachDetachedExecutor(attempt, root);
    run.abort();
    writeFileSync(
      exitFile,
      `${JSON.stringify({ version: 1, exitCode: 0, aborted: false, finalReport: "finished before abort" })}\n`
    );
    const outcome = await run.outcome;
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.aborted, false);
    assert.equal(outcome.failureCause, undefined);
    assert.equal(outcome.finalReport, "finished before abort");
  } finally {
    try {
      if (sleeper.pid) process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("drive abort signals terminate a detached executor", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-signal-abort-"));
  const fakePi = join(root, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    `let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (JSON.parse(line).type === "abort") process.exit(1);
  }
});
`
  );
  const originalScript = process.argv[1];
  if (originalScript === undefined) throw new Error("test runner script path is unavailable");
  process.argv[1] = fakePi;
  try {
    const controller = new AbortController();
    const run = startExecutor({
      stateDir: root,
      runId: "signal-abort",
      cwd: root,
      prompt: "run until aborted",
      tier: { thinking: "low" },
      detached: true,
      signal: controller.signal,
    });
    await wait(200);
    controller.abort();
    const outcome = await run.outcome;
    assert.equal(outcome.aborted, true);
    assert.equal(outcome.failureCause, "user_abort");
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached supervisor survives its launching parent", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-parent-exit-"));
  const fakePi = join(root, "fake-pi.mjs");
  const helper = join(root, "launch.mts");
  const attemptFile = join(root, "attempt.json");
  writeFileSync(
    fakePi,
    `let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) if (JSON.parse(line).type === "prompt") setTimeout(() => {
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "completed without parent" }] } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
  }, 300);
});
process.stdin.on("end", () => process.exit(0));
`
  );
  writeFileSync(
    helper,
    `import { writeFileSync } from "node:fs";
import { startExecutor } from ${JSON.stringify(new URL("../src/runner.ts", import.meta.url).href)};
process.argv[1] = ${JSON.stringify(fakePi)};
const run = startExecutor({ stateDir: ${JSON.stringify(root)}, runId: "orphan", cwd: ${JSON.stringify(root)}, prompt: "run", tier: { thinking: "low" }, detached: true });
writeFileSync(${JSON.stringify(attemptFile)}, JSON.stringify(run.attempt));
`
  );
  try {
    execFileSync(process.execPath, ["--import=tsx", helper], { timeout: 5_000 });
    const attempt = JSON.parse(readFileSync(attemptFile, "utf8")) as Attempt;
    const run = reattachDetachedExecutor(attempt, root);
    const outcome = await run.outcome;
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.finalReport, "completed without parent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached event and stderr write failures still persist terminal failures", async () => {
  if (process.platform === "win32") return;
  const originalScript = process.argv[1];
  if (originalScript === undefined) throw new Error("test runner script path is unavailable");
  for (const surface of ["event", "stderr"] as const) {
    const root = mkdtempSync(join(tmpdir(), `maestro-detached-${surface}-write-`));
    const runId = `${surface}-write`;
    const fakePi = join(root, "fake-pi.mjs");
    const target =
      surface === "event"
        ? join(root, "logs", `${runId}.jsonl`)
        : join(root, "logs", `${runId}.jsonl.stderr`);
    writeFileSync(
      fakePi,
      `import { mkdirSync, rmSync } from "node:fs";
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      rmSync(${JSON.stringify(target)}, { force: true });
      mkdirSync(${JSON.stringify(target)});
      ${surface === "event" ? 'console.log(JSON.stringify({ type: "agent_start" }));' : 'process.stderr.write("cannot persist stderr");'}
    }
    if (command.type === "abort") process.exit(1);
  }
});
`
    );
    process.argv[1] = fakePi;
    try {
      const run = startExecutor({
        stateDir: root,
        runId,
        cwd: root,
        prompt: "trigger write failure",
        tier: { thinking: "low" },
        detached: true,
      });
      const outcome = await run.outcome;
      assert.equal(outcome.failureCause, "process");
      assert.match(outcome.errorMessage ?? "", new RegExp(`${surface} log write failed`));
      assert.ok(existsSync(run.attempt.exitFile ?? ""));
      const terminal = JSON.parse(readFileSync(run.attempt.exitFile ?? "", "utf8")) as {
        version: number;
        failureCause?: string;
      };
      assert.equal(terminal.version, 1);
      assert.equal(terminal.failureCause, "process");
    } finally {
      process.argv[1] = originalScript;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Windows process-tree cleanup uses taskkill descendants and force escalation", () => {
  assert.deepEqual(windowsTaskkillArguments(42, false), ["/pid", "42", "/t"]);
  assert.deepEqual(windowsTaskkillArguments(42, true), ["/pid", "42", "/t", "/f"]);
});

test("a large prompt racing an immediately exiting executor does not crash the supervisor", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-epipe-"));
  const fakePi = join(root, "fake-pi.mjs");
  // Exits without reading stdin, so queued prompt bytes surface as an
  // asynchronous EPIPE on the parent's write side.
  writeFileSync(fakePi, "process.exit(0);\n");
  const originalScript = process.argv[1];
  if (originalScript === undefined) throw new Error("test runner script path is unavailable");
  process.argv[1] = fakePi;
  try {
    const run = startExecutor({
      stateDir: root,
      runId: "epipe",
      cwd: root,
      prompt: "x".repeat(8 * 1024 * 1024),
      tier: { thinking: "low" },
    });
    const outcome = await run.outcome;
    assert.equal(outcome.exitCode, 0);
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached monitor settles by liveness when the terminal file is unreadable", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-exit-unreadable-"));
  const logFile = join(root, "events.jsonl");
  writeFileSync(logFile, "");
  const exitFile = join(root, "exit.json");
  // A directory here makes existsSync true while readFileSync throws EISDIR.
  mkdirSync(exitFile);
  const attempt: Attempt = {
    index: 1,
    logFile,
    thinking: "low",
    startedAt: Date.now(),
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
    detached: true,
    pid: 2 ** 22 - 1,
    controlFile: join(root, "control.jsonl"),
    exitFile,
  };
  try {
    const run = reattachDetachedExecutor(attempt, root);
    const outcome = await run.outcome;
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.failureCause, "process");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached supervisor settles despite a straggler descendant holding stdout", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-straggler-"));
  const fakePi = join(root, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    `import { spawn } from "node:child_process";
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (JSON.parse(line).type !== "prompt") continue;
    // Straggler inherits our stdout pipe and ignores SIGTERM.
    spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "ignore"] });
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done with straggler" }] } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
    setTimeout(() => process.exit(0), 50);
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
      runId: "straggler",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
      detached: true,
    });
    const outcome = await run.outcome;
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.finalReport, "done with straggler");
    // The drain window must also reap the straggler that held the pipe.
    await wait(200);
    assert.equal(detachedAttemptIsLive(run.attempt), false);
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt detached control record is skipped without ending the run", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-detached-control-corrupt-"));
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
    if (command.type === "marker") {
      console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "survived corrupt control" }] } }));
      console.log(JSON.stringify({ type: "agent_settled" }));
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
      runId: "control-corrupt",
      cwd: root,
      prompt: "wait for control",
      tier: { thinking: "low" },
      detached: true,
    });
    await wait(300);
    appendFileSync(run.attempt.controlFile ?? "", 'this is not json\n{"type":"marker"}\n');
    const outcome = await run.outcome;
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.finalReport, "survived corrupt control");
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
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

test("verification log stream failures settle as a failed verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-verification-log-error-"));
  try {
    const result = await runVerification({
      cwd: root,
      stateDir: root,
      name: "log-error",
      command: `${process.execPath} -e "console.log('output')"`,
      timeoutSeconds: 1,
      createLogStream: () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error("disk full"));
          },
        }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.outputTail, /log write failed: disk full/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor log stream failures settle as process failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-runner-log-error-"));
  const fakePi = join(root, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    `process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString().split("\\n")) {
    if (line && JSON.parse(line).type === "prompt") console.log(JSON.stringify({ type: "agent_settled" }));
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
      runId: "log-error",
      cwd: root,
      prompt: "run",
      tier: { thinking: "low" },
      createLogStream: () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error("log unavailable"));
          },
        }),
    });
    const outcome = await run.outcome;
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.failureCause, "process");
    assert.match(outcome.errorMessage ?? "", /log write failed|log unavailable/);
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

test("verification timeout kills descendants that ignore graceful termination", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-verification-tree-"));
  const parent = join(root, "parent.mjs");
  const heartbeat = join(root, "heartbeat.txt");
  writeFileSync(
    parent,
    `import { spawn } from "node:child_process";
const script = ${JSON.stringify(`const { appendFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, "x"), 10);`)};
spawn(process.execPath, ["-e", script], { stdio: "ignore" });
setInterval(() => {}, 1000);
`
  );
  try {
    const result = await runVerification({
      cwd: root,
      stateDir: root,
      name: "tree-timeout",
      command: `${process.execPath} ${JSON.stringify(parent)}`,
      timeoutSeconds: 0.08,
    });
    assert.equal(result.timedOut, true);
    await wait(100);
    const afterKill = existsSync(heartbeat) ? statSync(heartbeat).size : 0;
    await wait(150);
    assert.equal(existsSync(heartbeat) ? statSync(heartbeat).size : 0, afterKill);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("a stalled executor that exits cleanly on abort still lands as stalled", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-watchdog-exit0-"));
  const fakePi = join(root, "polite-pi.mjs");
  writeFileSync(
    fakePi,
    `let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (JSON.parse(line).type === "abort") process.exit(0);
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
      runId: "stalled-exit0",
      cwd: root,
      prompt: "stay silent",
      tier: { thinking: "low" },
      watchdogIdleSeconds: 0.02,
      watchdogTerminationTurns: 1,
    });
    const outcome = await run.outcome;
    assert.equal(outcome.failureCause, "stalled");
    assert.equal(outcome.aborted, false);
    assert.notEqual(outcome.exitCode, 0);
    assert.equal(outcome.failureReason?.kind, "stalled");
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchdog grace allows a run to settle after steering", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-watchdog-grace-"));
  const fakePi = join(root, "responding-pi.mjs");
  writeFileSync(
    fakePi,
    `let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    if (command.type === "steer") {
      console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished after steering" }] } }));
      console.log(JSON.stringify({ type: "agent_settled" }));
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
      runId: "grace",
      cwd: root,
      prompt: "wait then finish",
      tier: { thinking: "low" },
      watchdogIdleSeconds: 0.02,
      watchdogWarningTurns: 12,
      watchdogTerminationTurns: 4,
    });
    const outcome = await run.outcome;
    assert.equal(outcome.failureCause, undefined);
    assert.equal(outcome.aborted, false);
    assert.equal(outcome.finalReport, "finished after steering");
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn-based watchdog steers investigation runs with converge text and read progress resets it", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-watchdog-readonly-"));
  const fakePi = join(root, "investigating-pi.mjs");
  const steerFile = join(root, "steer.txt");
  // Emits distinct read-tool events forever; never edits or writes files.
  writeFileSync(
    fakePi,
    `import { writeFileSync } from "node:fs";
let buffer = "";
let turn = 0;
const interval = setInterval(() => {
  turn += 1;
  console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "file-" + turn + ".ts" } }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1 }, content: [] } }));
  if (turn >= 30) {
    clearInterval(interval);
    console.log(JSON.stringify({ type: "agent_settled" }));
  }
}, 2);
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    if (command.type === "steer") writeFileSync(${JSON.stringify(steerFile)}, command.message);
    if (command.type === "abort") process.exit(1);
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
      runId: "investigation",
      cwd: root,
      prompt: "investigate",
      tier: { thinking: "low" },
      runKind: "investigation",
      watchdogIdleSeconds: 0,
      watchdogWarningTurns: 5,
      watchdogTerminationTurns: 2,
    });
    const outcome = await run.outcome;
    // Novel read activity is progress for read-only runs: 30 turns of
    // distinct reads finish normally instead of stalling at turn 5+2.
    assert.equal(outcome.failureReason?.kind, undefined);
    assert.equal(outcome.aborted, false);
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only run repeating the identical action stalls with investigation steer text", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-watchdog-loop-"));
  const fakePi = join(root, "looping-pi.mjs");
  const steerFile = join(root, "steer.txt");
  // Repeats the exact same read call forever: a genuine loop.
  writeFileSync(
    fakePi,
    `import { writeFileSync } from "node:fs";
let buffer = "";
setInterval(() => {
  console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "same.ts" } }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1 }, content: [] } }));
}, 2);
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    if (command.type === "steer") writeFileSync(${JSON.stringify(steerFile)}, command.message);
    if (command.type === "abort") process.exit(1);
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
      runId: "loop",
      cwd: root,
      prompt: "investigate",
      tier: { thinking: "low" },
      runKind: "investigation",
      watchdogIdleSeconds: 0,
      watchdogWarningTurns: 5,
      watchdogTerminationTurns: 2,
    });
    const outcome = await run.outcome;
    assert.equal(outcome.failureCause, "stalled");
    const steer = readFileSync(steerFile, "utf-8");
    assert.match(steer, /consolidate|report format/i);
    assert.doesNotMatch(steer, /smallest in-scope implementation/);
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("investigation run writing a growing report without tool calls does not stall", async () => {
  const root = mkdtempSync(join(tmpdir(), "maestro-watchdog-report-"));
  const fakePi = join(root, "reporting-pi.mjs");
  // Emits assistant turns whose report text keeps growing; zero tool calls.
  writeFileSync(
    fakePi,
    `let buffer = "";
let turn = 0;
const paragraph = "Detailed findings paragraph with enough substance to count as new report text for this turn. ";
let report = "";
const interval = setInterval(() => {
  turn += 1;
  report += paragraph;
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1 }, content: [{ type: "text", text: report }] } }));
  if (turn >= 20) {
    clearInterval(interval);
    console.log(JSON.stringify({ type: "agent_settled" }));
  }
}, 2);
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const command = JSON.parse(line);
    if (command.type === "abort") process.exit(1);
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
      runId: "report-progress",
      cwd: root,
      prompt: "investigate and report",
      tier: { thinking: "low" },
      runKind: "investigation",
      watchdogIdleSeconds: 0,
      watchdogWarningTurns: 5,
      watchdogTerminationTurns: 2,
    });
    const outcome = await run.outcome;
    assert.equal(outcome.failureReason?.kind, undefined);
    assert.equal(outcome.aborted, false);
    assert.match(outcome.finalReport, /Detailed findings/);
  } finally {
    process.argv[1] = originalScript;
    rmSync(root, { recursive: true, force: true });
  }
});

test("verification log is streamed to disk before the command finishes", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "maestro-verify-stream-"));
  try {
    // The command emits evidence, then sleeps past the timeout; the timeout
    // kill must still leave the already-emitted output in the log file.
    const result = await runVerification({
      cwd: root,
      stateDir: root,
      name: "stream",
      command: "echo evidence-before-kill && sleep 30",
      timeoutSeconds: 0.2,
    });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(readFileSync(result.logFile, "utf-8"), /evidence-before-kill/);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("a cost cap failure is not retryable and says how to recover", () => {
  // A real board spent $12.14 on one task: three attempts, two of them killed
  // at the same $5 cap. The second was doomed the moment the first hit the
  // wall, because nothing about the task or the cap had changed.
  const outcome: RunOutcome = {
    exitCode: 1,
    usage: { input: 0, output: 0, cost: 5.3949, turns: 52 },
    finalReport: "",
    touchedFiles: [],
    aborted: false,
    errorMessage: "cost cap exceeded: $5.3949 > $5 (maxCostPerTask)",
    failureCause: "cost_cap",
  };

  const failure = classifyFailure(outcome);
  assert.equal(failure?.kind, "cost_cap");
  assert.equal(failure?.retryable, false, "an identical retry hits the identical cap");
  assert.match(failure?.message ?? "", /Raise maxCostPerTask or split the task/);
});
