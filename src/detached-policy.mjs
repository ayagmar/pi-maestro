const REPORT_MARKER = "\n… [report truncated; full evidence remains in the session log] …\n";

/** How long a settled transport drains buffered stdout before writing its outcome. */
export const EXIT_SETTLE_DRAIN_MS = 2_000;

export const WATCHDOG_STEER_MESSAGES = {
  implementation:
    "Stop broad investigation. Either make the smallest in-scope implementation and run targeted verification, or report one concrete blocker within the next few turns.",
  investigation:
    "Converge now. Stop opening new lines of inquiry: consolidate what you have found into the required report format within the next few turns, or report one concrete blocker.",
  review:
    "Converge now. Stop expanding the review: finish verifying the remaining acceptance criteria and end with your VERDICT line within the next few turns.",
};

export const HANDLED_PROMPT_ERROR =
  "the executor's prompt was consumed by an extension command or input handler; no agent run started";

/**
 * pi answers an RPC prompt with data.disposition "handled" when an extension
 * command or input handler consumed it. No run starts, so agent_settled
 * never follows.
 */
export function promptHandledWithoutRun(event) {
  return (
    event.type === "response" &&
    event.command === "prompt" &&
    event.success !== false &&
    event.data?.disposition === "handled"
  );
}

/**
 * Usage pi bills outside assistant messages: compaction summaries
 * (compaction_end result.usage, present even when the compaction then
 * retries), usage entries such as cache warming (entry_appended), and
 * toolResult message usage. pi's own session stats count all of these.
 * Assistant message_end usage is accounted separately with the turn.
 */
export function billedUsage(event) {
  if (event.type === "compaction_end") return event.result?.usage;
  if (event.type === "entry_appended" && event.entry?.type === "usage") return event.entry.usage;
  if (event.type === "message_end" && event.message?.role === "toolResult") {
    return event.message.usage;
  }
  return undefined;
}

export function compactEvent(event) {
  return (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_end" ||
    event.type === "agent_start" ||
    event.type === "agent_end" ||
    event.type === "agent_settled" ||
    event.type === "message_end" ||
    // Billed outside assistant messages; kept so replay and reattach recover the spend.
    event.type === "compaction_end" ||
    (event.type === "entry_appended" && event.entry?.type === "usage") ||
    (event.type === "response" && event.command === "get_state")
  );
}

export function extractText(message) {
  if (!message?.content) return "";
  return message.content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

export function boundedText(report, maxChars) {
  if (report.length <= maxChars) return report;
  const available = maxChars - REPORT_MARKER.length;
  if (available <= 0) return report.slice(0, maxChars);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${report.slice(0, head)}${REPORT_MARKER}${report.slice(-tail)}`;
}

/** Largest cut position at or below index that lands on a UTF-8 character start. */
function characterBoundary(source, index) {
  let cut = Math.min(source.length, Math.max(0, index));
  while (cut > 0 && cut < source.length && (source[cut] & 0xc0) === 0x80) cut -= 1;
  return cut;
}

export function boundedBytes(report, maxBytes) {
  const source = Buffer.from(report, "utf8");
  if (source.byteLength <= maxBytes) return report;
  const markerBytes = Buffer.byteLength(REPORT_MARKER, "utf8");
  const available = maxBytes - markerBytes;
  if (available <= 0) {
    return source.subarray(0, characterBoundary(source, maxBytes)).toString("utf8");
  }
  // Trim only the byte split points to character starts. The report's own
  // content — including legitimate U+FFFD characters — is preserved as-is.
  const headEnd = characterBoundary(source, Math.ceil(available / 2));
  let tailStart = Math.max(0, source.length - Math.floor(available / 2));
  while (tailStart < source.length) {
    const byte = source[tailStart];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    tailStart += 1;
  }
  const head = source.subarray(0, headEnd).toString("utf8");
  const tail = source.subarray(tailStart).toString("utf8");
  return `${head}${REPORT_MARKER}${tail}`;
}
