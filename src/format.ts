import { type Task, type TaskStatus, type Usage } from "./types.js";

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
