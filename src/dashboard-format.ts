import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Attempt, type Task, type Usage } from "./types.js";

export function lastAttemptReport(task: Task): string | undefined {
  return task.attempts.at(-1)?.finalReport;
}

export function latestFailure(task: Task): string | undefined {
  const attempt = task.attempts.at(-1);
  const reason = attempt?.failureReason;
  if (reason && ["failed", "changes_requested", "ready_for_review"].includes(task.status)) {
    const retry = reason.retryable ? "retryable" : "not retryable";
    return `${reason.kind.replaceAll("_", " ")} · ${singleLine(reason.message)} · ${retry}`;
  }
  if (task.status === "changes_requested") return "reviewer rejection";
  if (task.status !== "failed") return undefined;
  if (attempt?.errorMessage) return singleLine(attempt.errorMessage);
  return "executor failed without a recorded reason";
}

export function attemptDetails(attempt: Attempt): string {
  const model = attempt.model ?? "unknown model";
  const provider = attempt.provider ?? "unknown provider";
  return `Latest #${attempt.index}: model ${model} · provider ${provider} · ${attempt.usage.turns} turns · $${attempt.usage.cost.toFixed(4)}`;
}

export function executorUsage(attempt: Attempt): Usage {
  const review = attempt.reviewUsage;
  if (!review) return attempt.usage;
  return {
    input: Math.max(0, attempt.usage.input - review.input),
    output: Math.max(0, attempt.usage.output - review.output),
    cost: Math.max(0, attempt.usage.cost - review.cost),
    turns: Math.max(0, attempt.usage.turns - review.turns),
  };
}

export function formatPromptSections(
  sections: Array<{ name: string; characters: number; omitted: boolean }> | undefined
): string {
  if (!sections?.length) return "";
  return ` · ${sections
    .map((section) => `${section.name} ${section.characters}${section.omitted ? " omitted" : ""}`)
    .join(", ")}`;
}

export function attemptHistory(attempt: Attempt): string {
  let outcome = "in progress";
  if (attempt.failureReason) outcome = attempt.failureReason.kind.replaceAll("_", " ");
  else if (attempt.reviewNotes) outcome = "changes requested";
  else if (attempt.reviewReport) outcome = "reviewed";
  else if (attempt.finalReport) outcome = "completed";
  else if (attempt.exitCode !== undefined) outcome = attempt.exitCode === 0 ? "finished" : "failed";
  const provider = attempt.provider ?? "?";
  const model = attempt.model ?? "?";
  const identity = model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
  return `#${attempt.index} ${outcome} · ${identity} · ${attempt.usage.turns}t · $${attempt.usage.cost.toFixed(4)}`;
}

export function relativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "recently";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  return w >= width ? truncateToWidth(line, width) : line + " ".repeat(width - w);
}

export function wrapText(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, width);
}
