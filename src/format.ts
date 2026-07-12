import { type BoardUsageSummary, type Task, type TaskStatus, type Usage } from "./types.js";

export const STATUS_GLYPHS: Record<TaskStatus, string> = {
  todo: "○",
  running: "◐",
  ready_for_review: "●",
  changes_requested: "↻",
  approved: "✓",
  failed: "✗",
  cancelled: "⊘",
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "todo",
  running: "running",
  ready_for_review: "ready for review",
  changes_requested: "changes requested",
  approved: "approved",
  failed: "failed",
  cancelled: "cancelled",
};

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: Usage): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

export function taskUsage(task: Task): Usage {
  const total: Usage = { input: 0, output: 0, cost: 0, turns: 0 };
  for (const attempt of task.attempts) {
    total.input += attempt.usage.input;
    total.output += attempt.usage.output;
    total.cost += attempt.usage.cost;
    total.turns += attempt.usage.turns;
  }
  return total;
}

export function boardUsage(tasks: Task[]): Usage {
  const total: Usage = { input: 0, output: 0, cost: 0, turns: 0 };
  for (const task of tasks) {
    const usage = taskUsage(task);
    total.input += usage.input;
    total.output += usage.output;
    total.cost += usage.cost;
    total.turns += usage.turns;
  }
  return total;
}

export function boardUsageSummary(tasks: Task[]): BoardUsageSummary {
  let totalAttempts = 0;
  let totalCost = 0;
  let meaningfulAttempts = 0;
  let meaningfulCost = 0;
  const models = new Set<string>();
  const providers = new Set<string>();

  for (const task of tasks) {
    for (const attempt of task.attempts) {
      totalAttempts += 1;
      totalCost += attempt.usage.cost;
      if (attempt.usage.cost > 0) {
        meaningfulAttempts += 1;
        meaningfulCost += attempt.usage.cost;
      }
      if (attempt.model) models.add(attempt.model);
      if (attempt.reviewModel) models.add(attempt.reviewModel);

      if (attempt.provider) providers.add(attempt.provider);
      else if (attempt.model?.includes("/"))
        providers.add(attempt.model.split("/", 1)[0] as string);
      if (attempt.reviewProvider) providers.add(attempt.reviewProvider);
      else if (attempt.reviewModel?.includes("/")) {
        providers.add(attempt.reviewModel.split("/", 1)[0] as string);
      }
    }
  }

  return {
    totalAttempts,
    totalCost,
    averageMeaningfulCost: meaningfulAttempts === 0 ? 0 : meaningfulCost / meaningfulAttempts,
    models: [...models],
    providers: [...providers],
  };
}

export function formatCostSummary(tasks: Task[]): string {
  const usage = boardUsageSummary(tasks);
  const parts = [
    `${usage.totalAttempts} attempt${usage.totalAttempts === 1 ? "" : "s"}`,
    `$${usage.totalCost.toFixed(4)} total`,
    `$${usage.averageMeaningfulCost.toFixed(4)} avg billed attempt`,
  ];
  if (usage.models.length > 0) parts.push(`models: ${usage.models.join(", ")}`);
  if (usage.providers.length > 0) parts.push(`providers: ${usage.providers.join(", ")}`);
  return parts.join(" · ");
}

/**
 * Net status changes since the previous status pulse, so each pulse can report
 * what advanced without the orchestrator re-reading executor transcripts.
 * Returns undefined for the first pulse (no baseline to compare against yet).
 */
export function describeProgressDelta(
  previous: Map<string, TaskStatus> | undefined,
  tasks: Task[]
): string | undefined {
  if (!previous) return undefined;
  const changes = tasks
    .filter((task) => previous.get(task.id) !== task.status)
    .map(
      (task) =>
        `${task.id} ${previous.get(task.id) ? STATUS_LABELS[previous.get(task.id) as TaskStatus] : "new"} → ${STATUS_LABELS[task.status]}`
    );
  return changes.length > 0
    ? `Advanced since last pulse: ${changes.join(", ")}`
    : "No status change since last pulse.";
}

export function formatBoardProgress(tasks: Task[]): string {
  const approved = tasks.filter((task) => task.status === "approved").length;
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  const active = tasks.length - cancelled;
  const cancelledPart = cancelled > 0 ? ` · ${cancelled} cancelled` : "";
  return `${approved}/${active}${cancelledPart}`;
}

export function runBudgetWarning(tasks: Task[], maxRunCost: number): string | undefined {
  const totalCost = boardUsage(tasks).cost;
  if (maxRunCost <= 0 || totalCost <= maxRunCost) return undefined;
  return `run budget exceeded ($${totalCost.toFixed(4)} of $${maxRunCost})`;
}

export function taskLine(task: Task): string {
  const glyph = STATUS_GLYPHS[task.status];
  const usage = taskUsage(task);
  const cost = usage.cost ? ` · $${usage.cost.toFixed(4)}` : "";
  const attempts = task.attempts.length > 1 ? ` · attempt ${task.attempts.length}` : "";
  return `${glyph} ${task.id} ${task.title} · ${STATUS_LABELS[task.status]}${attempts}${cost}`;
}

export function truncateText(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)`;
}
