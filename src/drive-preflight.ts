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
import { notify } from "./handoff.js";
import { formatWorkflowPreflight, preflightWorkflow } from "./preflight.js";
import { assertKnownTaskIds } from "./session-control.js";

export function validateDriveStart(ctx: ExtensionContext, taskIds: string[] | undefined): void {
  const board = loadBoard(ctx.cwd);
  const config = loadConfig(ctx.cwd);
  const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
  if (validationError) throw new Error(validationError);
  assertKnownTaskIds(board, taskIds);
  if (board.planPending) throw new Error("Plan approval is pending.");
  const preflight = preflightWorkflow(board, config, taskIds);
  if (preflight.requiresConfirmation && board.scaleApproval?.signature !== preflight.signature) {
    throw new Error(
      `Workflow scale confirmation is required (${preflight.signature}); use the human /${COMMAND} drive command to inspect and confirm preflight.`
    );
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
  const preflight = preflightWorkflow(board, config, taskIds);
  if (!preflight.requiresConfirmation || board.scaleApproval?.signature === preflight.signature) {
    return true;
  }
  notify(ctx, formatWorkflowPreflight(preflight), "warning");
  if (!ctx.hasUI) return false;
  const confirmed = await ctx.ui.confirm(
    "Confirm workflow scale?",
    `${preflight.taskCount} tasks and up to ${preflight.totalLaunchUpperBound} raw launches (${preflight.signature}).`
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
