import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  loadBoard,
  planValidationMessage,
  scopedDependencyGapsWithConfig,
  updateBoard,
  validatePlan,
} from "./board.js";
import { loadConfig } from "./config.js";
import { COMMAND } from "./constants.js";
import { preflightWorkflowWithCost } from "./cost-forecast.js";
import { notify } from "./handoff.js";
import { formatWorkflowPreflight, preflightWorkflow } from "./preflight.js";
import { assertKnownTaskIds } from "./session-control.js";

/** Thrown when only the human-only scale confirmation stands between the board and a drive. */
export class ScaleConfirmationRequiredError extends Error {
  constructor(readonly signature: string) {
    super(
      `Workflow scale confirmation is required (${signature}); use the human /${COMMAND} drive command to inspect and confirm preflight.`
    );
    this.name = "ScaleConfirmationRequiredError";
  }
}

/**
 * Record on the open decision that the board is corrected and a human must
 * now confirm the preflight, so reminders stop and the status line says so.
 */
export function markDecisionAwaitingHuman(cwd: string, signature: string): void {
  updateBoard(cwd, (board) => {
    const decision = board.activeDecision;
    if (!decision || decision.resolution) return false;
    if (decision.awaitingHuman?.signature === signature) return false;
    decision.awaitingHuman = { kind: "scale_confirmation", since: Date.now(), signature };
    return true;
  });
}

export function validateDriveStart(ctx: ExtensionContext, taskIds: string[] | undefined): void {
  const board = loadBoard(ctx.cwd);
  const config = loadConfig(ctx.cwd);
  const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
  if (validationError) throw new Error(validationError);
  assertKnownTaskIds(board, taskIds);
  if (board.planPending) throw new Error("Plan approval is pending.");
  const preflight = preflightWorkflow(board, config, taskIds);
  if (preflight.requiresConfirmation && board.scaleApproval?.signature !== preflight.signature) {
    throw new ScaleConfirmationRequiredError(preflight.signature);
  }
  if (!taskIds) return;

  const gaps = scopedDependencyGapsWithConfig(board, taskIds, config);
  if (gaps.length > 0) {
    throw new Error(
      `Scoped drive omits unresolved dependencies: ${gaps
        .map((gap) => `${gap.taskId} requires ${gap.dependencyId}`)
        .join(", ")}`
    );
  }
}

export async function confirmDriveScale(
  ctx: ExtensionContext,
  taskIds: string[] | undefined
): Promise<boolean> {
  const board = loadBoard(ctx.cwd);
  const config = loadConfig(ctx.cwd);
  const preflight = preflightWorkflowWithCost(ctx.cwd, board, config, ctx, taskIds);
  if (!preflight.requiresConfirmation || board.scaleApproval?.signature === preflight.signature) {
    return true;
  }
  notify(ctx, formatWorkflowPreflight(preflight), "warning");
  if (!ctx.hasUI) return false;
  const confirmed = await ctx.ui.confirm(
    "Confirm workflow scale?",
    `${preflight.taskCount} tasks, up to ${preflight.totalLaunchUpperBound} raw launches, and an estimated projected cost of $${preflight.projectedCost.estimatedUsd.toFixed(2)} (${preflight.signature}).`
  );
  if (!confirmed) return false;
  updateBoard(ctx.cwd, (fresh) => {
    const current = preflightWorkflow(fresh, loadConfig(ctx.cwd), taskIds);
    if (current.signature !== preflight.signature) {
      throw new Error("Workflow changed after preflight; inspect and confirm it again.");
    }
    fresh.scaleApproval = { signature: current.signature, confirmedAt: Date.now() };
  });
  return true;
}
