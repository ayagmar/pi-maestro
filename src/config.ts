import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ModelRegistry, getAgentDir, resolveCliModel } from "@earendil-works/pi-coding-agent";
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
  maxAttempts: 3,
  maxCostPerTask: 0,
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
 * Model names are patterns (no provider prefix) so pi resolves whichever
 * provider you have access to (openai-codex, openai, proxies, ...).
 */
export const PRESETS: Preset[] = [
  {
    name: "inherit",
    label: "Inherit pi default",
    description: "No model overrides; executors use your pi default model. Works everywhere.",
    config: DEFAULT_CONFIG,
  },
  {
    name: "balanced",
    label: "Balanced (recommended)",
    description:
      "Best cost/quality per tier: terra-high trivial ($1.13), sol-medium standard ($1.86), sol-high complex+review ($3.47, 69% pass@1).",
    config: {
      maxParallel: 3,
      maxAttempts: 3,
      maxCostPerTask: 0,
      tiers: {
        trivial: { model: "gpt-5.6-terra", thinking: "high" },
        standard: { model: "gpt-5.6-sol", thinking: "medium" },
        complex: { model: "gpt-5.6-sol", thinking: "high" },
        review: { model: "gpt-5.6-sol", thinking: "medium", tools: REVIEW_TOOLS },
      },
    },
  },
  {
    name: "budget",
    label: "Budget",
    description:
      "Cheapest sensible run: luna-high trivial ($0.78), terra-high standard ($1.13), terra-xhigh complex+review ($2.13, 60% pass@1).",
    config: {
      maxParallel: 4,
      maxAttempts: 3,
      maxCostPerTask: 2,
      tiers: {
        trivial: { model: "gpt-5.6-luna", thinking: "high" },
        standard: { model: "gpt-5.6-terra", thinking: "high" },
        complex: { model: "gpt-5.6-terra", thinking: "xhigh" },
        review: { model: "gpt-5.6-terra", thinking: "xhigh", tools: REVIEW_TOOLS },
      },
    },
  },
  {
    name: "quality",
    label: "Quality-first",
    description:
      "Frontier executors on every tier: sol-medium trivial, sol-high standard, sol-xhigh complex ($4.70, 71% pass@1), sol-high review.",
    config: {
      maxParallel: 3,
      maxAttempts: 4,
      maxCostPerTask: 0,
      tiers: {
        trivial: { model: "gpt-5.6-sol", thinking: "medium" },
        standard: { model: "gpt-5.6-sol", thinking: "high" },
        complex: { model: "gpt-5.6-sol", thinking: "xhigh" },
        review: { model: "gpt-5.6-sol", thinking: "high", tools: REVIEW_TOOLS },
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
    maxAttempts: override.maxAttempts ?? base.maxAttempts,
    maxCostPerTask: override.maxCostPerTask ?? base.maxCostPerTask,
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
    `maxAttempts: ${config.maxAttempts}`,
    `maxCostPerTask: ${config.maxCostPerTask === 0 ? "off" : `$${config.maxCostPerTask}`}`,
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
