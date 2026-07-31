import { visibleWidth } from "@earendil-works/pi-tui";
import { type BoardUsageSummary, type Task, type TaskStatus, type Usage } from "./types.js";

export interface StatusHistoryRow {
  ts: string;
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
}

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

/**
 * Reviewer spend folded into an attempt's total. Reviewer usage is accumulated
 * into attempt.usage as launches settle, so executor cost is the remainder.
 */
function reviewCost(attempt: Task["attempts"][number]): number {
  const launches = attempt.reviewLaunches;
  if (launches && launches.length > 0) {
    return launches.reduce((sum, launch) => sum + launch.usage.cost, 0);
  }
  return attempt.reviewUsage?.cost ?? 0;
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

export function padText(value: string, width: number): string {
  const currentWidth = visibleWidth(value);
  return currentWidth >= width ? value : value + " ".repeat(width - currentWidth);
}

export function formatStatusHistory(
  entries: readonly StatusHistoryRow[],
  skipped = 0,
  count = 20
): string {
  const selected = entries.slice(-count);
  if (selected.length === 0)
    return skipped > 0 ? `(${skipped} unreadable line(s) skipped)` : "No history yet.";
  const taskWidth = Math.max(4, ...selected.map((entry) => entry.taskId.length));
  const fromWidth = Math.max(4, ...selected.map((entry) => entry.from.length));
  const dates = new Set(selected.map((entry) => new Date(entry.ts).toISOString().slice(0, 10)));
  const lines = [
    `${padText("time", 8)}  ${padText("task", taskWidth)}  ${padText("from", fromWidth)} → to`,
  ];
  let currentDate: string | undefined;
  for (const entry of selected) {
    const timestamp = new Date(entry.ts).toISOString();
    const date = timestamp.slice(0, 10);
    if (dates.size > 1 && date !== currentDate) {
      lines.push(date);
      currentDate = date;
    }
    lines.push(
      `${timestamp.slice(11, 19)}  ${padText(entry.taskId, taskWidth)}  ${padText(entry.from, fromWidth)} → ${entry.to}`
    );
  }
  if (skipped > 0) lines.push(`(${skipped} unreadable line(s) skipped)`);
  return lines.join("\n");
}

export function formatCostSummary(tasks: Task[]): string {
  const usage = boardUsageSummary(tasks);
  const parts = [
    `run: ${usage.totalAttempts} attempt${usage.totalAttempts === 1 ? "" : "s"} · $${usage.totalCost.toFixed(4)} total · $${usage.averageMeaningfulCost.toFixed(4)} avg (billed)`,
  ];
  // The question every expensive run eventually asks is "what did the money
  // buy?". Landed = spend on tasks that reached approval (their rejected
  // attempts included: that was the cost of landing them). In flight = spend
  // on tasks still being worked. Sunk = spend on cancelled work.
  if (usage.totalCost > 0) {
    const landedTasks = tasks.filter((task) => task.status === "approved");
    const landed = boardUsage(landedTasks).cost;
    const sunk = boardUsage(tasks.filter((task) => task.status === "cancelled")).cost;
    const inFlight = Math.max(0, usage.totalCost - landed - sunk);
    parts.push(
      `value: $${landed.toFixed(4)} landed across ${landedTasks.length} approved task${landedTasks.length === 1 ? "" : "s"} · $${inFlight.toFixed(4)} in flight · $${sunk.toFixed(4)} sunk in cancelled work`
    );
  }
  if (usage.models.length > 0) parts.push(`models: ${usage.models.join(", ")}`);
  if (usage.providers.length > 0) parts.push(`providers: ${usage.providers.join(", ")}`);
  const promptAccounting = tasks.reduce(
    (total, task) => {
      for (const attempt of task.attempts) {
        total.executor += attempt.promptCharacters ?? 0;
        total.reviewer += (attempt.reviewLaunches ?? []).reduce(
          (sum, launch) => sum + (launch.promptCharacters ?? 0),
          0
        );
        total.omissions += (attempt.promptSections ?? []).filter(
          (section) => section.omitted
        ).length;
        total.omissions += (attempt.reviewLaunches ?? []).reduce(
          (sum, launch) =>
            sum + (launch.promptSections ?? []).filter((section) => section.omitted).length,
          0
        );
      }
      return total;
    },
    { executor: 0, reviewer: 0, omissions: 0 }
  );
  if (promptAccounting.executor > 0 || promptAccounting.reviewer > 0) {
    parts.push(
      `context: executor ${promptAccounting.executor} chars · reviewer ${promptAccounting.reviewer} chars · ${promptAccounting.omissions} omitted section(s)`
    );
  }
  const categorized = new Map<string, number>();
  for (const task of tasks) {
    for (const attempt of task.attempts) {
      const kind = attempt.failureReason?.kind;
      const label =
        task.integratedCommit && task.approvalKind === "reviewed"
          ? "reviewed-integrated"
          : kind === "provider_failure"
            ? "provider-failure"
            : kind === "reviewer_rejection"
              ? "reviewer-rejection"
              : kind === "stalled" || kind === "cost_cap" || kind === "user_abort"
                ? kind.replaceAll("_", "-")
                : "other";
      categorized.set(label, (categorized.get(label) ?? 0) + attempt.usage.cost);
    }
  }
  const spend = [...categorized].map(([label, cost]) => `${label} $${cost.toFixed(4)}`);
  const reconciledCost = [...categorized.values()].reduce((sum, cost) => sum + cost, 0);
  if (usage.totalAttempts > 0) spend.push(`reconciled $${reconciledCost.toFixed(4)}`);
  if (spend.length > 0) parts.push(`spend: ${spend.join(" · ")}`);

  // Where the money actually went. A board can look cheap per attempt while a
  // few tasks quietly consume most of the run through repeated review panels.
  const perTask = tasks
    .map((task) => {
      const executor = task.attempts.reduce(
        (sum, attempt) => sum + (attempt.usage.cost - reviewCost(attempt)),
        0
      );
      const review = task.attempts.reduce((sum, attempt) => sum + reviewCost(attempt), 0);
      const reviewLaunches = task.attempts.reduce(
        (count, attempt) => count + (attempt.reviewLaunches?.length ?? 0),
        0
      );
      return {
        id: task.id,
        total: executor + review,
        executor,
        review,
        attempts: task.attempts.length,
        reviewLaunches,
      };
    })
    .filter((entry) => entry.total > 0)
    .sort((left, right) => right.total - left.total);
  // With one costed task the totals above already say everything; the
  // breakdown only earns its lines once spend is distributed.
  if (perTask.length > 1) {
    const lines = perTask
      .slice(0, 10)
      .map(
        (entry) =>
          `  ${entry.id} $${entry.total.toFixed(4)} · exec $${entry.executor.toFixed(4)} (${entry.attempts} launch${entry.attempts === 1 ? "" : "es"}) · review $${entry.review.toFixed(4)} (${entry.reviewLaunches} launch${entry.reviewLaunches === 1 ? "" : "es"})`
      );
    if (perTask.length > 10) lines.push(`  … ${perTask.length - 10} cheaper task(s) omitted`);
    parts.push(`per task (most expensive first):\n${lines.join("\n")}`);
  }
  return parts.join("\n");
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

/** Spend on tasks that are still active; the remainder is sunk in cancelled work. */
export function activeRunCost(tasks: Task[]): number {
  return boardUsage(tasks.filter((task) => task.status !== "cancelled")).cost;
}

/** USD left before the run budget blocks dispatch, or undefined when the cap is off. */
export function remainingRunBudget(tasks: Task[], maxRunCost: number): number | undefined {
  if (maxRunCost <= 0) return undefined;
  return Math.max(0, maxRunCost - boardUsage(tasks).cost);
}

/**
 * The budget bounds every real dollar this board has ever spent — sunk cost
 * of cancelled and superseded tasks included. Excluding sunk spend was tried
 * and is a laundering hole: superseding a task freed its budget, so a
 * cancel-and-replan loop could spend without bound under a cap that claimed
 * to bound the run. Recovery from a genuinely exhausted budget is one
 * deliberate human step, not an accounting exemption.
 */
export function runBudgetWarning(tasks: Task[], maxRunCost: number): string | undefined {
  if (maxRunCost <= 0) return undefined;
  const total = boardUsage(tasks).cost;
  if (total <= maxRunCost) return undefined;
  const sunk = total - activeRunCost(tasks);
  const sunkNote = sunk > 0 ? ` · $${sunk.toFixed(4)} of it sunk in cancelled tasks` : "";
  return `run budget exceeded ($${total.toFixed(4)} of $${maxRunCost} lifetime board spend${sunkNote}); raise it deliberately with /maestro config budget <usd>, or /maestro reset to archive the board`;
}

export function taskLine(task: Task): string {
  const glyph = STATUS_GLYPHS[task.status];
  const usage = taskUsage(task);
  const cost = usage.cost ? ` · $${usage.cost.toFixed(4)}` : "";
  const attempts = task.attempts.length > 1 ? ` · attempt ${task.attempts.length}` : "";
  return `${glyph} ${task.id} ${task.title} · ${STATUS_LABELS[task.status]}${attempts}${cost}`;
}

/** Compact "4m12s" wall-clock for agent selector rows. */
export function formatElapsed(startedAt: number | undefined, endedAt?: number): string {
  if (startedAt === undefined || !Number.isFinite(startedAt)) return "";
  const seconds = Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Character bound for text that is injected into a model conversation. */
export function truncateCharacters(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}… (${text.length - maxCharacters} more characters)`;
}

export function truncateText(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)`;
}
