import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completionFreshness } from "./artifact-policy.js";
import {
  findTask,
  loadArchivedBoard,
  loadBoard,
  planValidationMessage,
  validatePlan,
} from "./board.js";
import { describeConfig, loadConfig } from "./config.js";
import { formatCostSummary } from "./format.js";
import { notify } from "./handoff.js";
import { assertKnownTaskIds } from "./session-control.js";
import { showSettings } from "./settings-ui.js";
import { deriveRunTimeline, formatRunTimeline } from "./timeline.js";
import type { Board } from "./types.js";
import { simulatePlan } from "./workflow.js";
import { worktreeExists } from "./worktree.js";

export async function handleConfigCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  onChanged: () => void
): Promise<void> {
  if (ctx.mode !== "tui" || rest === "show") {
    notify(ctx, describeConfig(loadConfig(ctx.cwd)));
    return;
  }
  const scope = rest === "project" ? "project" : "user";
  await showSettings(ctx, scope);
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
      !worktreeExists({ worktreePath: attempt.worktreePath, branch: attempt.branch ?? "" })
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
