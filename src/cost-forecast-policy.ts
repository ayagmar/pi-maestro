import { type Board } from "./types.js";

export const FORECAST_INPUT_TOKENS_PER_LAUNCH = 20_000;
export const FORECAST_OUTPUT_TOKENS_PER_LAUNCH = 4_000;
export const FORECAST_STATIC_COST_PER_LAUNCH = 0.1;

export interface ForecastModelCost {
  input: number;
  output: number;
  tiers?: Array<{ inputTokensAbove: number; input: number; output: number }>;
}

export interface ForecastLaunchDemand {
  tier: string;
  kind: "executor" | "reviewer";
  launches: number;
  model?: string;
  modelCost?: ForecastModelCost;
}

export interface HistoricalLaunchCost {
  tier: string;
  kind: "executor" | "reviewer";
  model: string;
  cost: number;
}

export interface ProjectedCostEstimate {
  estimatedUsd: number;
  launchUpperBound: number;
  sourceLaunches: {
    historical: number;
    modelMetadata: number;
    staticFallback: number;
  };
  historicalSamples: number;
  assumptions: {
    inputTokensPerLaunch: number;
    outputTokensPerLaunch: number;
    staticCostPerLaunch: number;
  };
}

export function calculateProjectedCost(
  demands: readonly ForecastLaunchDemand[],
  history: readonly HistoricalLaunchCost[]
): ProjectedCostEstimate {
  const historical = new Map<string, { cost: number; samples: number }>();
  for (const sample of history) {
    if (!Number.isFinite(sample.cost) || sample.cost < 0) continue;
    const key = historyKey(sample.tier, sample.kind, sample.model);
    const current = historical.get(key) ?? { cost: 0, samples: 0 };
    current.cost += sample.cost;
    current.samples += 1;
    historical.set(key, current);
  }

  let estimatedUsd = 0;
  let launchUpperBound = 0;
  let historicalSamples = 0;
  const usedHistoricalKeys = new Set<string>();
  const sourceLaunches = { historical: 0, modelMetadata: 0, staticFallback: 0 };

  for (const demand of demands) {
    if (!Number.isFinite(demand.launches) || demand.launches <= 0) continue;
    launchUpperBound += demand.launches;
    const matchingHistoryKey = demand.model
      ? historyKey(demand.tier, demand.kind, demand.model)
      : undefined;
    const sample = matchingHistoryKey ? historical.get(matchingHistoryKey) : undefined;
    if (matchingHistoryKey && sample && sample.samples > 0) {
      estimatedUsd += (sample.cost / sample.samples) * demand.launches;
      sourceLaunches.historical += demand.launches;
      if (!usedHistoricalKeys.has(matchingHistoryKey)) {
        usedHistoricalKeys.add(matchingHistoryKey);
        historicalSamples += sample.samples;
      }
      continue;
    }
    if (demand.modelCost) {
      estimatedUsd += metadataCostPerLaunch(demand.modelCost) * demand.launches;
      sourceLaunches.modelMetadata += demand.launches;
      continue;
    }
    estimatedUsd += FORECAST_STATIC_COST_PER_LAUNCH * demand.launches;
    sourceLaunches.staticFallback += demand.launches;
  }

  return {
    estimatedUsd,
    launchUpperBound,
    sourceLaunches,
    historicalSamples,
    assumptions: {
      inputTokensPerLaunch: FORECAST_INPUT_TOKENS_PER_LAUNCH,
      outputTokensPerLaunch: FORECAST_OUTPUT_TOKENS_PER_LAUNCH,
      staticCostPerLaunch: FORECAST_STATIC_COST_PER_LAUNCH,
    },
  };
}

export function staticProjectedCost(launchUpperBound: number): ProjectedCostEstimate {
  return calculateProjectedCost(
    [{ tier: "unknown", kind: "executor", launches: launchUpperBound }],
    []
  );
}

export function historicalLaunchCosts(boards: readonly Board[]): HistoricalLaunchCost[] {
  const samples: HistoricalLaunchCost[] = [];
  const seen = new Set<string>();
  for (const board of boards) {
    for (const task of board.tasks) {
      for (const attempt of task.attempts) {
        const executorModel = modelIdentity(attempt.provider, attempt.model);
        if (executorModel) {
          const key = launchIdentity(
            "executor",
            attempt.sessionFile ?? attempt.logFile,
            attempt.startedAt,
            executorModel
          );
          if (!seen.has(key)) {
            seen.add(key);
            samples.push({
              tier: task.tier,
              kind: "executor",
              model: executorModel,
              cost: Math.max(0, attempt.usage.cost - (attempt.reviewUsage?.cost ?? 0)),
            });
          }
        }

        if (attempt.reviewLaunches && attempt.reviewLaunches.length > 0) {
          for (const launch of attempt.reviewLaunches) {
            const reviewerModel = modelIdentity(launch.provider, launch.model);
            if (!reviewerModel) continue;
            const key = launchIdentity(
              "reviewer",
              launch.sessionFile ?? launch.logFile ?? launch.id,
              launch.startedAt,
              reviewerModel
            );
            if (seen.has(key)) continue;
            seen.add(key);
            samples.push({
              tier: "review",
              kind: "reviewer",
              model: reviewerModel,
              cost: launch.usage.cost,
            });
          }
        } else {
          const reviewerModel = modelIdentity(attempt.reviewProvider, attempt.reviewModel);
          if (!reviewerModel || !attempt.reviewUsage) continue;
          const key = launchIdentity(
            "reviewer",
            attempt.reviewSessionFile,
            attempt.startedAt,
            reviewerModel
          );
          if (seen.has(key)) continue;
          seen.add(key);
          samples.push({
            tier: "review",
            kind: "reviewer",
            model: reviewerModel,
            cost: attempt.reviewUsage.cost,
          });
        }
      }
    }
  }
  return samples;
}

export function modelIdentity(
  provider: string | undefined,
  model: string | undefined
): string | undefined {
  if (!model) return undefined;
  if (model.includes("/")) return model;
  return provider ? `${provider}/${model}` : model;
}

function metadataCostPerLaunch(cost: ForecastModelCost): number {
  const tier = cost.tiers
    ?.filter((candidate) => FORECAST_INPUT_TOKENS_PER_LAUNCH > candidate.inputTokensAbove)
    .sort((left, right) => right.inputTokensAbove - left.inputTokensAbove)[0];
  const rates = tier ?? cost;
  return (
    (FORECAST_INPUT_TOKENS_PER_LAUNCH * rates.input +
      FORECAST_OUTPUT_TOKENS_PER_LAUNCH * rates.output) /
    1_000_000
  );
}

function historyKey(tier: string, kind: string, model: string): string {
  return `${tier}\u0000${kind}\u0000${model.toLowerCase()}`;
}

function launchIdentity(
  kind: string,
  persistedReference: string | undefined,
  startedAt: number,
  model: string
): string {
  return `${kind}\u0000${persistedReference ?? ""}\u0000${startedAt}\u0000${model}`;
}
