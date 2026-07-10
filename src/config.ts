import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROJECT_CONFIG_FILE, USER_CONFIG_FILE } from "./constants.js";
import { type ConductorConfig } from "./types.js";

export const DEFAULT_CONFIG: ConductorConfig = {
  maxParallel: 3,
  tiers: {
    trivial: { thinking: "low" },
    standard: { thinking: "medium" },
    complex: { thinking: "high" },
    review: { thinking: "high", tools: "read,bash,grep,find,ls" },
  },
};

export function mergeConfig(
  base: ConductorConfig,
  override: Partial<ConductorConfig> | undefined
): ConductorConfig {
  if (!override) return base;
  return {
    maxParallel: override.maxParallel ?? base.maxParallel,
    tiers: { ...base.tiers, ...override.tiers },
  };
}

function readConfigFile(file: string): Partial<ConductorConfig> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Partial<ConductorConfig>;
  } catch {
    return undefined;
  }
}

/** Resolve config: defaults ← ~/.pi/agent/conductor.json ← <cwd>/.pi/conductor.json */
export function loadConfig(cwd: string): ConductorConfig {
  const user = readConfigFile(join(getAgentDir(), USER_CONFIG_FILE));
  const project = readConfigFile(join(cwd, PROJECT_CONFIG_FILE));
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, user), project);
}

export function describeConfig(config: ConductorConfig): string {
  const lines = [`maxParallel: ${config.maxParallel}`, "tiers:"];
  for (const [name, tier] of Object.entries(config.tiers)) {
    const model = tier.model ?? "(pi default model)";
    const tools = tier.tools ? ` tools=${tier.tools}` : "";
    lines.push(`  ${name}: ${model} thinking=${tier.thinking}${tools}`);
  }
  return lines.join("\n");
}
