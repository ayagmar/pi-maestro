import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  applyPlanTaskEdits,
  assertTaskNotDispatched,
  findTask,
  loadBoard,
  normalizeExistingTaskContract,
  planValidationMessage,
  updateTask,
  validatePlan,
} from "./board.js";
import { editText, pickFromList } from "./command-ui.js";
import { loadConfig } from "./config.js";
import { truncateText } from "./format.js";
import { notify } from "./handoff.js";
import { showScrollableText } from "./scrollable-viewer.js";

function taskPlanValidationError(
  board: ReturnType<typeof loadBoard>,
  taskId: string,
  tiers: string[]
): string | undefined {
  const validation = validatePlan(board, tiers);
  return planValidationMessage({
    missingDependencies: validation.missingDependencies.filter(
      (missing) => missing.taskId === taskId
    ),
    dependencyCycles: validation.dependencyCycles.filter((cycle) => cycle.includes(taskId)),
    invalidTiers: validation.invalidTiers.filter((invalid) => invalid.taskId === taskId),
    ...(validation.writePathOverlaps
      ? {
          writePathOverlaps: validation.writePathOverlaps.filter(
            (overlap) => overlap.leftTaskId === taskId || overlap.rightTaskId === taskId
          ),
        }
      : {}),
    ...(validation.contractErrors
      ? { contractErrors: validation.contractErrors.filter((error) => error.taskId === taskId) }
      : {}),
  });
}

export async function showPlanTaskEditor(
  ctx: ExtensionCommandContext,
  taskId: string,
  onSaved: () => void
): Promise<void> {
  const task = findTask(loadBoard(ctx.cwd), taskId);
  if (!task) return;
  try {
    assertTaskNotDispatched(task);
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "warning");
    return;
  }
  const draft = structuredClone(task);
  const tiers = Object.keys(loadConfig(ctx.cwd).tiers);

  while (true) {
    const action = await pickFromList(ctx, `${draft.id} · edit planned task`, [
      { value: "viewBrief", label: "View brief (read-only)" },
      { value: "title", label: `Title · ${draft.title}` },
      { value: "brief", label: `Edit brief · ${truncateText(draft.brief, 3)}` },
      { value: "tier", label: `Tier · ${draft.tier}` },
      {
        value: "dependencies",
        label: `Dependencies · ${draft.dependsOn.join(", ") || "none"}`,
        description: "Comma- or space-separated task ids",
      },
      {
        value: "criteria",
        label: `Success criteria · ${draft.successCriteria?.length ?? 0}`,
        description: (draft.successCriteria ?? []).join(" · "),
      },
      {
        value: "writePaths",
        label: `Write scope · ${draft.writePaths?.length ?? 0} path(s)`,
        description: (draft.writePaths ?? []).join(" · "),
      },
      { value: "commitMessage", label: `Commit message · ${draft.commitMessage ?? "auto"}` },
      { value: "verification", label: `Verification · ${draft.verificationProfile ?? "none"}` },
      { value: "reviewPolicy", label: `Review policy · ${draft.reviewPolicy ?? "single"}` },
      {
        value: "cancellation",
        label: `Cancellation · ${draft.status === "cancelled" ? "cancelled" : "active"}`,
      },
      { value: "save", label: "Save changes", description: "Validate and update the board" },
      { value: "cancel", label: "Cancel editing", description: "Discard all draft changes" },
    ]);
    if (!action || action === "cancel") return;

    if (action === "viewBrief") {
      await showScrollableText(ctx, `${draft.id} · brief`, draft.brief.split("\n"));
      continue;
    }
    if (action === "title") {
      const value = await editText(ctx, "Task title", draft.title, false);
      if (value !== null) {
        try {
          applyPlanTaskEdits(draft, { title: value }, tiers);
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
      }
      continue;
    }
    if (action === "brief") {
      const value = await editText(ctx, "Task brief", draft.brief, true);
      if (value !== null) {
        try {
          applyPlanTaskEdits(draft, { brief: value }, tiers);
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
      }
      continue;
    }
    if (action === "writePaths") {
      const value = await editText(
        ctx,
        "Write scope (one path per line)",
        (draft.writePaths ?? []).join("\n"),
        true
      );
      if (value !== null) {
        applyPlanTaskEdits(
          draft,
          {
            writePaths: value
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean),
          },
          tiers
        );
      }
      continue;
    }
    if (action === "commitMessage") {
      const value = await editText(ctx, "Commit message", draft.commitMessage ?? "", false);
      if (value !== null) applyPlanTaskEdits(draft, { commitMessage: value }, tiers);
      continue;
    }
    if (action === "tier") {
      const tier = await pickFromList(
        ctx,
        "Task tier",
        tiers.map((name) => ({ value: name, label: name }))
      );
      if (tier) applyPlanTaskEdits(draft, { tier }, tiers);
      continue;
    }
    if (action === "dependencies") {
      const value = await editText(ctx, "Dependencies", draft.dependsOn.join(", "), false);
      if (value !== null) {
        applyPlanTaskEdits(draft, { dependsOn: value.split(/[\s,]+/) }, tiers);
      }
      continue;
    }
    if (action === "criteria") {
      const value = await editText(
        ctx,
        "Success criteria (one per line)",
        (draft.successCriteria ?? []).join("\n"),
        true
      );
      if (value !== null) {
        try {
          applyPlanTaskEdits(
            draft,
            {
              successCriteria: value
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean),
            },
            tiers
          );
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
      }
      continue;
    }
    if (action === "verification") {
      const config = loadConfig(ctx.cwd);
      const profile = await pickFromList(ctx, "Verification profile", [
        { value: "", label: "None" },
        ...Object.keys(config.verificationProfiles ?? {}).map((name) => ({
          value: name,
          label: name,
        })),
      ]);
      if (profile !== undefined && profile !== null) {
        applyPlanTaskEdits(draft, { verificationProfile: profile }, tiers);
      }
      continue;
    }
    if (action === "reviewPolicy") {
      const reviewPolicy = await pickFromList(ctx, "Review policy", [
        { value: "single", label: "Single reviewer" },
        { value: "confirm", label: "Independent confirmations" },
        { value: "find-and-refute", label: "Find and refute" },
      ]);
      if (reviewPolicy) {
        applyPlanTaskEdits(
          draft,
          { reviewPolicy: reviewPolicy as "single" | "confirm" | "find-and-refute" },
          tiers
        );
      }
      continue;
    }
    if (action === "cancellation") {
      const state = await pickFromList(ctx, "Cancellation state", [
        { value: "active", label: "Active" },
        { value: "cancelled", label: "Cancelled" },
      ]);
      if (state) applyPlanTaskEdits(draft, { cancelled: state === "cancelled" }, tiers);
      continue;
    }

    const candidate = structuredClone(loadBoard(ctx.cwd));
    const candidateTask = findTask(candidate, draft.id);
    if (!candidateTask) return;
    applyPlanTaskEdits(
      candidateTask,
      {
        title: draft.title,
        brief: draft.brief,
        tier: draft.tier,
        dependsOn: draft.dependsOn,
        ...(draft.writePaths !== undefined ? { writePaths: draft.writePaths } : {}),
        commitMessage: draft.commitMessage ?? "",
        ...(draft.successCriteria ? { successCriteria: draft.successCriteria } : {}),
        verificationProfile: draft.verificationProfile ?? "",
        reviewPolicy: draft.reviewPolicy ?? "single",
        cancelled: draft.status === "cancelled",
      },
      tiers
    );
    if (candidateTask.writePaths !== undefined) {
      const contract = normalizeExistingTaskContract(candidateTask);
      candidateTask.writePaths = contract.writePaths;
      if (contract.successCriteria) candidateTask.successCriteria = contract.successCriteria;
      else delete candidateTask.successCriteria;
    }
    const validationError = taskPlanValidationError(candidate, draft.id, tiers);
    if (validationError) {
      notify(ctx, `${validationError}\nChanges were not saved.`, "error");
      continue;
    }
    try {
      updateTask(ctx.cwd, draft.id, (fresh, board) => {
        assertTaskNotDispatched(fresh);
        applyPlanTaskEdits(
          fresh,
          {
            title: draft.title,
            brief: draft.brief,
            tier: draft.tier,
            dependsOn: draft.dependsOn,
            ...(draft.writePaths !== undefined ? { writePaths: draft.writePaths } : {}),
            commitMessage: draft.commitMessage ?? "",
            ...(draft.successCriteria ? { successCriteria: draft.successCriteria } : {}),
            verificationProfile: draft.verificationProfile ?? "",
            reviewPolicy: draft.reviewPolicy ?? "single",
            cancelled: draft.status === "cancelled",
          },
          tiers
        );
        if (fresh.writePaths !== undefined) {
          const freshContract = normalizeExistingTaskContract(fresh);
          fresh.writePaths = freshContract.writePaths;
          if (freshContract.successCriteria) fresh.successCriteria = freshContract.successCriteria;
          else delete fresh.successCriteria;
        }
        const freshValidationError = taskPlanValidationError(board, fresh.id, tiers);
        if (freshValidationError) throw new Error(freshValidationError);
      });
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "warning");
      return;
    }
    onSaved();
    notify(ctx, `${draft.id} plan changes saved.`);
    return;
  }
}
