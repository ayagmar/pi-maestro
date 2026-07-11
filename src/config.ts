import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ModelRegistry, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { PROJECT_CONFIG_FILE, USER_CONFIG_FILE } from "./constants.js";
import { type MaestroConfig, type TierConfig } from "./types.js";

export type ConfigScope = "user" | "project";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const REVIEW_TOOLS = "read,bash,grep,find,ls";

/**
 * Works with any provider: executors inherit pi's default model and only
 * thinking level differentiates tiers. Apply a preset (or edit config) to
 * get real cheap-executor economics.
 */
export const DEFAULT_CONFIG: MaestroConfig = {
  maxParallel: 3,
  planGate: false,
  useWorktrees: false,
  autoCommit: true,
  maxAttempts: 3,
  maxCostPerTask: 0,
  maxRunCost: 0,
  tiers: {
    trivial: { thinking: "low" },
    standard: { thinking: "medium" },
    complex: { thinking: "high" },
    review: { thinking: "high", tools: REVIEW_TOOLS },
  },
};

export interface Preset {
  name: string;
  label: string;
  /** One-line rationale shown in the settings UI. */
  description: string;
  config: MaestroConfig;
}

/**
 * Presets derived from the Artificial Analysis Coding Agent Index v1.1 and
 * the deep SWE leaderboard (pass@1 / avg cost per run):
 *   gpt-5.6-sol    high $3.47 69% · medium $1.86 61%  · xhigh $4.70 71%
 *   gpt-5.6-terra  high $1.13 54% · xhigh  $2.13 60%
 *   gpt-5.6-luna   high $0.78 44% · xhigh  $1.54 57%
 * All preset models are provider-qualified so executors never silently
 * resolve to a different provider serving the same model id.
 *
 * The anthropic presets follow the capability ladder from Anthropic's
 * advisor-tool guidance (haiku-4-5 < sonnet-5 < opus-4-8 < fable-5): fast
 * executors on cheap tiers, stronger models on complex work, and the
 * strongest affordable model on the read-only review tier where judgment
 * matters most.
 */
export const PRESETS: Preset[] = [
  {
    name: "inherit",
    label: "Inherit pi default",
    description: "No model overrides; executors use your pi default model. Works everywhere.",
    config: DEFAULT_CONFIG,
  },
  {
    name: "openai-balanced",
    label: "OpenAI balanced (recommended)",
    description:
      "Best cost/quality per tier: terra-high trivial ($1.13), sol-medium standard ($1.86), sol-high complex+review ($3.47, 69% pass@1).",
    config: {
      maxParallel: 3,
      planGate: false,
      useWorktrees: false,
      autoCommit: true,
      maxAttempts: 3,
      maxCostPerTask: 0,
      maxRunCost: 0,
      tiers: {
        trivial: { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
        standard: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
        complex: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
        review: { model: "openai-codex/gpt-5.6-sol", thinking: "medium", tools: REVIEW_TOOLS },
      },
    },
  },
  {
    name: "openai-budget",
    label: "OpenAI budget",
    description:
      "Cheapest sensible run: luna-high trivial ($0.78), terra-high standard ($1.13), terra-xhigh complex+review ($2.13, 60% pass@1).",
    config: {
      maxParallel: 4,
      planGate: false,
      useWorktrees: false,
      autoCommit: true,
      maxAttempts: 3,
      maxCostPerTask: 2,
      maxRunCost: 0,
      tiers: {
        trivial: { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
        standard: { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
        complex: { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
        review: { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh", tools: REVIEW_TOOLS },
      },
    },
  },
  {
    name: "anthropic-budget",
    label: "Anthropic budget",
    description:
      "Cheapest Claude run: haiku-4-5 trivial, sonnet-5 for everything else including review.",
    config: {
      maxParallel: 4,
      planGate: false,
      useWorktrees: false,
      autoCommit: true,
      maxAttempts: 3,
      maxCostPerTask: 2,
      maxRunCost: 0,
      tiers: {
        trivial: { model: "anthropic/claude-haiku-4-5", thinking: "medium" },
        standard: { model: "anthropic/claude-sonnet-5", thinking: "medium" },
        complex: { model: "anthropic/claude-sonnet-5", thinking: "high" },
        review: { model: "anthropic/claude-sonnet-5", thinking: "high", tools: REVIEW_TOOLS },
      },
    },
  },
  {
    name: "anthropic-balanced",
    label: "Anthropic balanced",
    description:
      "Claude ladder: sonnet-5 executors for trivial+standard, opus-4-8 complex, fable-5 frontier review (strongest model on read-only judgment, per Anthropic's advisor pattern).",
    config: {
      maxParallel: 3,
      planGate: false,
      useWorktrees: false,
      autoCommit: true,
      maxAttempts: 3,
      maxCostPerTask: 0,
      maxRunCost: 0,
      tiers: {
        trivial: { model: "anthropic/claude-sonnet-5", thinking: "low" },
        standard: { model: "anthropic/claude-sonnet-5", thinking: "medium" },
        complex: { model: "anthropic/claude-opus-4-8", thinking: "high" },
        review: { model: "anthropic/claude-fable-5", thinking: "high", tools: REVIEW_TOOLS },
      },
    },
  },
  {
    name: "anthropic-quality",
    label: "Anthropic quality-first",
    description:
      "Frontier Claude on every tier: opus-4-8 trivial+standard, fable-5 complex and review.",
    config: {
      maxParallel: 3,
      planGate: false,
      useWorktrees: false,
      autoCommit: true,
      maxAttempts: 4,
      maxCostPerTask: 0,
      maxRunCost: 0,
      tiers: {
        trivial: { model: "anthropic/claude-opus-4-8", thinking: "medium" },
        standard: { model: "anthropic/claude-opus-4-8", thinking: "high" },
        complex: { model: "anthropic/claude-fable-5", thinking: "high" },
        review: { model: "anthropic/claude-fable-5", thinking: "high", tools: REVIEW_TOOLS },
      },
    },
  },
  {
    name: "openai-quality",
    label: "OpenAI quality-first",
    description:
      "Frontier executors on every tier: sol-medium trivial, sol-high standard, sol-xhigh complex ($4.70, 71% pass@1), sol-high review.",
    config: {
      maxParallel: 3,
      planGate: false,
      useWorktrees: false,
      autoCommit: true,
      maxAttempts: 4,
      maxCostPerTask: 0,
      maxRunCost: 0,
      tiers: {
        trivial: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
        standard: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
        complex: { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" },
        review: { model: "openai-codex/gpt-5.6-sol", thinking: "high", tools: REVIEW_TOOLS },
      },
    },
  },
];

export function findPreset(name: string): Preset | undefined {
  return PRESETS.find((preset) => preset.name === name);
}

/** Name of the preset the config matches, or "custom". */
export function matchingPreset(config: MaestroConfig): string {
  for (const preset of PRESETS) {
    if (JSON.stringify(preset.config) === JSON.stringify(config)) return preset.name;
  }
  return "custom";
}

export function mergeConfig(
  base: MaestroConfig,
  override: Partial<MaestroConfig> | undefined
): MaestroConfig {
  if (!override) return base;
  return {
    maxParallel: override.maxParallel ?? base.maxParallel,
    planGate: override.planGate ?? base.planGate,
    useWorktrees: override.useWorktrees ?? base.useWorktrees,
    autoCommit: override.autoCommit ?? base.autoCommit,
    maxAttempts: override.maxAttempts ?? base.maxAttempts,
    maxCostPerTask: override.maxCostPerTask ?? base.maxCostPerTask,
    maxRunCost: override.maxRunCost ?? base.maxRunCost,
    tiers: { ...base.tiers, ...override.tiers },
  };
}

export function configFile(scope: ConfigScope, cwd: string): string {
  if (scope === "user") return join(getAgentDir(), USER_CONFIG_FILE);
  return join(cwd, PROJECT_CONFIG_FILE);
}

function readConfigFile(file: string): Partial<MaestroConfig> | undefined {
  if (!existsSync(file)) return undefined;
  const contents = readFileSync(file, "utf-8");
  try {
    return JSON.parse(contents) as Partial<MaestroConfig>;
  } catch {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
    return undefined;
  }
}

/** Resolve config: defaults ← ~/.pi/agent/maestro.json ← <cwd>/.pi/maestro.json */
export function loadConfig(cwd: string): MaestroConfig {
  const user = readConfigFile(configFile("user", cwd));
  const project = readConfigFile(configFile("project", cwd));
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, user), project);
}

/** Persist a full config to the given scope file (settings UI writes here). */
export function saveConfig(scope: ConfigScope, cwd: string, config: MaestroConfig): void {
  const file = configFile(scope, cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function describeTier(tier: TierConfig): string {
  const model = tier.model ?? "(pi default model)";
  const tools = tier.tools ? ` tools=${tier.tools}` : "";
  return `${model} thinking=${tier.thinking}${tools}`;
}

export function describeConfig(config: MaestroConfig): string {
  const lines = [
    `preset: ${matchingPreset(config)}`,
    `maxParallel: ${config.maxParallel}`,
    `planGate: ${config.planGate}`,
    `useWorktrees: ${config.useWorktrees}`,
    `maxAttempts: ${config.maxAttempts}`,
    `maxCostPerTask: ${config.maxCostPerTask === 0 ? "off" : `$${config.maxCostPerTask}`}`,
    `maxRunCost: ${config.maxRunCost === 0 ? "off" : `$${config.maxRunCost}`}`,
    "tiers:",
  ];
  for (const [name, tier] of Object.entries(config.tiers)) {
    lines.push(`  ${name}: ${describeTier(tier)}`);
  }
  return lines.join("\n");
}

export type TierModelResolution =
  | { ok: true; modelArg: string | undefined }
  | { ok: false; error: string };

export type TierModelsResolution =
  | { ok: true; modelArgs: (string | undefined)[] }
  | { ok: false; error: string };

/**
 * Resolve a tier's model pattern to the --model argument for the executor.
 *
 * Bare patterns like "gpt-5.6-terra" can exist under several providers, and
 * only some of them are authed and actually serve the model. Preference order:
 *   1. explicit "provider/id" patterns resolve as written
 *   2. an authed model on the same provider the orchestrator is using
 *   3. any authed model matching the pattern
 * The result is always provider-qualified so the executor cannot re-resolve
 * to a different provider.
 */
export function resolveTierModel(
  tierName: string,
  tier: TierConfig,
  modelRegistry: ModelRegistry,
  preferredProvider?: string
): TierModelResolution {
  if (!tier.model) return { ok: true, modelArg: undefined }; // inherit pi default

  if (tier.model.includes("/")) {
    const result = resolveCliModel({ cliModel: tier.model, modelRegistry });
    if (!result.model) {
      return {
        ok: false,
        error: `Tier "${tierName}": "${tier.model}" does not match any model. Fix it in /maestro config or check pi --list-models.`,
      };
    }
    if (!modelRegistry.hasConfiguredAuth(result.model)) {
      return {
        ok: false,
        error: `Tier "${tierName}": no API key for ${result.model.provider}/${result.model.id}. Run /login for that provider or pick another model in /maestro config.`,
      };
    }
    return { ok: true, modelArg: `${result.model.provider}/${result.model.id}` };
  }

  const pattern = tier.model.toLowerCase();
  const candidates = modelRegistry
    .getAvailable()
    .filter((model) => model.id.toLowerCase().includes(pattern));
  if (candidates.length === 0) {
    return {
      ok: false,
      error: `Tier "${tierName}": no authed provider serves "${tier.model}". Run /login or pick another model in /maestro config (see pi --list-models ${tier.model}).`,
    };
  }

  const preferred = preferredProvider
    ? candidates.find((model) => model.provider === preferredProvider)
    : undefined;
  const chosen = preferred ?? candidates[0];
  if (!chosen) {
    return { ok: false, error: `Tier "${tierName}": no usable model for "${tier.model}".` };
  }
  return { ok: true, modelArg: `${chosen.provider}/${chosen.id}` };
}

/** Resolve the primary and ordered fallbacks, skipping patterns unavailable with current auth. */
export function resolveTierModels(
  tierName: string,
  tier: TierConfig,
  modelRegistry: ModelRegistry,
  preferredProvider?: string
): TierModelsResolution {
  const patterns: (string | undefined)[] = [tier.model, ...(tier.fallbacks ?? [])];
  const modelArgs: (string | undefined)[] = [];

  for (const [index, pattern] of patterns.entries()) {
    if (pattern === undefined) {
      if (index === 0) modelArgs.push(undefined);
      continue;
    }
    if (pattern.length === 0) continue;

    const resolution = resolveTierModel(
      tierName,
      { model: pattern, thinking: tier.thinking },
      modelRegistry,
      preferredProvider
    );
    if (resolution.ok) modelArgs.push(resolution.modelArg);
  }

  if (modelArgs.length > 0) return { ok: true, modelArgs };
  const configured = patterns.filter((pattern): pattern is string => pattern !== undefined);
  return {
    ok: false,
    error: `Tier "${tierName}": none of the configured models (${configured.join(", ")}) are available with configured authentication. Fix fallbacks in /maestro config, run /login, or check pi --list-models.`,
  };
}

/** Tier decision rules injected into planning guidance. Stated once, as decision rules. */
export function describeTiersForPlanning(config: MaestroConfig): string {
  const names = Object.keys(config.tiers).filter((name) => name !== "review");
  const known = new Set(["trivial", "standard", "complex"]);
  const lines = [
    "Pick the cheapest tier that can meet the acceptance criteria:",
    "- trivial: mechanical, well-specified changes (rename, config, small file, doc)",
    "- standard: a scoped feature or bugfix with a clear spec, few files",
    "- complex: cross-cutting changes, ambiguous specs, or design judgment",
  ];
  const custom = names.filter((name) => !known.has(name));
  if (custom.length > 0) lines.push(`- also available: ${custom.join(", ")}`);
  return lines.join("\n");
}
