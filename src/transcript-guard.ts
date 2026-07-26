import { basename } from "node:path";
import { LOGS_DIR, SESSION_NAMESPACE, STATE_DIR } from "./constants.js";

/**
 * Reading an agent transcript into the orchestrator's own conversation is
 * always a mistake, and a self-destructive one.
 *
 * Executor/reviewer session files and run logs are append-only records of
 * every tool result those agents produced — routinely megabytes. Pulling one
 * into context evicts the prompt cache, can exceed the window outright, and
 * (when the target is the orchestrator's *own* session) grows the file it is
 * reading on every call, so each read is larger than the last. One real run
 * reached 178k tokens across four such reads and could no longer be resumed.
 *
 * Bounded evidence for all of this is already available through
 * `maestro_drive` inspect and the dashboard, so blocking costs nothing.
 */

/** Read-only tools whose output lands directly in the model's context. */
const CONTEXT_LOADING_TOOLS = new Set(["read", "grep", "find", "ls"]);

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

/** A pi session transcript: `<uuid>.jsonl` or maestro's nested agent sessions. */
function isSessionTranscript(path: string): boolean {
  const normalized = normalize(path);
  if (!normalized.endsWith(".jsonl")) return false;
  if (normalized.includes(`/${SESSION_NAMESPACE}/`)) return true;
  if (normalized.includes("/sessions/")) return true;
  // A bare session filename still carries pi's timestamp_uuid shape.
  return /\d{4}-\d{2}-\d{2}T[\d-]+Z?_[0-9a-f-]{16,}\.jsonl$/i.test(basename(normalized));
}

/** A maestro run log under the project state directory. */
function isRunLog(path: string): boolean {
  const normalized = normalize(path);
  return (
    normalized.includes(`${STATE_DIR}/${LOGS_DIR}/`) ||
    (normalized.includes(`/${LOGS_DIR}/`) && normalized.endsWith(".jsonl"))
  );
}

export interface TranscriptGuardDecision {
  blocked: boolean;
  reason?: string;
}

/**
 * Decide whether a tool call would load an agent transcript into context.
 * `ownSessionFile` is the calling session, whose self-read is the worst case.
 */
export function guardTranscriptRead(
  toolName: string,
  input: Record<string, unknown> | undefined,
  ownSessionFile?: string
): TranscriptGuardDecision {
  if (!CONTEXT_LOADING_TOOLS.has(toolName)) return { blocked: false };
  const raw = input?.path ?? input?.file_path;
  if (typeof raw !== "string" || !raw) return { blocked: false };

  if (ownSessionFile && normalize(raw) === normalize(ownSessionFile)) {
    return {
      blocked: true,
      reason:
        "Blocked: this is your own session transcript. Reading it appends a copy of the conversation to the file you are reading, so every read grows the next one and the session becomes unresumable. Use maestro_drive inspect for board state and review evidence.",
    };
  }
  if (isSessionTranscript(raw) || isRunLog(raw)) {
    return {
      blocked: true,
      reason:
        "Blocked: agent session transcripts and run logs are unbounded records of replayed tool output, and loading one destroys your context and prompt cache. Use maestro_drive inspect for failure kind, reviewer verdicts, convergence, and notes; browse the raw transcript with /maestro agents instead.",
    };
  }
  return { blocked: false };
}
