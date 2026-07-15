import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadBoard, replaceBoard, replaceBoardWithArchive } from "./board.js";
import { loadConfig } from "./config.js";
import { COMMAND } from "./constants.js";
import { notify } from "./handoff.js";
import {
  comparePlans,
  exportPlan,
  formatPlanComparison,
  importPlan,
} from "./plan-serialization.js";
import type { Board } from "./types.js";

export interface PlanCommandRuntime {
  hasLiveRuns(): boolean;
  onBoardChanged(): void;
  reviewPlan(ctx: ExtensionCommandContext): Promise<void>;
}

export async function handlePlanCommand(
  ctx: ExtensionCommandContext,
  restParts: string[],
  runtime: PlanCommandRuntime
): Promise<void> {
  const [planAction, planPath, planTaskId] = restParts;
  if (planAction === "export") {
    if (!planPath) {
      notify(ctx, `Usage: /${COMMAND} plan export <file>`, "warning");
      return;
    }
    const file = resolve(ctx.cwd, planPath);
    if (existsSync(file)) {
      notify(ctx, `Refusing to overwrite existing file: ${file}`, "error");
      return;
    }
    writeFileSync(file, exportPlan(loadBoard(ctx.cwd)), { flag: "wx" });
    notify(ctx, `Plan exported to ${file}`);
    return;
  }

  if (planAction === "import") {
    if (!planPath) {
      notify(ctx, `Usage: /${COMMAND} plan import <file>`, "warning");
      return;
    }
    if (runtime.hasLiveRuns()) {
      notify(ctx, "Executors are still running. Import cancelled.", "warning");
      return;
    }
    const config = loadConfig(ctx.cwd);
    let imported: Board;
    try {
      imported = importPlan(
        readFileSync(resolve(ctx.cwd, planPath), "utf-8"),
        Object.keys(config.tiers),
        Object.keys(config.verificationProfiles ?? {}),
        config.maxPlanTasks
      );
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
      return;
    }
    const current = loadBoard(ctx.cwd);
    if (current.tasks.length > 0) {
      const confirmed =
        ctx.hasUI &&
        (await ctx.ui.confirm(
          "Replace current plan?",
          `Archive ${current.tasks.length} current task(s), then import ${imported.tasks.length}?`
        ));
      if (!confirmed) {
        notify(ctx, "Plan import cancelled; current board was not changed.", "warning");
        return;
      }
    }
    try {
      if (current.tasks.length > 0) {
        replaceBoardWithArchive(ctx.cwd, () => structuredClone(imported), current.revision ?? 0);
      } else {
        replaceBoard(ctx.cwd, imported, current.revision ?? 0);
      }
    } catch (error) {
      notify(
        ctx,
        `${error instanceof Error ? error.message : String(error)}. Inspect and confirm the import again.`,
        "warning"
      );
      return;
    }
    runtime.onBoardChanged();
    notify(ctx, `Imported ${imported.tasks.length} task(s); plan approval is required.`);
    return;
  }

  if (planAction === "diff") {
    if (!planPath) {
      notify(ctx, `Usage: /${COMMAND} plan diff <file> [taskId]`, "warning");
      return;
    }
    const config = loadConfig(ctx.cwd);
    try {
      const candidate = importPlan(
        readFileSync(resolve(ctx.cwd, planPath), "utf-8"),
        Object.keys(config.tiers),
        Object.keys(config.verificationProfiles ?? {}),
        config.maxPlanTasks
      );
      const comparison = comparePlans(loadBoard(ctx.cwd), candidate, config);
      notify(
        ctx,
        formatPlanComparison(comparison, `/${COMMAND} plan diff ${planPath}`, planTaskId)
      );
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
    return;
  }

  await runtime.reviewPlan(ctx);
}
