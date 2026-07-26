import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  KILL_GRACE_MS,
  LOGS_DIR,
  MAX_PERSISTED_REPORT_CHARS,
  SESSION_NAMESPACE,
} from "./constants.js";
import {
  boundedBytes,
  boundedText,
  compactEvent,
  extractText,
  WATCHDOG_STEER_MESSAGES,
} from "./detached-policy.mjs";
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  ensurePrivateFile,
  writePrivateFile,
} from "./private-files.js";
import { type Attempt, type FailureReason, type TierConfig, type Usage } from "./types.js";

const VERIFICATION_KILL_GRACE_MS = 250;

type LogStream = Writable & { end(callback?: () => void): unknown };

export type RunFailureCause = "provider" | "process" | "user_abort" | "cost_cap" | "stalled";

/**
 * Kernel-reported process start identity, so a recycled PID cannot masquerade
 * as a live owner of on-disk state (board locks). Linux reads /proc; macOS
 * and BSDs ask ps for the start time. Unsupported platforms return undefined
 * and callers keep a conservative liveness-only check.
 */
export function processStartId(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) return undefined;
      const fields = stat.slice(closeParen + 2).split(" ");
      // Field 22 (starttime) is index 19 after the (pid, comm) prefix.
      const startTicks = fields[19];
      return startTicks && /^\d+$/.test(startTicks) ? startTicks : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
    try {
      const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim();
      if (!lstart) return undefined;
      const epoch = Date.parse(lstart);
      return Number.isFinite(epoch) ? String(epoch) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function boundedReport(report: string, maxChars = MAX_PERSISTED_REPORT_CHARS): string {
  return boundedText(report, maxChars);
}

export function boundedReportBytes(report: string, maxBytes: number): string {
  return boundedBytes(report, maxBytes);
}

export function windowsTaskkillArguments(pid: number, force: boolean): string[] {
  return ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])];
}

/** Signal a spawned command and its descendants on every supported host. */
function signalProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
  grouped: boolean
): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", windowsTaskkillArguments(child.pid, signal === "SIGKILL"), {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      try {
        child.kill(signal);
      } catch {
        // The root process already exited.
      }
    });
    killer.unref();
    return;
  }
  try {
    if (grouped) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process tree already exited.
  }
}

export interface VerificationResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
  logFile: string;
}

export async function runVerification(options: {
  cwd: string;
  stateDir: string;
  name: string;
  command: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  /** Controlled test seam for asynchronous filesystem failures. */
  createLogStream?: (path: string) => LogStream;
}): Promise<VerificationResult> {
  const directory = join(options.stateDir, "verification");
  ensurePrivateDirectory(directory);
  const logFile = join(directory, `${options.name}-${Date.now()}.log`);
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    });
    // Stream evidence to disk as it arrives so a SIGKILL of this process
    // still leaves the partial verification log behind.
    const logStream =
      options.createLogStream?.(logFile) ?? createWriteStream(logFile, { mode: 0o600 });
    let output = "";
    // A runtime filesystem failure must be represented by the verification
    // result, not become an unhandled stream error in the supervisor.
    let logWriteError: string | undefined;
    logStream.on("error", (error: Error) => {
      logWriteError = error.message;
      output = `${output}\nlog write failed: ${error.message}`.slice(-16_000);
      if (!settled) stop();
    });
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-16_000);
      if (!logWriteError) logStream.write(chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const kill = (signal: NodeJS.Signals) => signalProcessTree(child, signal, grouped);
    const stop = () => {
      kill("SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(() => kill("SIGKILL"), VERIFICATION_KILL_GRACE_MS);
      killTimer.unref();
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
        kill("SIGKILL");
      }
      options.signal?.removeEventListener("abort", stop);
      logStream.end(() => {
        const exitCode = logWriteError ? 1 : (code ?? 1);
        resolve({
          ok: exitCode === 0 && !timedOut && !options.signal?.aborted && !logWriteError,
          exitCode,
          timedOut,
          durationMs: Date.now() - startedAt,
          outputTail: output.slice(-4000),
          logFile,
        });
      });
    };

    options.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutSeconds * 1000);
    timer.unref();
    child.on("close", finish);
    child.on("error", (error) => {
      output = `${output}\n${error.message}`;
      if (!logWriteError) logStream.write(`\n${error.message}`);
      finish(1);
    });
    if (options.signal?.aborted) stop();
  });
}

export interface RunOutcome {
  exitCode: number;
  usage: Usage;
  finalReport: string;
  touchedFiles: string[];
  model?: string;
  aborted: boolean;
  errorMessage?: string;
  failureCause?: RunFailureCause;
  failureReason?: FailureReason;
}

export function providerFromModel(model?: string): string | undefined {
  if (!model?.includes("/")) return undefined;
  return model.split("/", 1)[0];
}

export function redactFailureMessage(message: string): string {
  return message
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export function classifyFailure(
  outcome: Pick<RunOutcome, "aborted" | "errorMessage" | "exitCode" | "failureCause" | "usage">,
  phase: "executor" | "review" = "executor"
): FailureReason | undefined {
  if (outcome.failureCause === "user_abort" || outcome.aborted) {
    return { kind: "user_abort", message: `${phase} aborted by user`, retryable: true };
  }
  if (outcome.exitCode === 0 && !outcome.errorMessage) return undefined;

  const message = redactFailureMessage(
    outcome.errorMessage ?? `${phase} exited with code ${outcome.exitCode}`
  );
  if (outcome.failureCause === "cost_cap" || message.startsWith("cost cap exceeded:")) {
    return { kind: "cost_cap", message, retryable: true };
  }
  if (outcome.failureCause === "stalled") {
    return {
      kind: "stalled",
      message: "executor stalled after watchdog steering",
      retryable: false,
    };
  }
  const providerFailure =
    outcome.failureCause === "provider" ||
    (outcome.failureCause === undefined &&
      /\b429\b|usage limit|rate limit|quota|too many requests|resource.?exhausted/i.test(message));
  if (providerFailure) return { kind: "provider_failure", message, retryable: true };
  return {
    kind: phase === "review" ? "reviewer_failure" : "executor_failure",
    message,
    retryable: true,
  };
}

export interface RunUpdate {
  turns: number;
  cost: number;
  lastActivity: string;
  lastEventAt?: number;
  lastProgressAt?: number;
  phase?: "starting" | "exploring" | "editing" | "verifying" | "reporting";
  changedFileCount?: number;
  turnsWithoutProgress?: number;
  /** Persisted as soon as RPC get_state returns so interrupted runs remain navigable. */
  sessionFile?: string;
}

export function cappedLogWriter(
  output: Pick<Writable, "write">,
  maxBytes?: number
): (line: string) => void {
  let writtenBytes = 0;

  return (line: string) => {
    const entry = Buffer.from(`${line}\n`);
    const unlimited = maxBytes === undefined || maxBytes === 0;
    const remainingBytes = unlimited ? entry.length : maxBytes - writtenBytes;
    if (remainingBytes <= 0) return;

    const bytes = entry.subarray(0, remainingBytes);
    output.write(bytes);
    writtenBytes += bytes.length;
  };
}

/**
 * What kind of work a launch performs, for progress detection and steering:
 * implementation runs progress by mutating files; investigation and review
 * runs are legitimately read-only and progress through read-tool activity.
 */
export type RunKind = "implementation" | "investigation" | "review";

/** Minimum new final-report characters per turn that count as investigation progress. */
const REPORT_PROGRESS_MIN_GROWTH = 80;

export interface ExecutorHandle {
  attempt: Attempt;
  outcome: Promise<RunOutcome>;
  /** Detached transports are preserved when the owning Pi runtime shuts down. */
  survivesShutdown?: boolean;
  /** Queue a steering message into the running executor (delivered before its next LLM call). */
  steer(message: string): void;
  /** Queue a follow-up message until the executor has finished its current work. */
  followUp(message: string): void;
  /** Abort the executor. The outcome resolves with aborted: true. */
  abort(): void;
}

function safeSessionDirectoryLabel(runId: string): string {
  const label = runId
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
  return label || "run";
}

/** Mirror Pi's public default per-project session layout under its configured agent directory. */
export function projectSessionDir(projectCwd: string): string {
  const resolvedCwd = resolve(projectCwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", safePath);
}

/**
 * Allocate one private Pi session directory per raw executor/reviewer launch.
 * Pi's picker lists only JSONL files directly in the project session directory,
 * while recursive usage scanners still discover this nested transcript.
 */
export function createExecutorSessionDir(projectCwd: string, runId: string): string {
  const namespace = join(projectSessionDir(projectCwd), SESSION_NAMESPACE);
  ensurePrivateDirectory(namespace);
  const directory = join(namespace, `${safeSessionDirectoryLabel(runId)}-${randomUUID()}`);
  ensurePrivateDirectory(directory);
  return directory;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  // Re-executing the current script only reproduces pi when that script *is*
  // pi. Integration tests run under a test runner whose argv[1] is the test
  // file, so they select the installed binary explicitly.
  if (process.env.PI_MAESTRO_EXECUTOR_COMMAND) {
    return { command: process.env.PI_MAESTRO_EXECUTOR_COMMAND, args };
  }
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

export interface JsonEvent {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: { sessionFile?: string };
  toolName?: string;
  args?: Record<string, unknown> | null;
  message?: {
    role?: string;
    model?: string;
    usage?: { input?: number; output?: number; cost?: { total?: number } };
    stopReason?: string;
    errorMessage?: string;
    content?: { type: string; text?: string }[];
  };
}

export function applyAssistantMessage(
  result: RunOutcome,
  attempt: Attempt,
  message: NonNullable<JsonEvent["message"]>,
  maxCost?: number
): boolean {
  const usage = message.usage;
  attempt.usage.turns += 1;
  attempt.usage.input += usage?.input ?? 0;
  attempt.usage.output += usage?.output ?? 0;
  attempt.usage.cost += usage?.cost?.total ?? 0;
  if (!result.model && message.model) result.model = message.model;

  if (message.errorMessage) {
    result.errorMessage = message.errorMessage;
    result.failureCause = "provider";
  } else {
    delete result.errorMessage;
    if (result.failureCause === "provider") delete result.failureCause;
  }

  const exceededCostCap = Boolean(maxCost && attempt.usage.cost > maxCost);
  if (exceededCostCap) {
    result.errorMessage = `cost cap exceeded: $${attempt.usage.cost.toFixed(4)} > $${maxCost} (maxCostPerTask)`;
    result.failureCause = "cost_cap";
  }

  const text = extractText(message);
  if (text) result.finalReport = text;
  return exceededCostCap;
}

export function touchedFile(event: JsonEvent, cwd: string): string | undefined {
  if (event.type !== "tool_execution_start") return undefined;
  if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
  const raw = event.args?.path ?? event.args?.file_path;
  if (typeof raw !== "string") return undefined;
  return isAbsolute(raw) ? relative(cwd, raw) : raw;
}

/**
 * Spawn a fresh-context pi executor as a child process in RPC mode.
 *
 * RPC mode (vs plain JSON print mode) lets the caller steer or abort the
 * executor mid-run via stdin commands. Its transcript is nested beneath Pi's
 * normal per-project session directory so usage scanners retain it without
 * adding the child to Pi's ordinary /resume list. Every stdout event is also
 * mirrored to stateDir/logs/<runId>.jsonl for live tailing.
 */
export interface StartExecutorOptions {
  stateDir: string;
  runId: string;
  cwd: string;
  /** Main project cwd used to group sessions when cwd is an ephemeral worktree. */
  projectCwd?: string;
  prompt: string;
  tier: TierConfig;
  /** Human-readable session name shown in pi's session picker (e.g. "T3 · add replay command"). */
  sessionLabel?: string;
  /** Abort the run when attempt cost exceeds this (USD). 0 disables the cap. */
  maxCost?: number;
  /** Event detail mirrored to the run log. Compact keeps lifecycle, tool, and final events. */
  logEvents?: "compact" | "full";
  /** Stop appending to this run's event log after this many bytes. */
  maxLogBytes?: number;
  watchdogIdleSeconds?: number;
  watchdogWarningTurns?: number;
  watchdogTerminationTurns?: number;
  /** Progress model and steering text for this launch. Defaults to implementation. */
  runKind?: RunKind;
  /** Persisted report bound. Discovery raises this to preserve valid JSON up to its contract limit. */
  maxReportChars?: number;
  /** Byte bound for report contracts such as discovery JSON. */
  maxReportBytes?: number;
  signal?: AbortSignal;
  onUpdate?: (update: RunUpdate) => void;
  /** Opt-in Unix detached JSONL transport. */
  detached?: boolean;
  /** Controlled test seam for asynchronous executor-log failures. */
  createLogStream?: (path: string) => LogStream;
}

export function startExecutor(options: StartExecutorOptions): ExecutorHandle {
  const logFile = join(options.stateDir, LOGS_DIR, `${options.runId}.jsonl`);
  ensurePrivateDirectory(options.stateDir);
  ensurePrivateDirectory(dirname(logFile));

  const sessionDir = createExecutorSessionDir(options.projectCwd ?? options.cwd, options.runId);
  const attempt: Attempt = {
    index: 0,
    logFile,
    sessionDir,
    thinking: options.tier.thinking,
    startedAt: Date.now(),
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
  };
  if (options.tier.model !== undefined) {
    attempt.model = options.tier.model;
    const provider = providerFromModel(options.tier.model);
    if (provider !== undefined) attempt.provider = provider;
  }

  // Sessions stay under Pi's normal root for recursive usage accounting, but
  // one level below the files indexed by the ordinary /resume picker.
  const args = ["--mode", "rpc", "--session-dir", sessionDir, "--thinking", options.tier.thinking];
  if (options.tier.model) args.push("--model", options.tier.model);
  if (options.tier.tools) args.push("--tools", options.tier.tools);
  // Integration tests replace the user's environment with a scripted model
  // provider so the real RPC transport can be exercised without a provider
  // account or the developer's own installed packages. Nothing in normal
  // operation sets this.
  const testExtensions = (process.env.PI_MAESTRO_EXECUTOR_EXTENSIONS ?? "")
    .split(",")
    .filter(Boolean);
  if (testExtensions.length > 0) {
    args.push("--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files");
    for (const extension of testExtensions) args.push("--extension", extension);
  }

  const invocation = piInvocation(args);
  if (options.detached && process.platform !== "win32") {
    return startDetachedExecutor(options, attempt, invocation);
  }
  const grouped = process.platform !== "win32";
  const proc = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    detached: grouped,
    // The flag makes an installed pi-maestro extension no-op inside the
    // executor: no recursive orchestration, no crash-recovery fighting the
    // parent over the shared board file.
    env: { ...process.env, PI_MAESTRO_EXECUTOR: "1" },
  });
  // A queued stdin write racing executor exit surfaces as an asynchronous
  // EPIPE; without a handler it crashes the supervising Pi process.
  proc.stdin.on("error", () => {});

  const kill = (signal: NodeJS.Signals) => signalProcessTree(proc, signal, grouped);
  let abortCause: "user_abort" | "cost_cap" | "stalled" | undefined;
  const send = (command: Record<string, unknown>) => {
    if (proc.stdin.writable && !proc.stdin.writableEnded && !proc.stdin.destroyed) {
      proc.stdin.write(`${JSON.stringify(command)}\n`);
    }
  };
  const abortWithCause = (cause: "user_abort" | "cost_cap" | "stalled") => {
    if (abortCause) return;
    abortCause = cause;
    send({ type: "abort" });
    if (!proc.stdin.writableEnded) proc.stdin.end();
    // taskkill needs the root PID while it is still alive to discover descendants.
    if (process.platform === "win32") kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null) kill("SIGTERM");
    }, KILL_GRACE_MS).unref();
    setTimeout(() => {
      if (proc.exitCode === null) kill("SIGKILL");
    }, KILL_GRACE_MS * 2).unref();
  };
  const abort = () => abortWithCause("user_abort");

  const outcome = new Promise<RunOutcome>((resolve) => {
    const result: RunOutcome = {
      exitCode: 0,
      usage: attempt.usage,
      finalReport: "",
      touchedFiles: attempt.touchedFiles,
      aborted: false,
    };
    const log = options.createLogStream?.(logFile) ?? createWriteStream(logFile, { mode: 0o600 });
    const writeLogLine = cappedLogWriter(log, options.maxLogBytes);
    let logWriteError: string | undefined;
    let stderr = "";
    let buffer = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let lastActivity = "starting…";
    let lastEventAt = Date.now();
    let lastProgressAt = lastEventAt;
    let progressTurns = 0;
    let watchdogSteeredAt: number | undefined;
    let watchdogSteeredTime: number | undefined;
    const actionSignatures: string[] = [];
    const idleMs = Math.max(0, (options.watchdogIdleSeconds ?? 120) * 1000);
    const runKind: RunKind = options.runKind ?? "implementation";
    // Read-only work progresses through reading; only repeating the exact
    // same action shape over and over counts as no progress there.
    const readOnlyProgress = runKind !== "implementation";

    const evaluateWatchdog = () => {
      const turnsWithoutProgress = attempt.usage.turns - progressTurns;
      const warningTurns = options.watchdogWarningTurns ?? 0;
      const silent = idleMs > 0 && Date.now() - lastEventAt >= idleMs;
      if (
        (silent || (warningTurns > 0 && turnsWithoutProgress >= warningTurns)) &&
        watchdogSteeredAt === undefined
      ) {
        watchdogSteeredAt = attempt.usage.turns;
        watchdogSteeredTime = Date.now();
        send({ type: "steer", message: WATCHDOG_STEER_MESSAGES[runKind] });
        return;
      }
      if (watchdogSteeredAt !== undefined && watchdogSteeredTime !== undefined) {
        const terminationTurns = options.watchdogTerminationTurns ?? 4;
        const postSteerTurns = attempt.usage.turns - watchdogSteeredAt;
        const postSteerSilenceMs = idleMs * Math.max(1, terminationTurns);
        const silenceGraceExpired =
          idleMs > 0 && Date.now() - watchdogSteeredTime >= postSteerSilenceMs;
        if (postSteerTurns >= terminationTurns || silenceGraceExpired) {
          abortWithCause("stalled");
        }
      }
    };
    const watchdog = setInterval(
      evaluateWatchdog,
      Math.max(10, Math.min(1000, idleMs / 4 || 1000))
    );
    watchdog.unref();
    let settled = false;

    const failLog = (error: Error) => {
      if (logWriteError) return;
      logWriteError = error.message;
      result.errorMessage = redactFailureMessage(`executor log write failed: ${error.message}`);
      result.failureCause = "process";
      send({ type: "abort" });
      if (!proc.stdin.writableEnded) proc.stdin.end();
      if (process.platform === "win32") kill("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null) kill("SIGTERM");
      }, KILL_GRACE_MS).unref();
      setTimeout(() => {
        if (proc.exitCode === null) kill("SIGKILL");
      }, KILL_GRACE_MS * 2).unref();
    };
    log.on("error", failLog);
    log.on("open", () => {
      try {
        ensurePrivateFile(logFile);
      } catch (error) {
        failLog(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const persistLogLine = (line: string) => {
      try {
        writeLogLine(line);
      } catch (error) {
        failLog(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const resolveAfterLog = (done: () => void) => {
      if (logWriteError || log.destroyed) done();
      else log.end(done);
    };

    const cleanup = () => {
      clearInterval(watchdog);
      options.signal?.removeEventListener("abort", abort);
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: JsonEvent;
      try {
        event = JSON.parse(line) as JsonEvent;
      } catch {
        if (options.logEvents !== "compact") persistLogLine(line);
        return;
      }
      if (options.logEvents !== "compact" || compactEvent(event)) persistLogLine(line);
      lastEventAt = Date.now();

      // Executors run headless: auto-cancel any extension dialog so
      // permission gates fail safe instead of hanging the run.
      if (event.type === "extension_ui_request" && event.id) {
        send({ type: "extension_ui_response", id: event.id, cancelled: true });
        return;
      }

      if (event.type === "response" && event.command === "get_state" && event.data?.sessionFile) {
        attempt.sessionFile = event.data.sessionFile;
        options.onUpdate?.({
          turns: attempt.usage.turns,
          cost: attempt.usage.cost,
          lastActivity,
          lastEventAt,
          lastProgressAt,
          phase: "starting",
          changedFileCount: attempt.touchedFiles.length,
          turnsWithoutProgress: attempt.usage.turns - progressTurns,
          sessionFile: event.data.sessionFile,
        });
        return;
      }

      // A rejected prompt (bad model, missing API key, ...) would otherwise
      // leave the process idle forever. Fail fast with the provider error.
      if (event.type === "response" && event.command === "prompt" && event.success === false) {
        result.errorMessage = event.error ?? "executor rejected the prompt";
        result.failureCause = "provider";
        if (!proc.stdin.writableEnded) proc.stdin.end();
        if (process.platform === "win32") kill("SIGTERM");
        setTimeout(() => {
          if (proc.exitCode === null) kill("SIGTERM");
        }, KILL_GRACE_MS).unref();
        return;
      }

      if (event.type === "tool_execution_start" && event.toolName) {
        lastActivity = event.toolName;
        const signature = `${event.toolName.toLowerCase()}:${JSON.stringify(event.args ?? null)}`;
        const repeated = actionSignatures.includes(signature);
        actionSignatures.push(signature);
        if (actionSignatures.length > 8) actionSignatures.shift();
        const mutation = /^(edit|write)$/.test(event.toolName);
        // Implementation runs progress by mutating files. Read-only runs
        // (investigation, review) progress through novel tool activity;
        // exact repeats of a recent action do not reset the watchdog.
        if (mutation || (readOnlyProgress && !repeated)) {
          lastProgressAt = Date.now();
          progressTurns = attempt.usage.turns;
          watchdogSteeredAt = undefined;
          watchdogSteeredTime = undefined;
        }
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        const reportLengthBefore = result.finalReport.length;
        // Apply the cap after clearing a prior transient provider error. The
        // successful message that crosses the cap must still end as cost_cap.
        const exceededCostCap = applyAssistantMessage(
          result,
          attempt,
          event.message,
          options.maxCost
        );
        if (exceededCostCap && !abortCause) abortWithCause("cost_cap");
        // Read-only runs can legitimately spend consecutive turns writing a
        // long report with no tool calls at all. Meaningful new assistant
        // text is progress there; identical or shrinking text is not.
        if (
          readOnlyProgress &&
          result.finalReport.length >= reportLengthBefore + REPORT_PROGRESS_MIN_GROWTH
        ) {
          lastProgressAt = Date.now();
          progressTurns = attempt.usage.turns;
          watchdogSteeredAt = undefined;
          watchdogSteeredTime = undefined;
        }
      }

      const touched = touchedFile(event, options.cwd);
      if (touched && !attempt.touchedFiles.includes(touched)) {
        attempt.touchedFiles.push(touched);
        lastProgressAt = Date.now();
        progressTurns = attempt.usage.turns;
        watchdogSteeredAt = undefined;
        watchdogSteeredTime = undefined;
      }

      if (event.type === "agent_settled") {
        // No retry, compaction, or queued continuation remains. Closing stdin
        // now triggers RPC shutdown and session flush.
        if (!proc.stdin.writableEnded) proc.stdin.end();
        setTimeout(() => {
          if (proc.exitCode === null) kill("SIGTERM");
        }, KILL_GRACE_MS).unref();
      }

      const turnsWithoutProgress = attempt.usage.turns - progressTurns;
      evaluateWatchdog();
      const phase = /test|check|verify/.test(lastActivity)
        ? "verifying"
        : attempt.touchedFiles.length > 0
          ? "editing"
          : attempt.usage.turns > 0
            ? "exploring"
            : "starting";
      options.onUpdate?.({
        turns: attempt.usage.turns,
        cost: attempt.usage.cost,
        lastActivity,
        lastEventAt,
        lastProgressAt,
        phase,
        changedFileCount: attempt.touchedFiles.length,
        turnsWithoutProgress,
      });
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += stdoutDecoder.write(data);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr = `${stderr}${data.toString()}`.slice(-16_000);
    });

    proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      buffer += stdoutDecoder.end();
      if (buffer.trim()) processLine(buffer);
      result.exitCode = code ?? 1;
      if ((abortCause || logWriteError) && process.platform !== "win32") kill("SIGKILL");
      if (code === null && !result.errorMessage && !abortCause) {
        result.errorMessage = `executor terminated by ${signal ?? "an unknown signal"}`;
        result.failureCause = "process";
      }
      if (result.errorMessage && result.exitCode === 0) result.exitCode = 1;
      // Auth exists at preflight but tokens can be expired or out of quota;
      // the provider error alone doesn't tell the user how to recover.
      if (result.errorMessage?.includes("No API key for provider")) {
        result.errorMessage +=
          " — the provider's OAuth token is likely expired or out of quota. Re-run `pi /login` for it, or pick another model in /maestro config.";
      }
      if (result.errorMessage) result.errorMessage = redactFailureMessage(result.errorMessage);
      result.finalReport = options.maxReportBytes
        ? boundedReportBytes(result.finalReport, options.maxReportBytes)
        : boundedReport(result.finalReport, options.maxReportChars);
      attempt.finalReport = result.finalReport;
      // A cost-cap abort carries an errorMessage and must land as a failure
      // (retryable, visible reason), not as a user cancellation.
      result.aborted = abortCause === "user_abort";
      if (abortCause) result.failureCause = abortCause;
      // Pi can flush and exit 0 after a graceful abort; a stalled or capped
      // run must still land as a failure, matching the detached supervisor.
      if (abortCause && abortCause !== "user_abort" && result.exitCode === 0) result.exitCode = 1;
      if (result.exitCode !== 0 && !result.errorMessage && !abortCause) {
        result.errorMessage = redactFailureMessage(
          stderr.trim() || `executor exited with code ${result.exitCode}`
        );
        result.failureCause = "process";
      }
      const failureReason = classifyFailure(result);
      if (failureReason) {
        result.failureReason = failureReason;
        attempt.failureReason = failureReason;
      }
      attempt.endedAt = Date.now();
      attempt.exitCode = result.exitCode;
      resolveAfterLog(() => resolve(result));
    });

    proc.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      result.exitCode = 1;
      result.errorMessage = redactFailureMessage(error.message);
      result.failureCause = "process";
      const failureReason = classifyFailure(result);
      if (failureReason) {
        result.failureReason = failureReason;
        attempt.failureReason = failureReason;
      }
      attempt.endedAt = Date.now();
      attempt.exitCode = 1;
      resolveAfterLog(() => resolve(result));
    });

    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }

    send({ type: "set_session_name", name: options.sessionLabel ?? `maestro ${options.runId}` });
    send({ type: "get_state" });
    send({ type: "prompt", message: options.prompt });
  });

  return {
    attempt,
    outcome,
    steer: (message: string) => send({ type: "steer", message }),
    followUp: (message: string) => send({ type: "follow_up", message }),
    abort,
  };
}

function startDetachedExecutor(
  options: StartExecutorOptions,
  attempt: Attempt,
  invocation: { command: string; args: string[] }
): ExecutorHandle {
  const controlFile = `${attempt.logFile}.control`;
  const exitFile = `${attempt.logFile}.exit`;
  const stderrFile = `${attempt.logFile}.stderr`;
  const supervisorConfigFile = `${attempt.logFile}.supervisor.json`;
  writePrivateFile(
    controlFile,
    `${[
      { type: "set_session_name", name: options.sessionLabel ?? `maestro ${options.runId}` },
      { type: "get_state" },
      { type: "prompt", message: options.prompt },
    ]
      .map((command) => JSON.stringify(command))
      .join("\n")}\n`
  );
  writePrivateFile(attempt.logFile, "");
  writePrivateFile(stderrFile, "");
  writePrivateFile(
    supervisorConfigFile,
    `${JSON.stringify({
      command: invocation.command,
      args: invocation.args,
      cwd: options.cwd,
      controlFile,
      eventFile: attempt.logFile,
      stderrFile,
      exitFile,
      logEvents: options.logEvents ?? "compact",
      maxLogBytes: options.maxLogBytes ?? 0,
      maxStderrBytes: 16_000,
      maxCost: options.maxCost ?? 0,
      watchdogIdleMs: Math.max(0, (options.watchdogIdleSeconds ?? 120) * 1000),
      watchdogWarningTurns: options.watchdogWarningTurns ?? 0,
      watchdogTerminationTurns: options.watchdogTerminationTurns ?? 4,
      runKind: options.runKind ?? "implementation",
      maxReportChars: options.maxReportChars ?? MAX_PERSISTED_REPORT_CHARS,
      ...(options.maxReportBytes !== undefined ? { maxReportBytes: options.maxReportBytes } : {}),
      killGraceMs: KILL_GRACE_MS,
    })}\n`
  );
  const supervisor = fileURLToPath(new URL("./detached-supervisor.mjs", import.meta.url));
  const proc = spawn(process.execPath, [supervisor, supervisorConfigFile], {
    cwd: options.cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_MAESTRO_EXECUTOR: "1" },
  });
  // An asynchronous spawn failure must not crash the supervising Pi process;
  // the monitor's liveness polling settles the attempt as a process failure.
  proc.on("error", () => {});
  proc.unref();
  attempt.detached = true;
  if (proc.pid) {
    attempt.pid = proc.pid;
    const startId = processStartId(proc.pid);
    if (startId) attempt.processStartId = startId;
  }
  attempt.controlFile = controlFile;
  attempt.exitFile = exitFile;
  attempt.stderrFile = stderrFile;
  return monitorDetachedExecutor(attempt, options.cwd, options);
}

export function reattachDetachedExecutor(
  attempt: Attempt,
  cwd: string,
  onUpdate?: (update: RunUpdate) => void,
  maxReportChars = MAX_PERSISTED_REPORT_CHARS,
  maxReportBytes?: number
): ExecutorHandle {
  return monitorDetachedExecutor(attempt, cwd, { onUpdate, maxReportChars, maxReportBytes });
}

export function detachedAttemptIsLive(attempt: Attempt): boolean {
  if (!attempt.detached || !attempt.pid) return false;
  if (attempt.processStartId) {
    const current = processStartId(attempt.pid);
    if (current !== undefined && current !== attempt.processStartId) return false;
  }
  try {
    process.kill(attempt.pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface IncrementalLogState {
  offset: number;
  buffer: string;
  decoder: StringDecoder;
}

/** Read only bytes appended since the prior poll, preserving UTF-8 and partial lines. */
function readAppendedLines(file: string, state: IncrementalLogState): string[] {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < state.offset) {
      state.offset = 0;
      state.buffer = "";
      state.decoder = new StringDecoder("utf8");
    }
    const bytes = Buffer.allocUnsafe(64 * 1024);
    let text = state.buffer;
    while (state.offset < size) {
      const wanted = Math.min(bytes.length, size - state.offset);
      const count = readSync(fd, bytes, 0, wanted, state.offset);
      if (count <= 0) break;
      state.offset += count;
      text += state.decoder.write(bytes.subarray(0, count));
    }
    const lines = text.split("\n");
    state.buffer = lines.pop() ?? "";
    return lines;
  } finally {
    closeSync(fd);
  }
}

interface DetachedTerminalState extends Partial<RunOutcome> {
  version: 1;
  sessionFile?: string;
}

function monitorDetachedExecutor(
  attempt: Attempt,
  cwd: string,
  options: {
    maxCost?: number | undefined;
    maxReportChars?: number | undefined;
    maxReportBytes?: number | undefined;
    signal?: AbortSignal | undefined;
    onUpdate?: ((update: RunUpdate) => void) | undefined;
  } = {}
): ExecutorHandle {
  const result: RunOutcome = {
    exitCode: 0,
    usage: attempt.usage,
    finalReport: attempt.finalReport ?? "",
    touchedFiles: attempt.touchedFiles,
    aborted: false,
  };
  const tail: IncrementalLogState = {
    offset: 0,
    buffer: "",
    decoder: new StringDecoder("utf8"),
  };
  let settled = false;
  let abortCause: "user_abort" | "cost_cap" | "stalled" | undefined;
  let terminalPolls = 0;
  let timer: NodeJS.Timeout | undefined;
  let resolveOutcome: (outcome: RunOutcome) => void = () => {};
  const outcome = new Promise<RunOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const send = (command: Record<string, unknown>) => {
    if (!attempt.controlFile) return;
    try {
      appendPrivateFile(attempt.controlFile, `${JSON.stringify(command)}\n`);
    } catch {
      // Recovery remains abortable through the persisted process group.
    }
  };
  const killGroup = (signal: NodeJS.Signals) => {
    if (!attempt.pid) return;
    try {
      process.kill(-attempt.pid, signal);
    } catch {
      try {
        process.kill(attempt.pid, signal);
      } catch {
        // Process already exited.
      }
    }
  };
  const finish = (exitCode: number, terminal?: DetachedTerminalState) => {
    if (settled) return;
    settled = true;
    if (timer) clearInterval(timer);
    options.signal?.removeEventListener("abort", abort);
    if (terminal?.usage) Object.assign(attempt.usage, terminal.usage);
    if (terminal?.touchedFiles) {
      attempt.touchedFiles.splice(0, attempt.touchedFiles.length, ...terminal.touchedFiles);
    }
    if (terminal?.finalReport !== undefined) result.finalReport = terminal.finalReport;
    if (terminal?.model !== undefined) result.model = terminal.model;
    if (terminal?.sessionFile) attempt.sessionFile = terminal.sessionFile;
    result.exitCode = terminal?.exitCode ?? (abortCause ? 1 : exitCode);
    // A terminal record that settled cleanly before a racing local abort is
    // authoritative completed work, not a cancellation.
    const abortTookEffect = abortCause !== undefined && result.exitCode !== 0;
    result.aborted = terminal?.aborted ?? (abortCause === "user_abort" && abortTookEffect);
    if (terminal?.errorMessage !== undefined) result.errorMessage = terminal.errorMessage;
    if (terminal?.failureCause !== undefined) result.failureCause = terminal.failureCause;
    else if (abortTookEffect && abortCause !== undefined) result.failureCause = abortCause;
    if (result.exitCode !== 0 && !result.failureCause && !result.errorMessage) {
      const stderr =
        attempt.stderrFile && existsSync(attempt.stderrFile)
          ? readFileSync(attempt.stderrFile, "utf-8").trim().slice(-4_000)
          : "";
      result.errorMessage = redactFailureMessage(
        stderr || `detached executor exited with code ${result.exitCode}`
      );
      result.failureCause = "process";
    }
    if (result.errorMessage) result.errorMessage = redactFailureMessage(result.errorMessage);
    const failureReason = classifyFailure(result);
    if (failureReason) {
      result.failureReason = failureReason;
      attempt.failureReason = failureReason;
    }
    attempt.finalReport = options.maxReportBytes
      ? boundedReportBytes(result.finalReport, options.maxReportBytes)
      : boundedReport(result.finalReport, options.maxReportChars);
    result.finalReport = attempt.finalReport;
    attempt.endedAt = Date.now();
    attempt.exitCode = result.exitCode;
    resolveOutcome(result);
  };
  const abortWithCause = (cause: "user_abort" | "cost_cap" | "stalled") => {
    if (abortCause) return;
    abortCause = cause;
    send({ type: "abort", maestroCause: cause });
    setTimeout(() => killGroup("SIGTERM"), KILL_GRACE_MS).unref();
    setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS * 2).unref();
  };
  const abort = () => abortWithCause("user_abort");
  const processEvent = (event: JsonEvent) => {
    // New detached supervisors handle this while unattended; retaining the
    // monitor response also keeps legacy detached attempts fail-safe.
    if (event.type === "extension_ui_request" && event.id) {
      send({ type: "extension_ui_response", id: event.id, cancelled: true });
    }
    if (event.type === "response" && event.command === "get_state" && event.data?.sessionFile) {
      attempt.sessionFile = event.data.sessionFile;
    }
    if (event.type === "response" && event.command === "prompt" && event.success === false) {
      result.errorMessage = event.error ?? "executor rejected the prompt";
      result.failureCause = "provider";
      killGroup("SIGTERM");
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      // The supervisor enforces the cap for current transports; keeping the
      // monitor-side check covers legacy detached attempts without one.
      if (applyAssistantMessage(result, attempt, event.message, options.maxCost)) {
        abortWithCause("cost_cap");
      }
    }
    const touched = touchedFile(event, cwd);
    if (touched && !attempt.touchedFiles.includes(touched)) attempt.touchedFiles.push(touched);
    options.onUpdate?.({
      turns: attempt.usage.turns,
      cost: attempt.usage.cost,
      lastActivity: event.toolName ?? event.type,
      lastEventAt: Date.now(),
      changedFileCount: attempt.touchedFiles.length,
      ...(attempt.sessionFile ? { sessionFile: attempt.sessionFile } : {}),
    });
  };
  const terminalState = (): DetachedTerminalState | undefined => {
    if (!attempt.exitFile || !existsSync(attempt.exitFile)) return undefined;
    let text: string;
    try {
      text = readFileSync(attempt.exitFile, "utf-8").trim();
    } catch {
      // An unreadable terminal file must not crash the monitor; liveness
      // polling still settles the attempt.
      return undefined;
    }
    try {
      const value = JSON.parse(text) as DetachedTerminalState;
      return value.version === 1 && typeof value.exitCode === "number" ? value : undefined;
    } catch {
      const code = Number.parseInt(text, 10);
      return Number.isFinite(code) ? { version: 1, exitCode: code } : undefined;
    }
  };
  const poll = () => {
    try {
      for (const line of readAppendedLines(attempt.logFile, tail)) {
        if (!line.trim()) continue;
        try {
          processEvent(JSON.parse(line) as JsonEvent);
        } catch {
          // Ignore malformed records; partial records stay buffered for the next poll.
        }
      }
    } catch {
      // The launcher may not have created its event file yet.
    }
    if (settled) return;
    const terminal = terminalState();
    if (terminal) {
      finish(terminal.exitCode ?? 1, terminal);
    } else if (!detachedAttemptIsLive(attempt)) {
      terminalPolls += 1;
      if (terminalPolls >= 2) finish(1);
    } else {
      terminalPolls = 0;
    }
  };
  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }
  poll();
  if (!settled) {
    timer = setInterval(poll, 100);
    timer.unref();
  }
  return {
    attempt,
    outcome,
    survivesShutdown: true,
    steer: (message: string) => send({ type: "steer", message }),
    followUp: (message: string) => send({ type: "follow_up", message }),
    abort,
  };
}

/** Locate an attempt's session file: direct reference, or legacy per-attempt dir scan. */
export function findSessionFile(attempt: {
  sessionFile?: string;
  sessionDir?: string;
}): string | undefined {
  if (attempt.sessionFile && existsSync(attempt.sessionFile)) return attempt.sessionFile;
  if (!attempt.sessionDir || !existsSync(attempt.sessionDir)) return undefined;
  const files = readdirSync(attempt.sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(attempt.sessionDir ?? "", name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array<TOut>(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      const item = items[current];
      if (item === undefined) return;
      results[current] = await fn(item, current);
    }
  });
  await Promise.all(workers);
  return results;
}
