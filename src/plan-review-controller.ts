import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  approvePlan,
  loadBoard,
  planValidationMessage,
  rejectPlan,
  updateBoard,
  validatePlan,
} from "./board.js";
import { pickFromList } from "./command-ui.js";
import { loadConfig } from "./config.js";
import { preflightWorkflowWithCost } from "./cost-forecast.js";
import { truncateText } from "./format.js";
import { notify } from "./handoff.js";
import { formatPlanReviewMarkdown } from "./plan-review.js";
import { showPlanTaskEditor } from "./plan-task-editor.js";
import { formatWorkflowPreflight, preflightWorkflow } from "./preflight.js";
import { showScrollableMarkdown } from "./scrollable-viewer.js";

export interface PlanReviewActions {
  hasLiveRuns(): boolean;
  onChanged(): void;
  onApproved(): void;
}

export async function showPlanReview(
  ctx: ExtensionCommandContext,
  actions: PlanReviewActions
): Promise<void> {
  if (actions.hasLiveRuns()) {
    notify(
      ctx,
      "Executors are still running. Finish or abort them before reviewing a plan.",
      "warning"
    );
    return;
  }

  while (true) {
    const board = loadBoard(ctx.cwd);
    if (board.tasks.length === 0) {
      notify(ctx, "Board is empty. Plan tasks with maestro_plan.", "warning");
      return;
    }
    if (!board.planPending) {
      notify(ctx, "No plan is awaiting approval.");
      return;
    }

    const editable = board.tasks.filter(
      (task) => task.status === "todo" || task.status === "cancelled"
    );
    const items = [
      {
        value: "overview",
        label: "Review plan …",
        description: "Read-only overview of every task",
      },
      ...editable.map((task) => ({
        value: `task:${task.id}`,
        label: `${task.id} ${task.title} [${task.tier}]${task.status === "cancelled" ? " · CANCELLED" : ""}`,
        description: `deps: ${task.dependsOn.join(", ") || "none"} · ${task.successCriteria?.length ?? 0} criteria · writes: ${task.writePaths?.join(", ") || "none"} · ${truncateText(task.brief, 1)}`,
      })),
      {
        value: "approve",
        label: "Approve plan",
        description: "Validate the complete plan, then allow execution",
      },
      {
        value: "reject",
        label: "Reject plan",
        description: "Archive and clear this board",
      },
    ];

    const choice = await pickFromList(ctx, "Maestro Plan · awaiting approval", items);
    if (!choice) return;
    if (choice === "overview") {
      const config = loadConfig(ctx.cwd);
      await showScrollableMarkdown(
        ctx,
        "Maestro Plan · review",
        formatPlanReviewMarkdown(
          board,
          config,
          preflightWorkflowWithCost(ctx.cwd, board, config, ctx)
        )
      );
      continue;
    }
    if (choice.startsWith("task:")) {
      await showPlanTaskEditor(ctx, choice.slice("task:".length), actions.onChanged);
      continue;
    }
    if (choice === "approve") {
      const fresh = loadBoard(ctx.cwd);
      const config = loadConfig(ctx.cwd);
      const validationError = planValidationMessage(validatePlan(fresh, Object.keys(config.tiers)));
      if (validationError) {
        notify(ctx, `${validationError}\nEdit the listed tasks before approving.`, "error");
        continue;
      }
      const preflight = preflightWorkflowWithCost(ctx.cwd, fresh, config, ctx);
      notify(
        ctx,
        formatWorkflowPreflight(preflight),
        preflight.requiresConfirmation ? "warning" : "info"
      );
      if (preflight.requiresConfirmation) {
        const confirmed =
          ctx.hasUI &&
          (await ctx.ui.confirm(
            "Confirm workflow scale?",
            `${preflight.taskCount} tasks, up to ${preflight.totalLaunchUpperBound} raw launches, and an estimated projected cost of $${preflight.projectedCost.estimatedUsd.toFixed(2)} (${preflight.signature}).`
          ));
        if (!confirmed) {
          notify(ctx, "Plan remains gated; workflow scale was not confirmed.", "warning");
          continue;
        }
      }
      try {
        updateBoard(ctx.cwd, (current) => {
          const currentConfig = loadConfig(ctx.cwd);
          const currentValidationError = planValidationMessage(
            validatePlan(current, Object.keys(currentConfig.tiers))
          );
          if (currentValidationError) throw new Error(currentValidationError);
          const currentPreflight = preflightWorkflow(current, currentConfig);
          if (
            preflight.requiresConfirmation &&
            currentPreflight.signature !== preflight.signature
          ) {
            throw new Error("Workflow changed after preflight confirmation.");
          }
          if (!preflight.requiresConfirmation && currentPreflight.requiresConfirmation) {
            throw new Error("Workflow now requires explicit scale confirmation.");
          }
          if (currentPreflight.requiresConfirmation) {
            current.scaleApproval = {
              signature: currentPreflight.signature,
              confirmedAt: Date.now(),
            };
          }
          approvePlan(current, Object.keys(currentConfig.tiers));
        });
      } catch (error) {
        notify(
          ctx,
          `${error instanceof Error ? error.message : String(error)} Inspect and confirm the plan again; it remains gated.`,
          "warning"
        );
        return;
      }
      actions.onApproved();
      notify(ctx, "Plan approved. Executors may now be started with maestro_drive.");
      return;
    }

    if (!ctx.hasUI) {
      notify(ctx, "Plan rejection requires the interactive UI.", "warning");
      continue;
    }
    const confirmed = await ctx.ui.confirm(
      "Reject plan?",
      `Archive and clear all ${board.tasks.length} task(s)?`
    );
    if (!confirmed) continue;
    let archivePath: string | undefined;
    try {
      archivePath = rejectPlan(ctx.cwd, board.revision ?? 0);
    } catch (error) {
      notify(
        ctx,
        `${error instanceof Error ? error.message : String(error)}. Inspect and confirm the plan rejection again.`,
        "warning"
      );
      return;
    }
    if (!archivePath) {
      notify(ctx, "Could not archive the board; rejection cancelled.", "error");
      return;
    }
    actions.onChanged();
    notify(ctx, `Plan rejected. Board archived at ${archivePath}`);
    return;
  }
}
