import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findTask, loadBoard, replaceBoardWithArchive, updateBoard } from "./board.js";
import { loadConfig } from "./config.js";
import { COMMAND } from "./constants.js";
import {
  buildDiscoveryBoard,
  completedDiscoveryReport,
  formatDiscoveryPreview,
  parseDiscoveryOutput,
} from "./discovery.js";
import { truncateText } from "./format.js";
import { notify } from "./handoff.js";
import { comparePlans, formatPlanComparison } from "./plan-serialization.js";
import {
  expandRecipe,
  loadRecipeListings,
  parseRecipeInput,
  removeRecipe,
  resolveRecipe,
  saveRecipeFromBoard,
} from "./recipes.js";

export interface RecipeCommandRuntime {
  hasLiveRuns(): boolean;
  isTaskLive(taskId: string): boolean;
  onBoardChanged(): void;
}

export async function handleRecipeCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  runtime: RecipeCommandRuntime
): Promise<void> {
  const match = rest.match(/^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/);
  const action = match?.[1]?.toLowerCase() ?? "list";
  const name = match?.[2];
  const trailing = match?.[3];

  try {
    if (action === "list") {
      const recipes = loadRecipeListings(ctx.cwd);
      notify(
        ctx,
        recipes.length === 0
          ? "No workflow recipes found."
          : recipes
              .map((entry) =>
                entry.error
                  ? `${entry.name} [${entry.scope}] — INVALID ${entry.file}: ${truncateText(entry.error, 300)}`
                  : `${entry.name} [${entry.scope}] — ${entry.recipe?.description ?? `${entry.recipe?.tasks.length ?? 0} task(s)`}`
              )
              .join("\n")
      );
      return;
    }

    if (action === "inspect") {
      if (!name) {
        notify(ctx, `Usage: /${COMMAND} recipe inspect <name>`, "warning");
        return;
      }
      const resolved = resolveRecipe(ctx.cwd, name);
      notify(
        ctx,
        `[${resolved.scope}] ${resolved.file}\n${JSON.stringify(resolved.recipe, null, 2)}`
      );
      return;
    }

    if (action === "preview") {
      if (!name) {
        notify(ctx, `Usage: /${COMMAND} recipe preview <name> [JSON input]`, "warning");
        return;
      }
      const resolved = resolveRecipe(ctx.cwd, name);
      const config = loadConfig(ctx.cwd);
      const expanded = expandRecipe(
        resolved.recipe,
        parseRecipeInput(trailing),
        Object.keys(config.tiers),
        Object.keys(config.verificationProfiles ?? {}),
        config.maxPlanTasks
      );
      notify(
        ctx,
        formatPlanComparison(
          comparePlans(loadBoard(ctx.cwd), expanded, config),
          `/${COMMAND} recipe preview ${name}`,
          undefined,
          4_000,
          `/${COMMAND} recipe inspect ${name}`
        )
      );
      return;
    }

    if (action === "save") {
      if (!name) {
        notify(ctx, `Usage: /${COMMAND} recipe save <name> [user|project]`, "warning");
        return;
      }
      const scope = trailing?.toLowerCase() ?? "user";
      if (scope !== "user" && scope !== "project") {
        notify(ctx, "Recipe scope must be user or project.", "warning");
        return;
      }
      const file = saveRecipeFromBoard(scope, ctx.cwd, name, loadBoard(ctx.cwd));
      notify(ctx, `Saved ${scope} recipe "${name}" to ${file}.`);
      return;
    }

    if (action === "run") {
      if (!name) {
        notify(ctx, `Usage: /${COMMAND} recipe run <name> [JSON input]`, "warning");
        return;
      }
      if (runtime.hasLiveRuns()) {
        notify(ctx, "Executors are still running. Recipe run cancelled.", "warning");
        return;
      }
      const resolved = resolveRecipe(ctx.cwd, name);
      const config = loadConfig(ctx.cwd);
      const expanded = expandRecipe(
        resolved.recipe,
        parseRecipeInput(trailing),
        Object.keys(config.tiers),
        Object.keys(config.verificationProfiles ?? {}),
        config.maxPlanTasks
      );
      const current = loadBoard(ctx.cwd);
      if (current.tasks.length > 0) {
        const confirmed =
          ctx.hasUI &&
          (await ctx.ui.confirm(
            "Run workflow recipe?",
            `Archive ${current.tasks.length} current task(s), then run "${name}"?`
          ));
        if (!confirmed) {
          notify(ctx, "Recipe run cancelled; current board was not changed.", "warning");
          return;
        }
      }
      const archive = replaceBoardWithArchive(
        ctx.cwd,
        () => structuredClone(expanded),
        current.revision ?? 0
      );
      runtime.onBoardChanged();
      notify(
        ctx,
        `Expanded recipe "${name}" into ${expanded.tasks.length} task(s); plan approval is required.${archive ? ` Previous board archived at ${archive}.` : ""}`
      );
      return;
    }

    if (action === "remove") {
      if (!name) {
        notify(ctx, `Usage: /${COMMAND} recipe remove <name> [user|project]`, "warning");
        return;
      }
      const requestedScope = trailing?.toLowerCase();
      if (
        requestedScope !== undefined &&
        requestedScope !== "user" &&
        requestedScope !== "project"
      ) {
        notify(ctx, "Recipe scope must be user or project.", "warning");
        return;
      }
      const scope =
        requestedScope ?? loadRecipeListings(ctx.cwd).find((entry) => entry.name === name)?.scope;
      if (!scope) {
        notify(ctx, `${name} was not found.`, "warning");
        return;
      }
      const confirmed =
        ctx.hasUI &&
        (await ctx.ui.confirm(
          "Remove workflow recipe?",
          `Permanently remove ${scope} recipe "${name}"?`
        ));
      if (!confirmed) {
        notify(ctx, "Recipe removal cancelled.", "warning");
        return;
      }
      if (!removeRecipe(scope, ctx.cwd, name)) {
        notify(ctx, `${scope} recipe "${name}" was not found.`, "warning");
        return;
      }
      notify(ctx, `Removed ${scope} recipe "${name}".`);
      return;
    }

    notify(ctx, `Unknown recipe action: ${action}`, "warning");
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

export async function handleDiscoveryCommand(
  ctx: ExtensionCommandContext,
  restParts: string[],
  runtime: RecipeCommandRuntime
): Promise<void> {
  const [taskId, requestedMode, ...extra] = restParts;
  const mode = requestedMode ?? "append";
  if (!taskId || extra.length > 0 || (mode !== "append" && mode !== "replace")) {
    notify(ctx, `Usage: /${COMMAND} discover <taskId> [append|replace]`, "warning");
    return;
  }

  try {
    const previewBoard = loadBoard(ctx.cwd);
    const previewRevision = previewBoard.revision ?? 0;
    const discoveryTask = findTask(previewBoard, taskId);
    if (runtime.isTaskLive(discoveryTask?.id ?? taskId)) {
      throw new Error(`${taskId} discovery output is still live; wait for completion.`);
    }
    const report = completedDiscoveryReport(discoveryTask);
    const config = loadConfig(ctx.cwd);
    const output = parseDiscoveryOutput(report, config.maxDiscoveryGeneratedTasks);
    buildDiscoveryBoard(previewBoard, taskId, report, mode, config);
    notify(ctx, formatDiscoveryPreview(output, mode));

    const confirmed =
      ctx.hasUI &&
      (await ctx.ui.confirm(
        "Apply discovery tasks?",
        `${mode === "replace" ? "Replace the current board with" : "Append"} ${output.items.length} generated task(s)?`
      ));
    if (!confirmed) {
      notify(ctx, "Discovery tasks were not approved; the board was not changed.", "warning");
      return;
    }

    let archive: string | undefined;
    if (mode === "append") {
      updateBoard(ctx.cwd, (board) => {
        if ((board.revision ?? 0) !== previewRevision) {
          throw new Error("The board changed after preview; inspect and approve discovery again.");
        }
        const freshReport = completedDiscoveryReport(findTask(board, taskId));
        if (freshReport !== report) {
          throw new Error("Discovery result changed after preview; inspect and approve it again.");
        }
        const candidate = buildDiscoveryBoard(board, taskId, report, mode, loadConfig(ctx.cwd));
        board.nextTaskNumber = candidate.nextTaskNumber;
        board.tasks = candidate.tasks;
        board.planPending = true;
        return true;
      });
    } else {
      archive = replaceBoardWithArchive(
        ctx.cwd,
        (board) => {
          if ((board.revision ?? 0) !== previewRevision) {
            throw new Error(
              "The board changed after preview; inspect and approve discovery again."
            );
          }
          const freshReport = completedDiscoveryReport(findTask(board, taskId));
          if (freshReport !== report) {
            throw new Error(
              "Discovery result changed after preview; inspect and approve it again."
            );
          }
          return buildDiscoveryBoard(board, taskId, report, mode, loadConfig(ctx.cwd));
        },
        previewRevision
      );
    }
    runtime.onBoardChanged();
    notify(
      ctx,
      `Approved ${output.items.length} discovery task(s); plan approval is required.${archive ? ` Previous board archived at ${archive}.` : ""}`
    );
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}
