import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { PROJECT_CONFIG_FILE, USER_CONFIG_FILE } from "./constants.js";
import { type MaestroConfig, type TierConfig } from "./types.js";

export type ConfigScope = "user" | "project";

/**
 * Mirrors pi's own ladder (`pi --thinking`). `max` exists upstream and is the
 * level a reviewer on genuinely hard work wants; omitting it silently capped
 * maestro at xhigh with no way to ask for more.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const REVIEW_TOOLS = "read,grep,find,ls";

/**
 * Works with any provider: executors inherit pi's default model and only
 * thinking level differentiates tiers. Apply a preset (or edit config) to
 * get real cheap-executor economics.
 */
export const DEFAULT_CONFIG: MaestroConfig = {
  maxParallel: 3,
  planGate: false,
  livePanes: false,
  useWorktrees: false,
  detachedExecutors: false,
  autoCommit: true,
  maxAttempts: 3,
  maxPlanTasks: 64,
  maxDiscoveryGeneratedTasks: 32,
  maxTotalLaunchesPerRun: 128,
  confirmationPlanTasks: 24,
  confirmationTotalLaunches: 64,
  reviewPolicy: "single",
  reviewRequiredApprovals: 2,
  maxReviewerLaunches: 4,
  maxCostPerTask: 5,
  maxCostPerReview: 0,
  maxRunCost: 25,
  reviewRejectionLimit: 2,
  retryContext: "resume",
  statusWaitSeconds: 60,
  logEvents: "compact",
  maxLogBytesPerRun: 1_000_000,
  watchdogIdleSeconds: 120,
  watchdogWarningTurns: 12,
  watchdogTerminationTurns: 4,
  handoffContextRatio: 0.68,
  cleanupCompletedTasks: true,
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
      ...DEFAULT_CONFIG,
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
      ...DEFAULT_CONFIG,
      maxParallel: 4,
      maxCostPerTask: 2,
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
      ...DEFAULT_CONFIG,
      maxParallel: 4,
      maxCostPerTask: 2,
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
      ...DEFAULT_CONFIG,
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
      ...DEFAULT_CONFIG,
      maxAttempts: 4,
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
      ...DEFAULT_CONFIG,
      maxAttempts: 4,
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
    livePanes: override.livePanes ?? base.livePanes,
    useWorktrees: override.useWorktrees ?? base.useWorktrees,
    detachedExecutors: override.detachedExecutors ?? base.detachedExecutors ?? false,
    autoCommit: override.autoCommit ?? base.autoCommit,
    maxAttempts: override.maxAttempts ?? base.maxAttempts,
    maxPlanTasks: override.maxPlanTasks ?? base.maxPlanTasks,
    maxDiscoveryGeneratedTasks:
      override.maxDiscoveryGeneratedTasks ?? base.maxDiscoveryGeneratedTasks,
    maxTotalLaunchesPerRun: override.maxTotalLaunchesPerRun ?? base.maxTotalLaunchesPerRun,
    confirmationPlanTasks: override.confirmationPlanTasks ?? base.confirmationPlanTasks,
    confirmationTotalLaunches: override.confirmationTotalLaunches ?? base.confirmationTotalLaunches,
    reviewPolicy: override.reviewPolicy ?? base.reviewPolicy ?? "single",
    reviewRequiredApprovals: override.reviewRequiredApprovals ?? base.reviewRequiredApprovals ?? 2,
    maxReviewerLaunches: override.maxReviewerLaunches ?? base.maxReviewerLaunches ?? 4,
    maxCostPerTask: override.maxCostPerTask ?? base.maxCostPerTask,
    maxCostPerReview: override.maxCostPerReview ?? base.maxCostPerReview ?? 0,
    maxRunCost: override.maxRunCost ?? base.maxRunCost,
    reviewRejectionLimit: override.reviewRejectionLimit ?? base.reviewRejectionLimit ?? 2,
    retryContext: override.retryContext ?? base.retryContext ?? "resume",
    statusWaitSeconds: override.statusWaitSeconds ?? base.statusWaitSeconds,
    logEvents: override.logEvents ?? base.logEvents ?? "compact",
    maxLogBytesPerRun: override.maxLogBytesPerRun ?? base.maxLogBytesPerRun ?? 1_000_000,
    watchdogIdleSeconds: override.watchdogIdleSeconds ?? base.watchdogIdleSeconds ?? 120,
    watchdogWarningTurns: override.watchdogWarningTurns ?? base.watchdogWarningTurns ?? 12,
    watchdogTerminationTurns:
      override.watchdogTerminationTurns ?? base.watchdogTerminationTurns ?? 4,
    handoffContextRatio: override.handoffContextRatio ?? base.handoffContextRatio ?? 0.68,
    cleanupCompletedTasks: override.cleanupCompletedTasks ?? base.cleanupCompletedTasks ?? true,
    ...((override.verificationProfiles ?? base.verificationProfiles)
      ? { verificationProfiles: { ...base.verificationProfiles, ...override.verificationProfiles } }
      : {}),
    ...((override.defaultVerificationProfile ?? base.defaultVerificationProfile)
      ? {
          defaultVerificationProfile:
            override.defaultVerificationProfile ?? base.defaultVerificationProfile,
        }
      : {}),
    tiers: { ...base.tiers, ...override.tiers },
  };
}

export function userDataDirectory(): string {
  return getAgentDir();
}

export function configFile(scope: ConfigScope, cwd: string): string {
  if (scope === "user") return join(userDataDirectory(), USER_CONFIG_FILE);
  return join(cwd, PROJECT_CONFIG_FILE);
}

const CONFIG_KEYS = new Set([
  "maxParallel",
  "planGate",
  "livePanes",
  "useWorktrees",
  "detachedExecutors",
  "autoCommit",
  "maxAttempts",
  "maxPlanTasks",
  "maxDiscoveryGeneratedTasks",
  "maxTotalLaunchesPerRun",
  "confirmationPlanTasks",
  "confirmationTotalLaunches",
  "reviewPolicy",
  "reviewRequiredApprovals",
  "maxReviewerLaunches",
  "maxCostPerTask",
  "maxCostPerReview",
  "maxRunCost",
  "reviewRejectionLimit",
  "retryContext",
  "statusWaitSeconds",
  "logEvents",
  "maxLogBytesPerRun",
  "watchdogIdleSeconds",
  "watchdogWarningTurns",
  "watchdogTerminationTurns",
  "handoffContextRatio",
  "cleanupCompletedTasks",
  "verificationProfiles",
  "defaultVerificationProfile",
  "tiers",
]);

export function validateConfig(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "must be a JSON object";
  const config = value as Record<string, unknown>;
  const unknown = Object.keys(config).find((key) => !CONFIG_KEYS.has(key));
  if (unknown) return `unknown field ${unknown}`;
  const booleanKeys = [
    "planGate",
    "livePanes",
    "useWorktrees",
    "detachedExecutors",
    "autoCommit",
    "cleanupCompletedTasks",
  ];
  for (const key of booleanKeys) {
    if (config[key] !== undefined && typeof config[key] !== "boolean")
      return `${key} must be boolean`;
  }
  if (
    config.reviewPolicy !== undefined &&
    !["single", "confirm", "find-and-refute"].includes(config.reviewPolicy as string)
  ) {
    return "reviewPolicy must be single, confirm, or find-and-refute";
  }
  if (
    config.retryContext !== undefined &&
    !["resume", "fresh"].includes(config.retryContext as string)
  ) {
    return "retryContext must be resume or fresh";
  }
  const ranges: Record<string, [number, number]> = {
    maxParallel: [1, 64],
    maxAttempts: [1, 100],
    maxPlanTasks: [1, 512],
    maxDiscoveryGeneratedTasks: [1, 128],
    maxTotalLaunchesPerRun: [1, 4_096],
    confirmationPlanTasks: [1, 512],
    confirmationTotalLaunches: [1, 4_096],
    reviewRequiredApprovals: [2, 8],
    maxReviewerLaunches: [1, 16],
    maxCostPerTask: [0, 1_000_000],
    maxCostPerReview: [0, 1_000_000],
    maxRunCost: [0, 1_000_000],
    reviewRejectionLimit: [1, 10],
    statusWaitSeconds: [0, 240],
    maxLogBytesPerRun: [0, 1_000_000_000],
    watchdogIdleSeconds: [0, 86_400],
    watchdogWarningTurns: [0, 10_000],
    watchdogTerminationTurns: [0, 10_000],
    handoffContextRatio: [0, 1],
  };
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    const candidate = config[key];
    if (candidate === undefined) continue;
    if (
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      candidate < minimum ||
      candidate > maximum
    ) {
      return `${key} must be a finite number from ${minimum} to ${maximum}`;
    }
  }
  for (const key of [
    "maxParallel",
    "maxAttempts",
    "maxPlanTasks",
    "maxDiscoveryGeneratedTasks",
    "maxTotalLaunchesPerRun",
    "confirmationPlanTasks",
    "confirmationTotalLaunches",
    "reviewRequiredApprovals",
    "maxReviewerLaunches",
    "reviewRejectionLimit",
  ]) {
    if (config[key] !== undefined && !Number.isInteger(config[key])) {
      return `${key} must be an integer`;
    }
  }
  const requiredApprovals = config.reviewRequiredApprovals;
  const maximumLaunches = config.maxReviewerLaunches;
  if (
    typeof requiredApprovals === "number" &&
    typeof maximumLaunches === "number" &&
    requiredApprovals > maximumLaunches
  ) {
    return `reviewRequiredApprovals (${requiredApprovals}) cannot exceed maxReviewerLaunches (${maximumLaunches})`;
  }
  if (
    typeof config.maxDiscoveryGeneratedTasks === "number" &&
    typeof config.maxPlanTasks === "number" &&
    config.maxDiscoveryGeneratedTasks > config.maxPlanTasks
  ) {
    return `maxDiscoveryGeneratedTasks (${config.maxDiscoveryGeneratedTasks}) cannot exceed maxPlanTasks (${config.maxPlanTasks})`;
  }
  if (
    typeof config.maxReviewerLaunches === "number" &&
    typeof config.maxTotalLaunchesPerRun === "number" &&
    config.maxReviewerLaunches > config.maxTotalLaunchesPerRun
  ) {
    return `maxReviewerLaunches (${config.maxReviewerLaunches}) cannot exceed maxTotalLaunchesPerRun (${config.maxTotalLaunchesPerRun})`;
  }
  if (
    typeof config.confirmationPlanTasks === "number" &&
    typeof config.maxPlanTasks === "number" &&
    config.confirmationPlanTasks > config.maxPlanTasks
  ) {
    return `confirmationPlanTasks (${config.confirmationPlanTasks}) cannot exceed maxPlanTasks (${config.maxPlanTasks})`;
  }
  if (
    typeof config.confirmationTotalLaunches === "number" &&
    typeof config.maxTotalLaunchesPerRun === "number" &&
    config.confirmationTotalLaunches > config.maxTotalLaunchesPerRun
  ) {
    return `confirmationTotalLaunches (${config.confirmationTotalLaunches}) cannot exceed maxTotalLaunchesPerRun (${config.maxTotalLaunchesPerRun})`;
  }
  if (
    config.logEvents !== undefined &&
    config.logEvents !== "compact" &&
    config.logEvents !== "full"
  ) {
    return "logEvents must be compact or full";
  }
  if (
    config.defaultVerificationProfile !== undefined &&
    typeof config.defaultVerificationProfile !== "string"
  ) {
    return "defaultVerificationProfile must be a string";
  }
  if (config.verificationProfiles !== undefined) {
    if (
      !config.verificationProfiles ||
      typeof config.verificationProfiles !== "object" ||
      Array.isArray(config.verificationProfiles)
    ) {
      return "verificationProfiles must be an object";
    }
    const profiles = Object.entries(config.verificationProfiles as Record<string, unknown>);
    if (profiles.length > 32) return "verificationProfiles cannot contain more than 32 profiles";
    for (const [name, raw] of profiles) {
      if (!name.trim() || name.length > 64)
        return "verification profile names must be 1-64 characters";
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return `verification profile ${name} must be an object`;
      const profile = raw as Record<string, unknown>;
      if (
        typeof profile.command !== "string" ||
        profile.command.length === 0 ||
        profile.command.length > 1000
      )
        return `verification profile ${name} has an invalid command`;
      if (
        typeof profile.timeoutSeconds !== "number" ||
        !Number.isFinite(profile.timeoutSeconds) ||
        profile.timeoutSeconds <= 0 ||
        profile.timeoutSeconds > 3600
      )
        return `verification profile ${name} has an invalid timeoutSeconds`;
    }
  }
  if (config.tiers !== undefined) {
    if (!config.tiers || typeof config.tiers !== "object" || Array.isArray(config.tiers))
      return "tiers must be an object";
    for (const [name, rawTier] of Object.entries(config.tiers as Record<string, unknown>)) {
      if (!name.trim()) return "tier names cannot be empty";
      if (!rawTier || typeof rawTier !== "object" || Array.isArray(rawTier))
        return `tier ${name} must be an object`;
      const tier = rawTier as Record<string, unknown>;
      if (
        typeof tier.thinking !== "string" ||
        !(THINKING_LEVELS as readonly string[]).includes(tier.thinking)
      )
        return `tier ${name} thinking must be one of: ${THINKING_LEVELS.join(", ")}`;
      if (tier.model !== undefined && typeof tier.model !== "string")
        return `tier ${name} model must be a string`;
      if (tier.tools !== undefined && typeof tier.tools !== "string")
        return `tier ${name} tools must be a string`;
      if (
        tier.fallbacks !== undefined &&
        (!Array.isArray(tier.fallbacks) ||
          !tier.fallbacks.every((item) => typeof item === "string"))
      )
        return `tier ${name} fallbacks must be strings`;
      const watchdogRanges: Record<string, [number, number]> = {
        watchdogIdleSeconds: [0, 86_400],
        watchdogWarningTurns: [0, 10_000],
        watchdogTerminationTurns: [0, 10_000],
      };
      for (const [key, [minimum, maximum]] of Object.entries(watchdogRanges)) {
        const candidate = tier[key];
        if (candidate === undefined) continue;
        if (
          typeof candidate !== "number" ||
          !Number.isFinite(candidate) ||
          candidate < minimum ||
          candidate > maximum
        ) {
          return `tier ${name} ${key} must be a finite number from ${minimum} to ${maximum}`;
        }
      }
    }
  }
  return undefined;
}

export function validateEffectiveConfig(config: MaestroConfig): string | undefined {
  const error = validateConfig(config);
  if (error) return error;
  if (
    config.defaultVerificationProfile &&
    !config.verificationProfiles?.[config.defaultVerificationProfile]
  ) {
    return `defaultVerificationProfile (${config.defaultVerificationProfile}) must name a configured verification profile`;
  }
  return undefined;
}

interface ConfigCacheEntry {
  identity: string;
  value: Partial<MaestroConfig> | undefined;
}

const configCache = new Map<string, ConfigCacheEntry>();

/** Exact file identity (inode + size + mtime ns) so a cached parse can never go stale silently. */
function configFileIdentity(file: string): string | undefined {
  try {
    const stat = statSync(file, { bigint: true });
    return `${stat.ino}-${stat.size}-${stat.mtimeNs}`;
  } catch {
    return undefined;
  }
}

function readConfigFile(file: string): Partial<MaestroConfig> | undefined {
  const identity = configFileIdentity(file);
  if (identity === undefined) {
    configCache.delete(file);
    return undefined;
  }
  const cached = configCache.get(file);
  if (cached && cached.identity === identity) {
    return cached.value === undefined ? undefined : structuredClone(cached.value);
  }
  const contents = readFileSync(file, "utf-8");
  try {
    const parsed: unknown = JSON.parse(contents);
    const error = validateConfig(parsed);
    if (error) {
      configCache.delete(file);
      renameSync(file, `${file}.invalid-${Date.now()}`);
      return undefined;
    }
    if (configFileIdentity(file) === identity) {
      configCache.set(file, {
        identity,
        value: structuredClone(parsed) as Partial<MaestroConfig>,
      });
    }
    return parsed as Partial<MaestroConfig>;
  } catch {
    configCache.delete(file);
    renameSync(file, `${file}.corrupt-${Date.now()}`);
    return undefined;
  }
}

/**
 * Whether the current project is trusted by pi. Untrusted projects cannot
 * influence maestro behavior through `.pi/maestro.json`: budgets, attempt
 * caps, tier models, and tier tool lists all stay at trusted (user) values.
 * The extension records pi's decision at session start; the default is
 * trusted for direct library/test use outside a pi session.
 */
let projectConfigTrusted = true;

export function setProjectConfigTrust(trusted: boolean): void {
  projectConfigTrusted = trusted;
}

export function isProjectConfigTrusted(): boolean {
  return projectConfigTrusted;
}

/**
 * Resolve config: defaults ← trusted user config ← non-executable project settings.
 * A repository may select a user-defined verification profile, but cannot define
 * commands. An untrusted project contributes no settings at all.
 */
export function loadConfig(cwd: string): MaestroConfig {
  const user = readConfigFile(configFile("user", cwd));
  const project = projectConfigTrusted ? readConfigFile(configFile("project", cwd)) : undefined;
  const trusted = mergeConfig(DEFAULT_CONFIG, user);
  let resolved = trusted;
  if (project) {
    const { verificationProfiles: _ignoredCommands, ...projectSettings } = project;
    const selected = projectSettings.defaultVerificationProfile;
    if (selected && !trusted.verificationProfiles?.[selected]) {
      delete projectSettings.defaultVerificationProfile;
    }
    resolved = mergeConfig(trusted, projectSettings);
  }

  const error = validateEffectiveConfig(resolved);
  if (error) throw new Error(`Invalid effective maestro configuration: ${error}`);
  return resolved;
}

/** Persist a full config to the given scope file (settings UI writes here). */
export function saveConfig(scope: ConfigScope, cwd: string, config: MaestroConfig): void {
  const error = validateEffectiveConfig(config);
  if (error) throw new Error(`Cannot save invalid effective maestro configuration: ${error}`);
  const file = configFile(scope, cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function describeTier(tier: TierConfig): string {
  const model = tier.model ?? "(pi default model)";
  const tools = tier.tools ? ` tools=${tier.tools}` : "";
  const watchdog = [
    tier.watchdogIdleSeconds === undefined ? "" : ` idle=${tier.watchdogIdleSeconds}s`,
    tier.watchdogWarningTurns === undefined ? "" : ` warn=${tier.watchdogWarningTurns}t`,
    tier.watchdogTerminationTurns === undefined
      ? ""
      : ` terminate=${tier.watchdogTerminationTurns}t`,
  ].join("");
  return `${model} thinking=${tier.thinking}${tools}${watchdog}`;
}

export function describeConfig(config: MaestroConfig): string {
  const lines = [
    `preset: ${matchingPreset(config)}`,
    `maxParallel: ${config.maxParallel}`,
    `planGate: ${config.planGate}`,
    `livePanes: ${config.livePanes}`,
    `useWorktrees: ${config.useWorktrees}`,
    `detachedExecutors: ${config.detachedExecutors ?? false}`,
    `maxAttempts: ${config.maxAttempts}`,
    `maxPlanTasks: ${config.maxPlanTasks}`,
    `maxDiscoveryGeneratedTasks: ${config.maxDiscoveryGeneratedTasks}`,
    `maxTotalLaunchesPerRun: ${config.maxTotalLaunchesPerRun}`,
    `confirmationPlanTasks: ${config.confirmationPlanTasks}`,
    `confirmationTotalLaunches: ${config.confirmationTotalLaunches}`,
    `reviewRequiredApprovals: ${config.reviewRequiredApprovals ?? 2}`,
    `maxReviewerLaunches: ${config.maxReviewerLaunches ?? 4}`,
    `maxCostPerTask: ${config.maxCostPerTask === 0 ? "off" : `$${config.maxCostPerTask}`}`,
    `maxCostPerReview: ${!config.maxCostPerReview ? "inherit maxCostPerTask" : `$${config.maxCostPerReview}`}`,
    `maxRunCost: ${config.maxRunCost === 0 ? "off" : `$${config.maxRunCost}`}`,
    `reviewRejectionLimit: ${config.reviewRejectionLimit ?? 2}`,
    `retryContext: ${config.retryContext ?? "resume"}`,
    `statusWaitSeconds: ${config.statusWaitSeconds}`,
    `logEvents: ${config.logEvents ?? "compact"}`,
    `maxLogBytesPerRun: ${config.maxLogBytesPerRun === 0 ? "unlimited" : (config.maxLogBytesPerRun ?? 1_000_000)}`,
    `watchdogIdleSeconds: ${config.watchdogIdleSeconds ?? 120}`,
    `watchdogWarningTurns: ${config.watchdogWarningTurns ?? 12}`,
    `watchdogTerminationTurns: ${config.watchdogTerminationTurns ?? 4}`,
    `handoffContextRatio: ${config.handoffContextRatio ?? 0.68}`,
    `cleanupCompletedTasks: ${config.cleanupCompletedTasks ?? true}`,
    `verificationProfiles: ${Object.keys(config.verificationProfiles ?? {}).length} trusted user profile(s)`,
    `defaultVerificationProfile: ${config.defaultVerificationProfile ?? "(none)"}`,
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
    const result = findQualifiedModel(modelRegistry, tier.model);
    if (!result) {
      return {
        ok: false,
        error: `Tier "${tierName}": "${tier.model}" does not match any model. Fix it in /maestro config or check pi --list-models.`,
      };
    }
    if (!modelRegistry.hasConfiguredAuth(result)) {
      return {
        ok: false,
        error: `Tier "${tierName}": no API key for ${result.provider}/${result.id}. Run /login for that provider or pick another model in /maestro config.`,
      };
    }
    return { ok: true, modelArg: `${result.provider}/${result.id}` };
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

function findQualifiedModel(modelRegistry: ModelRegistry, reference: string) {
  const models = modelRegistry.getAll();
  const normalized = reference.toLowerCase();
  const exact = models.find(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized
  );
  if (exact) return exact;

  const separator = reference.indexOf("/");
  if (separator < 1 || separator === reference.length - 1) return undefined;
  const provider = reference.slice(0, separator).toLowerCase();
  const pattern = reference.slice(separator + 1).toLowerCase();
  return models
    .filter((model) => model.provider.toLowerCase() === provider)
    .sort((left, right) => left.id.localeCompare(right.id))
    .find(
      (model) =>
        model.id.toLowerCase().includes(pattern) || model.name?.toLowerCase().includes(pattern)
    );
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
