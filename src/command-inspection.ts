import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completionFreshness } from "./artifact-policy.js";
import {
  findTask,
  listArchivedBoards,
  loadArchivedBoard,
  loadBoard,
  planValidationMessage,
  updateBoard,
  validatePlan,
} from "./board.js";
import { describeConfig, loadConfig, saveProjectBudget } from "./config.js";
import {
  activeRunCost,
  boardUsage,
  formatCostSummary,
  launchBudgetShortfall,
  runBudgetWarning,
} from "./format.js";
import { notify } from "./handoff.js";
import { deriveModelInsights, formatModelInsights } from "./insights.js";
import { assertKnownTaskIds } from "./session-control.js";
import { showSettings } from "./settings-ui.js";
import { deriveRunTimeline, formatRunTimeline } from "./timeline.js";
import { type Board, type MaestroConfig } from "./types.js";
import { simulatePlan } from "./workflow.js";
import { calculateSchedulingWave } from "./workflow-policy.js";
import { terminalReviewConvergence } from "./workflow-stop-policy.js";
import { worktreeRecoveryExists } from "./worktree.js";

export async function handleConfigCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  onChanged: () => void
): Promise<void> {
  const [sub, ...args] = rest.split(/\s+/).filter(Boolean);
  if (sub === "budget") {
    handleBudgetCommand(ctx, args.length ? args.join(" ") : undefined, onChanged);
    return;
  }
  if (ctx.mode !== "tui" || rest === "show") {
    notify(ctx, describeConfig(loadConfig(ctx.cwd)));
    return;
  }
  const scope = rest === "project" ? "project" : "user";
  await showSettings(ctx, scope);
  onChanged();
}

/**
 * What the scheduler would say about the budget right now. It checks the
 * budget only while work it could dispatch (an executor launch or a review in
 * `taskIds`' scope, the whole board when undefined) remains, with the same
 * exceeded and launch-floor predicates the drive uses before it launches.
 */
function remainingWorkBudgetBlocker(
  board: Board,
  config: MaestroConfig,
  taskIds?: string[]
): string | undefined {
  const wave = calculateSchedulingWave(board, config, taskIds);
  const reviewable = board.tasks.filter(
    (task) => wave.reviewableIds.includes(task.id) && !terminalReviewConvergence(task)
  );
  if (wave.runnableIds.length === 0 && reviewable.length === 0) return undefined;
  return (
    runBudgetWarning(board.tasks, config.maxRunCost) ??
    launchBudgetShortfall(board.tasks, {
      maxRunCost: config.maxRunCost,
      maxCostPerTask: config.maxCostPerTask,
    })
  );
}

/**
 * The one-step recovery from budget_blocked. The budget counts every dollar
 * the board has ever spent (sunk cost included), so continuing after an
 * exhausted budget is a deliberate human raise — this command — rather than
 * an accounting exemption or a JSON-file scavenger hunt.
 */
function handleBudgetCommand(
  ctx: ExtensionCommandContext,
  amountRaw: string | undefined,
  onChanged: () => void
): void {
  const tasks = loadBoard(ctx.cwd).tasks;
  const total = boardUsage(tasks).cost;
  const sunk = total - activeRunCost(tasks);
  const spendSummary = `board spend $${total.toFixed(4)}${sunk > 0 ? ` ($${sunk.toFixed(4)} sunk in cancelled tasks)` : ""}`;
  if (amountRaw === undefined) {
    const { maxRunCost } = loadConfig(ctx.cwd);
    const current = maxRunCost === 0 ? "off" : `$${maxRunCost}`;
    notify(
      ctx,
      `Run budget: ${current} · ${spendSummary}. Set it with /maestro config budget <usd> (0 disables).`
    );
    return;
  }
  const amount = Number(amountRaw.replace(/^\$/, ""));
  if (
    !/^\$?(?:\d+\.?\d*|\.\d+)$/.test(amountRaw) ||
    amount > 1_000_000 ||
    (amount === 0 && /[1-9]/.test(amountRaw))
  ) {
    notify(ctx, "Budget must be a number of USD from 0 to 1000000 (0 disables).", "warning");
    return;
  }
  try {
    saveProjectBudget(ctx.cwd, amount);
  } catch (error) {
    notify(
      ctx,
      `Budget not saved: ${error instanceof Error ? error.message : String(error)}`,
      "warning"
    );
    return;
  }
  // The raise is the fix for a pending budget stop: resolve it in the same
  // step so recovery is one command instead of config-edit + decision surgery.
  // It only counts as a fix when the scheduler would now dispatch, judged on
  // fresh spend and the saved effective config.
  const config = loadConfig(ctx.cwd);
  let resolvedDecision = false;
  let hadPendingStop = false;
  const stop: { reason?: string } = {};
  updateBoard(ctx.cwd, (board) => {
    const decision = board.activeDecision;
    const pending =
      decision && !decision.resolution && decision.kind === "budget_blocked" ? decision : undefined;
    hadPendingStop = pending !== undefined;
    const spent = boardUsage(board.tasks).cost;
    const blocker = remainingWorkBudgetBlocker(board, config, pending?.taskIds);
    if (blocker) stop.reason = blocker;
    else if (pending && amount !== 0 && spent >= amount) {
      stop.reason = `board spend $${spent.toFixed(4)} is not below the $${amount} budget; set a budget above that, or 0 to turn the cap off`;
    }
    if (!pending || stop.reason) return false;
    pending.resolution = { intervention: "resume", resolvedAt: Date.now() };
    delete pending.deliveryClaim;
    resolvedDecision = true;
    return true;
  });
  const remaining =
    amount === 0 ? "budget disabled" : `$${Math.max(0, amount - total).toFixed(4)} remaining`;
  const outcome =
    stop.reason === undefined
      ? `${resolvedDecision ? " Pending budget_blocked decision resolved." : ""} Use /maestro resume or /maestro drive to continue.`
      : hadPendingStop
        ? ` The budget stop stays pending: ${stop.reason}.`
        : ` A drive would stop again: ${stop.reason}.`;
  notify(
    ctx,
    `Run budget → ${amount === 0 ? "off" : `$${amount}`} · ${spendSummary} · ${remaining}.${outcome}`,
    stop.reason === undefined ? "info" : "warning"
  );
  onChanged();
}

export function handleSimulationCommand(ctx: ExtensionCommandContext, rest: string): void {
  const taskIds = rest ? rest.split(/[\s,]+/).filter(Boolean) : undefined;
  const board = loadBoard(ctx.cwd);
  assertKnownTaskIds(board, taskIds);
  const config = loadConfig(ctx.cwd);
  const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
  notify(ctx, validationError ?? simulatePlan(board, config, taskIds));
}

export function handleCostsCommand(ctx: ExtensionCommandContext): void {
  const board = loadBoard(ctx.cwd);
  notify(
    ctx,
    board.tasks.length === 0
      ? "No recorded costs; the board is empty."
      : formatCostSummary(board.tasks)
  );
}

export function handleInsightsCommand(ctx: ExtensionCommandContext): void {
  const current = loadBoard(ctx.cwd);
  const archives = listArchivedBoards(ctx.cwd).flatMap(({ file }) => {
    try {
      return [loadArchivedBoard(ctx.cwd, file)];
    } catch {
      return [];
    }
  });
  notify(ctx, formatModelInsights(deriveModelInsights([current, ...archives]), archives.length));
}

export function handleReconcileCommand(ctx: ExtensionCommandContext): void {
  const warnings: string[] = [];
  const board = loadBoard(ctx.cwd);
  const config = loadConfig(ctx.cwd);
  const decision = board.activeDecision;
  if (decision && !decision.resolution) {
    const matching = decision.taskIds.some((id) => {
      const task = board.tasks.find((candidate) => candidate.id === id);
      return decision.kind === "reviewer_failure"
        ? task?.status === "failed" || task?.status === "changes_requested"
        : task?.dispatchClaim !== undefined;
    });
    if (!matching) {
      warnings.push(
        `${decision.id}: unresolved ${decision.kind} decision has no matching task or live dispatch state`
      );
    }
  }

  for (const task of board.tasks) {
    if (task.status === "approved") {
      const freshness = completionFreshness(board, task, config);
      if (freshness.state !== "fresh") {
        warnings.push(`${task.id}: ${freshness.state} completion — ${freshness.reason}`);
      }
    }
    if (task.approvalKind === "manual") warnings.push(`${task.id}: manually accepted`);
    if (task.status === "approved" && task.approvalKind !== "reviewed") {
      warnings.push(`${task.id}: approved without a reviewed artifact`);
    }
    if (task.approvalKind === "reviewed" && !task.provenance?.candidateTree) {
      warnings.push(`${task.id}: reviewed approval is missing its authoritative Git tree`);
    }
    if (task.approvalKind === "reviewed" && !task.provenance?.reviewedAt) {
      warnings.push(`${task.id}: artifact has no persisted review proof`);
    }
    if (task.approvalKind === "reviewed" && !task.integratedCommit) {
      warnings.push(`${task.id}: reviewed approval is missing its integration commit`);
    }
    if (
      task.verificationProfile &&
      task.approvalKind === "reviewed" &&
      !task.provenance?.verifiedAt
    ) {
      warnings.push(`${task.id}: reviewed artifact is missing trusted verification proof`);
    }
    const attempt = task.attempts.at(-1);
    if (
      attempt?.worktreePath &&
      !worktreeRecoveryExists(ctx.cwd, {
        worktreePath: attempt.worktreePath,
        branch: attempt.branch ?? "",
      })
    ) {
      warnings.push(`${task.id}: recorded recovery worktree is missing`);
    }
  }

  notify(
    ctx,
    warnings.length > 0
      ? `Reconciliation warnings:\n- ${warnings.join("\n- ")}`
      : "Board artifacts are consistent."
  );
}

export function handleTimelineCommand(ctx: ExtensionCommandContext, restParts: string[]): void {
  const [first, archiveName, archivedTaskId] = restParts;
  const archived = first?.toLowerCase() === "archive";
  let board: Board;
  let taskId: string | undefined;
  try {
    board = archived ? loadArchivedBoard(ctx.cwd, archiveName ?? "") : loadBoard(ctx.cwd);
    taskId = archived ? archivedTaskId : first;
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
    return;
  }
  if (taskId && !findTask(board, taskId)) {
    notify(ctx, `Unknown task: ${taskId}`, "warning");
    return;
  }
  notify(ctx, formatRunTimeline(deriveRunTimeline(board, taskId)));
}
