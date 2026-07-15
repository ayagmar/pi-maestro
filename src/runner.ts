import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { KILL_GRACE_MS, LOGS_DIR } from "./constants.js";

const VERIFICATION_KILL_GRACE_MS = 250;

import { type Attempt, type FailureReason, type TierConfig, type Usage } from "./types.js";

export type RunFailureCause = "provider" | "process" | "user_abort" | "cost_cap" | "stalled";

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
}): Promise<VerificationResult> {
  const directory = join(options.stateDir, "verification");
  mkdirSync(directory, { recursive: true });
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
    let output = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-16_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process already exited.
      }
    };
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
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stop);
      writeFileSync(logFile, output);
      const exitCode = code ?? 1;
      resolve({
        ok: exitCode === 0 && !timedOut && !options.signal?.aborted,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        outputTail: output.slice(-4000),
        logFile,
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

export interface ExecutorHandle {
  attempt: Attempt;
  outcome: Promise<RunOutcome>;
  /** Queue a steering message into the running executor (delivered before its next LLM call). */
  steer(message: string): void;
  /** Queue a follow-up message until the executor has finished its current work. */
  followUp(message: string): void;
  /** Abort the executor. The outcome resolves with aborted: true. */
  abort(): void;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

function compactLogEvent(event: JsonEvent): boolean {
  return (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_end" ||
    event.type === "agent_start" ||
    event.type === "agent_end" ||
    event.type === "agent_settled" ||
    event.type === "message_end" ||
    (event.type === "response" && event.command === "get_state")
  );
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

function extractText(message: JsonEvent["message"]): string {
  if (!message?.content) return "";
  return message.content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
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
 * executor mid-run via stdin commands. The session is persisted under
 * stateDir/sessions/<runId> so the user can attach to it later, and every
 * stdout event is mirrored to stateDir/logs/<runId>.jsonl for live tailing.
 */
export function startExecutor(options: {
  stateDir: string;
  runId: string;
  cwd: string;
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
  signal?: AbortSignal;
  onUpdate?: (update: RunUpdate) => void;
}): ExecutorHandle {
  const logFile = join(options.stateDir, LOGS_DIR, `${options.runId}.jsonl`);
  mkdirSync(dirname(logFile), { recursive: true });

  const attempt: Attempt = {
    index: 0,
    logFile,
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

  // Sessions go to pi's default storage so /resume and usage reports see them;
  // the file path comes back via get_state and is stored on the attempt.
  const args = ["--mode", "rpc", "--thinking", options.tier.thinking];
  if (options.tier.model) args.push("--model", options.tier.model);
  if (options.tier.tools) args.push("--tools", options.tier.tools);

  const invocation = piInvocation(args);
  const proc = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    // The flag makes an installed pi-maestro extension no-op inside the
    // executor: no recursive orchestration, no crash-recovery fighting the
    // parent over the shared board file.
    env: { ...process.env, PI_MAESTRO_EXECUTOR: "1" },
  });

  const send = (command: Record<string, unknown>) => {
    if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(command)}\n`);
  };

  let abortCause: "user_abort" | "cost_cap" | "stalled" | undefined;
  const abortWithCause = (cause: "user_abort" | "cost_cap" | "stalled") => {
    if (abortCause) return;
    abortCause = cause;
    send({ type: "abort" });
    proc.stdin.end();
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGTERM");
    }, KILL_GRACE_MS).unref();
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, KILL_GRACE_MS * 2).unref();
  };
  const abort = () => abortWithCause("user_abort");

  const outcome = new Promise<RunOutcome>((resolve) => {
    const log = createWriteStream(logFile);
    const writeLogLine = cappedLogWriter(log, options.maxLogBytes);
    const result: RunOutcome = {
      exitCode: 0,
      usage: attempt.usage,
      finalReport: "",
      touchedFiles: attempt.touchedFiles,
      aborted: false,
    };
    let stderr = "";
    let buffer = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let lastActivity = "starting…";
    let lastEventAt = Date.now();
    let lastProgressAt = lastEventAt;
    let progressTurns = 0;
    let watchdogSteeredAt: number | undefined;
    const actionSignatures: string[] = [];
    const idleMs = Math.max(0, (options.watchdogIdleSeconds ?? 120) * 1000);

    const evaluateWatchdog = () => {
      const turnsWithoutProgress = attempt.usage.turns - progressTurns;
      const warningTurns = options.watchdogWarningTurns ?? 0;
      const silent = idleMs > 0 && Date.now() - lastEventAt >= idleMs;
      if (
        (silent || (warningTurns > 0 && turnsWithoutProgress >= warningTurns)) &&
        watchdogSteeredAt === undefined
      ) {
        watchdogSteeredAt = attempt.usage.turns;
        send({
          type: "steer",
          message:
            "Stop broad investigation. Either make the smallest in-scope implementation and run targeted verification, or report one concrete blocker within the next few turns.",
        });
        return;
      }
      if (
        watchdogSteeredAt !== undefined &&
        (silent || turnsWithoutProgress >= warningTurns + (options.watchdogTerminationTurns ?? 4))
      ) {
        abortWithCause("stalled");
      }
    };
    const watchdog = setInterval(
      evaluateWatchdog,
      Math.max(10, Math.min(1000, idleMs / 4 || 1000))
    );
    watchdog.unref();

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: JsonEvent;
      try {
        event = JSON.parse(line) as JsonEvent;
      } catch {
        if (options.logEvents !== "compact") writeLogLine(line);
        return;
      }
      if (options.logEvents !== "compact" || compactLogEvent(event)) writeLogLine(line);
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
        proc.stdin.end();
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGTERM");
        }, KILL_GRACE_MS).unref();
        return;
      }

      if (event.type === "tool_execution_start" && event.toolName) {
        lastActivity = event.toolName;
        actionSignatures.push(event.toolName.toLowerCase());
        if (actionSignatures.length > 8) actionSignatures.shift();
        if (/^(edit|write)$/.test(event.toolName)) {
          lastProgressAt = Date.now();
          progressTurns = attempt.usage.turns;
          watchdogSteeredAt = undefined;
        }
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        // Apply the cap after clearing a prior transient provider error. The
        // successful message that crosses the cap must still end as cost_cap.
        const exceededCostCap = applyAssistantMessage(
          result,
          attempt,
          event.message,
          options.maxCost
        );
        if (exceededCostCap && !abortCause) abortWithCause("cost_cap");
      }

      const touched = touchedFile(event, options.cwd);
      if (touched && !attempt.touchedFiles.includes(touched)) {
        attempt.touchedFiles.push(touched);
        lastProgressAt = Date.now();
        progressTurns = attempt.usage.turns;
        watchdogSteeredAt = undefined;
      }

      if (event.type === "agent_settled") {
        // No retry, compaction, or queued continuation remains. Closing stdin
        // now triggers RPC shutdown and session flush.
        proc.stdin.end();
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGTERM");
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
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearInterval(watchdog);
      buffer += stdoutDecoder.end();
      if (buffer.trim()) processLine(buffer);
      log.end();
      result.exitCode = code ?? 0;
      if (result.errorMessage && result.exitCode === 0) result.exitCode = 1;
      // Auth exists at preflight but tokens can be expired or out of quota;
      // the provider error alone doesn't tell the user how to recover.
      if (result.errorMessage?.includes("No API key for provider")) {
        result.errorMessage +=
          " — the provider's OAuth token is likely expired or out of quota. Re-run `pi /login` for it, or pick another model in /maestro config.";
      }
      if (result.errorMessage) result.errorMessage = redactFailureMessage(result.errorMessage);
      // A cost-cap abort carries an errorMessage and must land as a failure
      // (retryable, visible reason), not as a user cancellation.
      result.aborted = abortCause === "user_abort";
      if (abortCause) result.failureCause = abortCause;
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
      resolve(result);
    });

    proc.on("error", (error) => {
      clearInterval(watchdog);
      log.end();
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
      resolve(result);
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
