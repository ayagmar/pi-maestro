import { type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { listArchivedBoards, loadArchivedBoard } from "./board.js";
import { resolveTierModel } from "./config.js";
import {
  calculateProjectedCost,
  type ForecastLaunchDemand,
  type ForecastModelCost,
  historicalLaunchCosts,
  type ProjectedCostEstimate,
} from "./cost-forecast-policy.js";
import { preflightWorkflow, selectedWorkflowTasks, type WorkflowPreflight } from "./preflight.js";
import { type Board, type MaestroConfig, type TierConfig } from "./types.js";

type ForecastRuntime = Pick<ExtensionContext, "model" | "modelRegistry">;

interface ResolvedForecastModel {
  identity?: string;
  cost?: ForecastModelCost;
}

export function preflightWorkflowWithCost(
  cwd: string,
  board: Board,
  config: MaestroConfig,
  runtime: ForecastRuntime,
  taskIds?: readonly string[]
): WorkflowPreflight {
  const estimate = estimateWorkflowCost(cwd, board, config, runtime, taskIds);
  return preflightWorkflow(board, config, taskIds, estimate);
}

export function estimateWorkflowCost(
  cwd: string,
  board: Board,
  config: MaestroConfig,
  runtime: ForecastRuntime,
  taskIds?: readonly string[]
): ProjectedCostEstimate {
  const demands = workflowCostDemands(board, config, runtime, taskIds);
  const archives = listArchivedBoards(cwd).flatMap(({ file }) => {
    try {
      return [loadArchivedBoard(cwd, file)];
    } catch {
      return [];
    }
  });
  return calculateProjectedCost(demands, historicalLaunchCosts(archives));
}

function workflowCostDemands(
  board: Board,
  config: MaestroConfig,
  runtime: ForecastRuntime,
  taskIds?: readonly string[]
): ForecastLaunchDemand[] {
  const demands: ForecastLaunchDemand[] = [];
  const tasks = selectedWorkflowTasks(board, taskIds);
  const reviewModels = resolveForecastModels("review", config.tiers.review, runtime);

  for (const task of tasks) {
    const executorModels = resolveForecastModels(task.tier, config.tiers[task.tier], runtime);
    for (const model of executorModels) {
      demands.push(demand(task.tier, "executor", config.maxAttempts, model));
    }

    const logicalReviewers =
      task.reviewPolicy === "confirm"
        ? config.reviewRequiredApprovals
        : task.reviewPolicy === "find-and-refute"
          ? 2
          : 1;
    const rawReviewerModels = Array.from({ length: logicalReviewers }, () => reviewModels)
      .flat()
      .slice(0, config.maxReviewerLaunches);
    for (const model of rawReviewerModels) {
      demands.push(demand("review", "reviewer", config.maxAttempts, model));
    }
  }
  return demands;
}

function demand(
  tier: string,
  kind: "executor" | "reviewer",
  launches: number,
  model: ResolvedForecastModel
): ForecastLaunchDemand {
  return {
    tier,
    kind,
    launches,
    ...(model.identity ? { model: model.identity } : {}),
    ...(model.cost ? { modelCost: model.cost } : {}),
  };
}

function resolveForecastModels(
  tierName: string,
  tier: TierConfig | undefined,
  runtime: ForecastRuntime
): ResolvedForecastModel[] {
  const configured = tier ?? { thinking: "medium" };
  const patterns: Array<string | undefined> = [configured.model, ...(configured.fallbacks ?? [])];
  return patterns.map((pattern, index) => {
    if (pattern === undefined && index === 0) return runtimeModel(runtime.model);
    if (!pattern) return {};
    try {
      if (!hasUsableRegistry(runtime.modelRegistry)) return configuredModel(pattern);
      const resolution = resolveTierModel(
        tierName,
        { model: pattern, thinking: configured.thinking },
        runtime.modelRegistry,
        runtime.model?.provider
      );
      if (!resolution.ok || !resolution.modelArg) return configuredModel(pattern);
      return registryModel(runtime.modelRegistry, resolution.modelArg) ?? configuredModel(pattern);
    } catch {
      return configuredModel(pattern);
    }
  });
}

function runtimeModel(model: ExtensionContext["model"]): ResolvedForecastModel {
  if (!model) return {};
  return { identity: `${model.provider}/${model.id}`, cost: model.cost };
}

function registryModel(
  registry: ModelRegistry,
  qualifiedModel: string
): ResolvedForecastModel | undefined {
  const separator = qualifiedModel.indexOf("/");
  if (separator <= 0) return undefined;
  const provider = qualifiedModel.slice(0, separator);
  const id = qualifiedModel.slice(separator + 1);
  const model = registry.find(provider, id);
  return model ? { identity: `${model.provider}/${model.id}`, cost: model.cost } : undefined;
}

function configuredModel(pattern: string): ResolvedForecastModel {
  return { identity: pattern };
}

function hasUsableRegistry(registry: ModelRegistry): boolean {
  const candidate = registry as unknown as { find?: unknown; getAvailable?: unknown };
  return typeof candidate.find === "function" && typeof candidate.getAvailable === "function";
}
