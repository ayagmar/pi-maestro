import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { KILL_GRACE_MS, LOGS_DIR, SESSIONS_DIR } from "./constants.js";
import { type Attempt, type TierConfig, type Usage } from "./types.js";

export interface RunOutcome {
  exitCode: number;
  usage: Usage;
  finalReport: string;
  touchedFiles: string[];
  model?: string;
  aborted: boolean;
  errorMessage?: string;
}

export interface RunUpdate {
  turns: number;
  cost: number;
  lastActivity: string;
}

export interface ExecutorHandle {
  attempt: Attempt;
  outcome: Promise<RunOutcome>;
  /** Queue a steering message into the running executor (delivered before its next LLM call). */
  steer(message: string): void;
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

export interface JsonEvent {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
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
  /** Abort the run when attempt cost exceeds this (USD). 0 disables the cap. */
  maxCost?: number;
  signal?: AbortSignal;
  onUpdate?: (update: RunUpdate) => void;
}): ExecutorHandle {
  const sessionDir = join(options.stateDir, SESSIONS_DIR, options.runId);
  const logFile = join(options.stateDir, LOGS_DIR, `${options.runId}.jsonl`);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });

  const attempt: Attempt = {
    index: 0,
    sessionDir,
    logFile,
    thinking: options.tier.thinking,
    startedAt: Date.now(),
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
  };
  if (options.tier.model !== undefined) attempt.model = options.tier.model;

  const args = ["--mode", "rpc", "--session-dir", sessionDir, "--thinking", options.tier.thinking];
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

  let wasAborted = false;
  const abort = () => {
    if (wasAborted) return;
    wasAborted = true;
    send({ type: "abort" });
    proc.stdin.end();
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGTERM");
    }, KILL_GRACE_MS).unref();
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, KILL_GRACE_MS * 2).unref();
  };

  const outcome = new Promise<RunOutcome>((resolve) => {
    const log = createWriteStream(logFile);
    const result: RunOutcome = {
      exitCode: 0,
      usage: attempt.usage,
      finalReport: "",
      touchedFiles: attempt.touchedFiles,
      aborted: false,
    };
    let stderr = "";
    let buffer = "";
    let lastActivity = "starting…";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      log.write(`${line}\n`);
      let event: JsonEvent;
      try {
        event = JSON.parse(line) as JsonEvent;
      } catch {
        return;
      }

      // Executors run headless: auto-cancel any extension dialog so
      // permission gates fail safe instead of hanging the run.
      if (event.type === "extension_ui_request" && event.id) {
        send({ type: "extension_ui_response", id: event.id, cancelled: true });
        return;
      }

      // A rejected prompt (bad model, missing API key, ...) would otherwise
      // leave the process idle forever. Fail fast with the provider error.
      if (event.type === "response" && event.command === "prompt" && event.success === false) {
        result.errorMessage = event.error ?? "executor rejected the prompt";
        proc.stdin.end();
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGTERM");
        }, KILL_GRACE_MS).unref();
        return;
      }

      if (event.type === "tool_execution_start" && event.toolName) {
        lastActivity = event.toolName;
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        const usage = event.message.usage;
        attempt.usage.turns += 1;
        attempt.usage.input += usage?.input ?? 0;
        attempt.usage.output += usage?.output ?? 0;
        attempt.usage.cost += usage?.cost?.total ?? 0;
        if (options.maxCost && attempt.usage.cost > options.maxCost && !wasAborted) {
          result.errorMessage = `cost cap exceeded: $${attempt.usage.cost.toFixed(4)} > $${options.maxCost} (maxCostPerTask)`;
          abort();
        }
        if (!result.model && event.message.model) result.model = event.message.model;
        // The latest assistant message decides: a transient provider error
        // followed by a successful turn must not fail the whole run.
        if (event.message.errorMessage) result.errorMessage = event.message.errorMessage;
        else delete result.errorMessage;
        const text = extractText(event.message);
        if (text) result.finalReport = text;
      }

      const touched = touchedFile(event, options.cwd);
      if (touched && !attempt.touchedFiles.includes(touched)) {
        attempt.touchedFiles.push(touched);
      }

      if (event.type === "agent_end") {
        // Work is done; closing stdin triggers RPC shutdown and session flush.
        proc.stdin.end();
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGTERM");
        }, KILL_GRACE_MS).unref();
      }

      options.onUpdate?.({ turns: attempt.usage.turns, cost: attempt.usage.cost, lastActivity });
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
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
      // A cost-cap abort carries an errorMessage and must land as a failure
      // (retryable, visible reason), not as a user cancellation.
      result.aborted = wasAborted && !result.errorMessage;
      if (result.exitCode !== 0 && !result.errorMessage && !wasAborted) {
        result.errorMessage = stderr.trim() || `executor exited with code ${result.exitCode}`;
      }
      attempt.endedAt = Date.now();
      attempt.exitCode = result.exitCode;
      resolve(result);
    });

    proc.on("error", (error) => {
      log.end();
      result.exitCode = 1;
      result.errorMessage = error.message;
      attempt.endedAt = Date.now();
      attempt.exitCode = 1;
      resolve(result);
    });

    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }

    send({ type: "prompt", message: options.prompt });
  });

  return {
    attempt,
    outcome,
    steer: (message: string) => send({ type: "steer", message }),
    abort,
  };
}

/** Locate the persisted session file for an attempt, for attaching in the TUI. */
export function findSessionFile(sessionDir: string): string | undefined {
  if (!existsSync(sessionDir)) return undefined;
  const files = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionDir, name))
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
