import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadBoard, replaceBoardWithArchive } from "./board.js";
import { pickFromList } from "./command-ui.js";
import { loadConfig } from "./config.js";
import { COMMAND } from "./constants.js";
import { notify } from "./handoff.js";
import { comparePlans, formatPlanComparison } from "./plan-serialization.js";
import {
  expandRecipe,
  loadRecipeListings,
  parseRecipeInput,
  removeRecipe,
  saveRecipeFromBoard,
} from "./recipes.js";
import { showScrollableMarkdown, showScrollableText } from "./scrollable-viewer.js";

export interface WorkflowBrowserActions {
  hasLiveRuns(): boolean;
  onBoardChanged(): void;
  reviewPlan(ctx: ExtensionCommandContext): Promise<void>;
}

function workflowMarkdown(listing: ReturnType<typeof loadRecipeListings>[number]): string {
  if (listing.error || !listing.recipe) {
    return `# ${listing.name}\n\n**Invalid workflow**\n\n${listing.error ?? "Recipe could not be loaded."}\n\n\`${listing.file}\``;
  }
  const recipe = listing.recipe;
  const tasks = recipe.tasks
    .map(
      (task, index) =>
        `## ${index + 1}. ${task.title}\n\n**Tier:** ${task.tier}  \n**Dependencies:** ${task.dependsOn?.join(", ") || "None"}  \n**Writes:** ${task.writePaths?.map((path) => `\`${path}\``).join(", ") || "None"}\n\n${task.brief}`
    )
    .join("\n\n");
  return [
    `# ${recipe.name}`,
    recipe.description ?? "Reusable Maestro workflow",
    "",
    `**Scope:** ${listing.scope}  `,
    `**File:** \`${listing.file}\`  `,
    `**Inputs:** ${Object.keys(recipe.inputs ?? {}).join(", ") || "None"}`,
    "",
    tasks,
  ].join("\n");
}

export async function showWorkflowBrowser(
  ctx: ExtensionCommandContext,
  actions: WorkflowBrowserActions
): Promise<void> {
  while (true) {
    const listings = loadRecipeListings(ctx.cwd);
    const board = loadBoard(ctx.cwd);
    const items = [
      ...(board.tasks.length > 0
        ? [
            {
              value: "save",
              label: "Save board as workflow",
              description: `${board.tasks.length} task(s)`,
            },
          ]
        : []),
      ...listings.map((listing) => ({
        value: `workflow:${listing.name}`,
        label: listing.name,
        description: listing.error
          ? `INVALID · ${listing.error}`
          : `${listing.scope} · ${listing.recipe?.description ?? `${listing.recipe?.tasks.length ?? 0} task(s)`}`,
      })),
    ];
    if (items.length === 0) {
      notify(
        ctx,
        `No workflows yet. Build a plan, then save it from /${COMMAND} workflows.`,
        "warning"
      );
      return;
    }

    const choice = await pickFromList(ctx, "Maestro workflows", items);
    if (!choice) return;
    if (choice === "save") {
      const name = await ctx.ui.input("Workflow name", "for example: implement-feature");
      if (!name?.trim()) continue;
      const scope = await pickFromList(ctx, "Save workflow", [
        {
          value: "project",
          label: "This project",
          description: "Share the workflow with this repository",
        },
        {
          value: "user",
          label: "All my projects",
          description: "Keep the workflow in your user-level Maestro library",
        },
      ]);
      if (scope !== "project" && scope !== "user") continue;
      try {
        const file = saveRecipeFromBoard(scope, ctx.cwd, name.trim(), loadBoard(ctx.cwd));
        notify(ctx, `Saved ${scope} workflow “${name.trim()}” to ${file}.`);
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      continue;
    }

    const name = choice.slice("workflow:".length);
    const listing = listings.find((candidate) => candidate.name === name);
    if (!listing) continue;
    const action = await pickFromList(ctx, `Workflow · ${name}`, [
      {
        value: "inspect",
        label: "View workflow",
        description: "Rendered tasks, inputs, and scope",
      },
      {
        value: "preview",
        label: "Preview on current board",
        description: "Expand inputs without changing anything",
      },
      {
        value: "run",
        label: "Create plan from workflow",
        description: "Expansion remains gated for approval",
      },
      {
        value: "remove",
        label: "Remove workflow",
        description: `Delete the ${listing.scope} definition after confirmation`,
      },
    ]);
    if (!action) continue;
    if (action === "inspect") {
      await showScrollableMarkdown(ctx, `Workflow · ${name}`, workflowMarkdown(listing));
      continue;
    }
    if (listing.error || !listing.recipe) {
      notify(ctx, listing.error ?? "Workflow is invalid.", "error");
      continue;
    }
    if (action === "remove") {
      const confirmed = await ctx.ui.confirm(
        "Remove workflow?",
        `Permanently remove ${listing.scope} workflow “${name}”?`
      );
      if (confirmed && removeRecipe(listing.scope, ctx.cwd, name)) {
        notify(ctx, `Removed workflow “${name}”.`);
      }
      continue;
    }

    const rawInput = await ctx.ui.input(
      action === "run" ? "Run workflow" : "Preview workflow",
      Object.keys(listing.recipe.inputs ?? {}).length > 0
        ? `JSON values for: ${Object.keys(listing.recipe.inputs ?? {}).join(", ")}`
        : "Optional JSON input; leave empty for none"
    );
    if (rawInput === undefined) continue;
    try {
      const config = loadConfig(ctx.cwd);
      const expanded = expandRecipe(
        listing.recipe,
        parseRecipeInput(rawInput.trim() || undefined),
        Object.keys(config.tiers),
        Object.keys(config.verificationProfiles ?? {}),
        config.maxPlanTasks
      );
      if (action === "preview") {
        await showScrollableText(
          ctx,
          `Workflow preview · ${name}`,
          formatPlanComparison(
            comparePlans(board, expanded, config),
            `/${COMMAND} workflows`
          ).split("\n")
        );
        continue;
      }
      if (actions.hasLiveRuns()) {
        notify(ctx, "Executors are still running. Workflow run cancelled.", "warning");
        continue;
      }
      if (board.tasks.length > 0) {
        const confirmed = await ctx.ui.confirm(
          "Create plan from workflow?",
          `Archive ${board.tasks.length} current task(s), then create “${name}”?`
        );
        if (!confirmed) continue;
      }
      replaceBoardWithArchive(ctx.cwd, () => structuredClone(expanded), board.revision ?? 0);
      actions.onBoardChanged();
      notify(ctx, `Created ${expanded.tasks.length} task(s) from “${name}”. Review the plan next.`);
      await actions.reviewPlan(ctx);
      return;
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
  }
}
