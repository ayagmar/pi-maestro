import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  boundedBytes,
  boundedText,
  compactEvent,
  EXIT_SETTLE_DRAIN_MS,
  extractText,
  WATCHDOG_STEER_MESSAGES,
} from "./detached-policy.mjs";

const configFile = process.argv[2];
if (!configFile) process.exit(2);
const config = JSON.parse(readFileSync(configFile, "utf8"));
try {
  unlinkSync(configFile);
} catch {
  // The private launch config is harmless if cleanup races process exit.
}

const privateFile = (file) => {
  if (process.platform !== "win32") chmodSync(file, 0o600);
};
const appendPrivate = (file, data) => {
  appendFileSync(file, data, { mode: 0o600 });
  privateFile(file);
};
const fileSize = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};
const boundedReport = (report) =>
  config.maxReportBytes === undefined
    ? boundedText(report, config.maxReportChars ?? 16_000)
    : boundedBytes(report, config.maxReportBytes);
const touchedFile = (event) => {
  if (event.type !== "tool_execution_start") return undefined;
  if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
  const raw = event.args?.path ?? event.args?.file_path;
  if (typeof raw !== "string") return undefined;
  if (!raw.startsWith("/") && !/^[A-Za-z]:[/\\]/.test(raw)) return raw.replaceAll("\\", "/");
  const normalizedCwd = config.cwd.replaceAll("\\", "/").replace(/\/$/, "");
  const normalized = raw.replaceAll("\\", "/");
  return normalized.startsWith(`${normalizedCwd}/`)
    ? normalized.slice(normalizedCwd.length + 1)
    : normalized;
};

let eventBytes = fileSize(config.eventFile);
let stderrBytes = fileSize(config.stderrFile);
const appendBoundedLine = (line) => {
  const entry = Buffer.from(`${line}\n`);
  if (config.maxLogBytes > 0 && eventBytes + entry.length > config.maxLogBytes) return;
  appendPrivate(config.eventFile, entry);
  eventBytes += entry.length;
};
const appendBoundedStderr = (chunk) => {
  const max = config.maxStderrBytes;
  const remaining = max === 0 ? chunk.length : Math.max(0, max - stderrBytes);
  if (remaining === 0) return;
  const bytes = chunk.subarray(0, remaining);
  appendPrivate(config.stderrFile, bytes);
  stderrBytes += bytes.length;
};

const child = spawn(config.command, config.args, {
  cwd: config.cwd,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_MAESTRO_EXECUTOR: "1" },
});
// An in-flight stdin write racing child exit must not crash the supervisor.
child.stdin.on("error", () => {});

const state = {
  usage: { input: 0, output: 0, cost: 0, turns: 0 },
  finalReport: "",
  touchedFiles: [],
};
let rawReportLength = 0;
let lastEventAt = Date.now();
let progressTurns = 0;
let watchdogSteeredAt;
let watchdogSteeredTime;
let _lastActivity = "starting…";
let sessionFile;
let model;
let errorMessage;
let failureCause;
let abortCause;
let settled = false;
let stdoutBuffer = "";
let controlOffset = 0;
let controlBuffer = "";
const stdoutDecoder = new StringDecoder("utf8");
const controlDecoder = new StringDecoder("utf8");
const actionSignatures = [];
const idleMs = Math.max(0, config.watchdogIdleMs);
const readOnlyProgress = config.runKind !== "implementation";

const send = (command) => {
  if (!child.stdin.writable || child.stdin.writableEnded || child.stdin.destroyed) return;
  child.stdin.write(`${JSON.stringify(command)}\n`);
};
const killChild = (signal) => {
  try {
    child.kill(signal);
  } catch {
    // Child already exited.
  }
};
const abortWithCause = (cause) => {
  if (abortCause) return;
  abortCause = cause;
  send({ type: "abort" });
  setTimeout(() => killChild("SIGTERM"), config.killGraceMs).unref();
  setTimeout(() => killChild("SIGKILL"), config.killGraceMs * 2).unref();
};
const failPersistence = (surface, error) => {
  const detail = error instanceof Error ? error.message : String(error);
  errorMessage ??= `detached ${surface} write failed: ${detail}`;
  failureCause = "process";
  abortWithCause("process");
};
const resetWatchdog = () => {
  progressTurns = state.usage.turns;
  watchdogSteeredAt = undefined;
  watchdogSteeredTime = undefined;
};
const evaluateWatchdog = () => {
  const turnsWithoutProgress = state.usage.turns - progressTurns;
  const silent = idleMs > 0 && Date.now() - lastEventAt >= idleMs;
  if (
    (silent ||
      (config.watchdogWarningTurns > 0 && turnsWithoutProgress >= config.watchdogWarningTurns)) &&
    watchdogSteeredAt === undefined
  ) {
    watchdogSteeredAt = state.usage.turns;
    watchdogSteeredTime = Date.now();
    send({ type: "steer", message: WATCHDOG_STEER_MESSAGES[config.runKind] });
    return;
  }
  if (watchdogSteeredAt === undefined || watchdogSteeredTime === undefined) return;
  const postSteerTurns = state.usage.turns - watchdogSteeredAt;
  // Grace anchors to the last event so a still-streaming model is never
  // killed mid-thought; see the attached transport for the same policy.
  const silenceGraceExpired =
    idleMs > 0 &&
    Date.now() - Math.max(watchdogSteeredTime, lastEventAt) >=
      idleMs * Math.max(1, config.watchdogTerminationTurns);
  if (postSteerTurns >= config.watchdogTerminationTurns || silenceGraceExpired) {
    // Complete silence since the steer is a provider outage, not a stall;
    // it must not consume one of the task's real attempts.
    if (silenceGraceExpired && postSteerTurns <= 0 && lastEventAt <= watchdogSteeredTime) {
      errorMessage =
        "no provider events after watchdog steering; the provider is silent or overloaded";
      failureCause = "provider";
    }
    abortWithCause("stalled");
  }
};

const processEvent = (event) => {
  lastEventAt = Date.now();
  if (event.type === "extension_ui_request" && event.id) {
    send({ type: "extension_ui_response", id: event.id, cancelled: true });
  }
  if (event.type === "response" && event.command === "get_state" && event.data?.sessionFile) {
    sessionFile = event.data.sessionFile;
  }
  if (event.type === "response" && event.command === "prompt" && event.success === false) {
    errorMessage = event.error ?? "executor rejected the prompt";
    failureCause = "provider";
    if (!child.stdin.writableEnded) child.stdin.end();
    setTimeout(() => killChild("SIGTERM"), config.killGraceMs).unref();
  }
  if (event.type === "tool_execution_start" && event.toolName) {
    _lastActivity = event.toolName;
    const signature = `${event.toolName.toLowerCase()}:${JSON.stringify(event.args ?? null)}`;
    const repeated = actionSignatures.includes(signature);
    actionSignatures.push(signature);
    if (actionSignatures.length > 8) actionSignatures.shift();
    if (/^(edit|write)$/.test(event.toolName) || (readOnlyProgress && !repeated)) resetWatchdog();
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    state.usage.turns += 1;
    state.usage.input += event.message.usage?.input ?? 0;
    state.usage.output += event.message.usage?.output ?? 0;
    state.usage.cost += event.message.usage?.cost?.total ?? 0;
    model ??= event.message.model;
    if (event.message.errorMessage) {
      errorMessage = event.message.errorMessage;
      failureCause = "provider";
    } else if (failureCause === "provider") {
      errorMessage = undefined;
      failureCause = undefined;
    }
    const text = extractText(event.message);
    if (text) {
      const priorLength = rawReportLength;
      rawReportLength = text.length;
      state.finalReport = boundedReport(text);
      if (readOnlyProgress && rawReportLength >= priorLength + 80) resetWatchdog();
    }
    if (config.maxCost > 0 && state.usage.cost > config.maxCost) {
      errorMessage = `cost cap exceeded: $${state.usage.cost.toFixed(4)} > $${config.maxCost} (maxCostPerTask)`;
      failureCause = "cost_cap";
      abortWithCause("cost_cap");
    }
  }
  const touched = touchedFile(event);
  if (touched && !state.touchedFiles.includes(touched)) {
    state.touchedFiles.push(touched);
    resetWatchdog();
  }
  if (event.type === "agent_settled" && !child.stdin.writableEnded) {
    child.stdin.end();
    setTimeout(() => killChild("SIGTERM"), config.killGraceMs).unref();
  }
  evaluateWatchdog();
};

const processStdoutLine = (line) => {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    if (config.logEvents !== "compact") {
      try {
        appendBoundedLine(line);
      } catch (error) {
        failPersistence("event log", error);
      }
    }
    return;
  }
  if (config.logEvents !== "compact" || compactEvent(event)) {
    try {
      appendBoundedLine(line);
    } catch (error) {
      failPersistence("event log", error);
    }
  }
  processEvent(event);
};
child.stdout.on("data", (chunk) => {
  stdoutBuffer += stdoutDecoder.write(chunk);
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() ?? "";
  for (const line of lines) processStdoutLine(line);
});
let stderrTail = "";
child.stderr.on("data", (chunk) => {
  try {
    appendBoundedStderr(chunk);
  } catch (error) {
    failPersistence("stderr log", error);
  }
  stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4_000);
});

const readAppended = (file, offset, decoder, priorBuffer) => {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = Number(fstatSync(fd).size);
    const start = size < offset ? 0 : offset;
    if (size === start) return { offset: start, buffer: priorBuffer, lines: [] };
    const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, size - start));
    let position = start;
    let text = priorBuffer;
    while (position < size) {
      const wanted = Math.min(bytes.length, size - position);
      const count = readSync(fd, bytes, 0, wanted, position);
      if (count <= 0) break;
      text += decoder.write(bytes.subarray(0, count));
      position += count;
    }
    const lines = text.split("\n");
    return { offset: position, buffer: lines.pop() ?? "", lines };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
const pollControl = () => {
  try {
    const read = readAppended(config.controlFile, controlOffset, controlDecoder, controlBuffer);
    controlOffset = read.offset;
    controlBuffer = read.buffer;
    for (const line of read.lines) {
      if (!line.trim()) continue;
      let command;
      try {
        command = JSON.parse(line);
      } catch {
        // One corrupt control record must not terminate the whole run.
        continue;
      }
      const cause = command.maestroCause;
      delete command.maestroCause;
      if (command.type === "abort") {
        abortCause ??= cause === "cost_cap" || cause === "stalled" ? cause : "user_abort";
      }
      send(command);
    }
  } catch (error) {
    errorMessage = `detached control read failed: ${error instanceof Error ? error.message : String(error)}`;
    failureCause = "process";
    abortWithCause("process");
  }
};
const controlTimer = setInterval(pollControl, 25);
controlTimer.unref();
pollControl();
const watchdogTimer = setInterval(
  evaluateWatchdog,
  Math.max(10, Math.min(1000, idleMs / 4 || 1000))
);
watchdogTimer.unref();

const finish = (code, signal, viaDrain = false) => {
  if (settled) return;
  settled = true;
  clearInterval(controlTimer);
  clearInterval(watchdogTimer);
  if (drainTimer) clearTimeout(drainTimer);
  stdoutBuffer += stdoutDecoder.end();
  if (stdoutBuffer.trim()) processStdoutLine(stdoutBuffer);
  // A stall already classified as provider silence keeps that cause.
  if (abortCause === "cost_cap" || (abortCause === "stalled" && failureCause !== "provider")) {
    failureCause = abortCause;
  }
  if (abortCause === "user_abort") failureCause = "user_abort";
  if (abortCause === "process") failureCause = "process";
  const exitCode = abortCause ? 1 : (code ?? 1);
  if (exitCode !== 0 && !errorMessage && !abortCause) {
    errorMessage =
      stderrTail.trim() || `detached executor terminated by ${signal ?? `exit ${exitCode}`}`;
    failureCause = "process";
  }
  const terminal = {
    version: 1,
    exitCode,
    usage: state.usage,
    finalReport: state.finalReport,
    touchedFiles: state.touchedFiles,
    aborted: abortCause === "user_abort",
    ...(model ? { model } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(failureCause ? { failureCause } : {}),
  };
  const contents = `${JSON.stringify(terminal)}\n`;
  const temporary = `${config.exitFile}.tmp-${process.pid}`;
  // After the terminal record is durable, a settle that was forced by the
  // drain window (a descendant still holds the stdio pipes) or by an abort
  // must not leave that subtree running. The supervisor leads this process
  // group, so the group SIGKILL also ends the supervisor itself — after the
  // rename below, the monitor no longer needs this process.
  const reapProcessGroup = () => {
    if (!viaDrain && !abortCause) return;
    if (!ownsProcessGroup()) return;
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      // The group is already empty.
    }
  };
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    privateFile(temporary);
    renameSync(temporary, config.exitFile);
    privateFile(config.exitFile);
    reapProcessGroup();
    process.exit(0);
  } catch {
    // If atomic replacement itself fails, retain one final direct-write chance.
    try {
      writeFileSync(config.exitFile, contents, { mode: 0o600 });
      privateFile(config.exitFile);
      reapProcessGroup();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  }
};
/** True only when this supervisor leads its own process group (runner spawns it detached). */
const ownsProcessGroup = () => {
  if (process.platform === "win32") return false;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync("/proc/self/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[2] === String(process.pid);
    } catch {
      return false;
    }
  }
  // Production always launches the supervisor as a detached group leader.
  return true;
};
let drainTimer;
child.on("exit", (code, signal) => {
  // "close" waits for every stdio pipe; a tool-spawned descendant that
  // inherited pi's stdout and outlived it would otherwise wedge this
  // supervisor forever without a terminal record. Drain briefly, then settle.
  // Deliberately referenced: this timer must be able to settle the outcome
  // even when a straggler descendant is the only thing keeping stdio open.
  drainTimer = setTimeout(() => finish(code, signal, true), EXIT_SETTLE_DRAIN_MS);
});
child.on("close", finish);
child.on("error", (error) => {
  errorMessage = error.message;
  failureCause = "process";
  finish(1);
});
process.on("SIGTERM", () => {
  abortCause ??= "user_abort";
  killChild("SIGTERM");
  setTimeout(() => killChild("SIGKILL"), config.killGraceMs).unref();
});
