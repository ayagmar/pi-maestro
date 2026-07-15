import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  describeConfig,
  describeTiersForPlanning,
  findPreset,
  loadConfig,
  matchingPreset,
  mergeConfig,
  PRESETS,
  REVIEW_TOOLS,
  resolveTierModel,
  resolveTierModels,
  saveConfig,
  validateConfig,
} from "../src/config.js";

test("mergeConfig without override returns base", () => {
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, undefined), DEFAULT_CONFIG);
});

test("mergeConfig overrides top-level worktree settings and merges tiers", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    maxParallel: 5,
    useWorktrees: true,
    tiers: { standard: { model: "gpt-5.6-terra", thinking: "low" } },
  });
  assert.equal(merged.maxParallel, 5);
  assert.equal(merged.useWorktrees, true);
  assert.equal(merged.tiers.standard?.model, "gpt-5.6-terra");
  assert.equal(merged.tiers.standard?.thinking, "low");
  // Untouched tiers survive
  assert.equal(merged.tiers.complex?.thinking, "high");
  assert.equal(merged.tiers.review?.tools, REVIEW_TOOLS);
});

test("default config has the documented tiers and no model overrides", () => {
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.tiers).sort(), [
    "complex",
    "review",
    "standard",
    "trivial",
  ]);
  assert.equal(DEFAULT_CONFIG.maxParallel, 3);
  assert.equal(DEFAULT_CONFIG.planGate, false);
  assert.equal(DEFAULT_CONFIG.livePanes, false);
  assert.equal(DEFAULT_CONFIG.useWorktrees, false);
  assert.equal(DEFAULT_CONFIG.maxCostPerTask, 5);
  assert.equal(DEFAULT_CONFIG.maxRunCost, 25);
  assert.equal(DEFAULT_CONFIG.statusWaitSeconds, 60);
  assert.equal(DEFAULT_CONFIG.reviewRequiredApprovals, 2);
  assert.equal(DEFAULT_CONFIG.maxReviewerLaunches, 4);
  assert.equal(DEFAULT_CONFIG.maxPlanTasks, 64);
  assert.equal(DEFAULT_CONFIG.maxDiscoveryGeneratedTasks, 32);
  assert.equal(DEFAULT_CONFIG.maxTotalLaunchesPerRun, 128);
  assert.equal(DEFAULT_CONFIG.confirmationPlanTasks, 24);
  assert.equal(DEFAULT_CONFIG.confirmationTotalLaunches, 64);
  assert.equal(DEFAULT_CONFIG.watchdogWarningTurns, 12);
  assert.equal(DEFAULT_CONFIG.watchdogTerminationTurns, 4);
  for (const tier of Object.values(DEFAULT_CONFIG.tiers)) {
    assert.equal(tier.model, undefined);
  }
});

test("every preset defines all four tiers and keeps review read-only", () => {
  for (const preset of PRESETS) {
    assert.deepEqual(
      Object.keys(preset.config.tiers).sort(),
      ["complex", "review", "standard", "trivial"],
      `preset ${preset.name}`
    );
    assert.equal(preset.config.planGate, false, `preset ${preset.name}`);
    assert.equal(preset.config.livePanes, false, `preset ${preset.name}`);
    assert.equal(preset.config.useWorktrees, false, `preset ${preset.name}`);
    assert.equal(preset.config.maxRunCost, 25, `preset ${preset.name}`);
    assert.equal(preset.config.statusWaitSeconds, 60, `preset ${preset.name}`);
    assert.equal(preset.config.reviewRequiredApprovals, 2, `preset ${preset.name}`);
    assert.equal(preset.config.maxReviewerLaunches, 4, `preset ${preset.name}`);
    assert.equal(preset.config.tiers.review?.tools, REVIEW_TOOLS, `preset ${preset.name}`);
    assert.ok(preset.description.length > 0, `preset ${preset.name} needs a description`);
  }
});

test("findPreset and matchingPreset round-trip", () => {
  const balanced = findPreset("openai-balanced");
  assert.ok(balanced);
  assert.equal(matchingPreset(balanced.config), "openai-balanced");
  assert.equal(matchingPreset(DEFAULT_CONFIG), "inherit");
  const custom = mergeConfig(DEFAULT_CONFIG, { maxParallel: 7 });
  assert.equal(matchingPreset(custom), "custom");
});

test("describeConfig lists preset name and every tier", () => {
  const text = describeConfig(DEFAULT_CONFIG);
  assert.match(text, /preset: inherit/);
  assert.match(text, /maxParallel: 3/);
  assert.match(text, /planGate: false/);
  assert.match(text, /livePanes: false/);
  assert.match(text, /useWorktrees: false/);
  assert.match(text, /maxRunCost: \$25/);
  assert.match(text, /statusWaitSeconds: 60/);
  assert.match(text, /trivial: \(pi default model\) thinking=low/);
  assert.match(text, new RegExp(`review: .* tools=${REVIEW_TOOLS}`));
});

test("describeTiersForPlanning gives decision rules and surfaces custom tiers", () => {
  const text = describeTiersForPlanning(DEFAULT_CONFIG);
  assert.match(text, /cheapest tier/);
  assert.match(text, /trivial: mechanical/);
  assert.doesNotMatch(text, /review/);

  const withCustom = mergeConfig(DEFAULT_CONFIG, { tiers: { docs: { thinking: "low" } } });
  assert.match(describeTiersForPlanning(withCustom), /also available: docs/);
});

function fakeRegistry(available: { provider: string; id: string }[]): ModelRegistry {
  return {
    getAvailable: () => available,
    hasConfiguredAuth: (model: { provider: string }) =>
      available.some((m) => m.provider === model.provider),
    find: (provider: string, id: string) =>
      available.find((m) => m.provider === provider && m.id === id),
    getAll: () => available,
  } as unknown as ModelRegistry;
}

test("resolveTierModel inherits pi default when no model set", () => {
  const result = resolveTierModel("trivial", { thinking: "low" }, fakeRegistry([]));
  assert.deepEqual(result, { ok: true, modelArg: undefined });
});

test("resolveTierModel qualifies bare patterns with an authed provider", () => {
  const registry = fakeRegistry([
    { provider: "opencode", id: "claude-sonnet-5" },
    { provider: "anthropic", id: "claude-fable-5" },
  ]);
  const result = resolveTierModel(
    "standard",
    { model: "claude-sonnet-5", thinking: "medium" },
    registry
  );
  assert.deepEqual(result, { ok: true, modelArg: "opencode/claude-sonnet-5" });
});

test("resolveTierModel prefers the orchestrator's provider when it serves the pattern", () => {
  const registry = fakeRegistry([
    { provider: "github-copilot", id: "claude-fable-5" },
    { provider: "anthropic", id: "claude-fable-5" },
  ]);
  const result = resolveTierModel(
    "complex",
    { model: "claude-fable-5", thinking: "high" },
    registry,
    "anthropic"
  );
  assert.deepEqual(result, { ok: true, modelArg: "anthropic/claude-fable-5" });
});

test("resolveTierModels preserves order, provider preference, and skips unavailable patterns", () => {
  const registry = fakeRegistry([
    { provider: "other", id: "primary-model" },
    { provider: "preferred", id: "primary-model" },
    { provider: "preferred", id: "fallback-model" },
  ]);
  const result = resolveTierModels(
    "standard",
    {
      model: "primary-model",
      fallbacks: ["missing-model", "fallback-model"],
      thinking: "medium",
    },
    registry,
    "preferred"
  );
  assert.deepEqual(result, {
    ok: true,
    modelArgs: ["preferred/primary-model", "preferred/fallback-model"],
  });
});

test("resolveTierModels uses a resolvable fallback and errors only when the whole list is empty", () => {
  const registry = fakeRegistry([{ provider: "authed", id: "working-fallback" }]);
  assert.deepEqual(
    resolveTierModels(
      "standard",
      { model: "missing", fallbacks: ["working-fallback"], thinking: "medium" },
      registry
    ),
    { ok: true, modelArgs: ["authed/working-fallback"] }
  );

  const empty = resolveTierModels(
    "standard",
    { model: "missing", fallbacks: ["also-missing"], thinking: "medium" },
    fakeRegistry([])
  );
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.match(empty.error, /none of the configured models/);
    assert.match(empty.error, /\/login/);
  }

  const emptyFallback = resolveTierModels(
    "standard",
    { model: "missing", fallbacks: [""], thinking: "medium" },
    fakeRegistry([])
  );
  assert.equal(emptyFallback.ok, false);
  if (!emptyFallback.ok) assert.match(emptyFallback.error, /none of the configured models/);
});

test("resolveTierModels preserves inheritance only for an absent primary model", () => {
  assert.deepEqual(
    resolveTierModels("standard", { fallbacks: [""], thinking: "medium" }, fakeRegistry([])),
    { ok: true, modelArgs: [undefined] }
  );
});

test("resolveTierModel fails with an actionable error when nothing is authed", () => {
  const result = resolveTierModel(
    "trivial",
    { model: "gpt-5.6-terra", thinking: "high" },
    fakeRegistry([])
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /no authed provider serves "gpt-5.6-terra"/);
    assert.match(result.error, /\/maestro config/);
  }
});

test("mergeConfig carries attempt, cost, and pulse settings", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    maxAttempts: 5,
    maxCostPerTask: 2,
    maxRunCost: 25,
    statusWaitSeconds: 30,
  });
  assert.equal(merged.maxAttempts, 5);
  assert.equal(merged.maxCostPerTask, 2);
  assert.equal(merged.maxRunCost, 25);
  assert.equal(merged.statusWaitSeconds, 30);
  const untouched = mergeConfig(DEFAULT_CONFIG, {});
  assert.equal(untouched.maxAttempts, DEFAULT_CONFIG.maxAttempts);
  assert.equal(untouched.maxCostPerTask, 5);
  assert.equal(untouched.maxRunCost, 25);
  assert.equal(untouched.statusWaitSeconds, 60);
});

test("validateConfig rejects malformed fields and accepts explicit zero partials", () => {
  assert.equal(
    validateConfig({ maxRunCost: 0, watchdogIdleSeconds: 0, livePanes: false }),
    undefined
  );
  assert.match(validateConfig({ maxParallel: -1 }) ?? "", /maxParallel/);
  assert.match(validateConfig({ logEvents: "verbose" }) ?? "", /logEvents/);
  assert.match(validateConfig({ cleanupCompletedTasks: "yes" }) ?? "", /boolean/);
  assert.match(validateConfig({ livePanes: "yes" }) ?? "", /livePanes must be boolean/);
  assert.match(validateConfig({ reviewRequiredApprovals: 1 }) ?? "", /reviewRequiredApprovals/);
  assert.match(validateConfig({ maxReviewerLaunches: 2.5 }) ?? "", /integer/);
  assert.match(
    validateConfig({ reviewRequiredApprovals: 4, maxReviewerLaunches: 3 }) ?? "",
    /cannot exceed/
  );
  assert.match(
    validateConfig({ maxPlanTasks: 8, maxDiscoveryGeneratedTasks: 9 }) ?? "",
    /maxDiscoveryGeneratedTasks \(9\) cannot exceed maxPlanTasks \(8\)/
  );
  assert.match(
    validateConfig({ maxTotalLaunchesPerRun: 3, maxReviewerLaunches: 4 }) ?? "",
    /maxReviewerLaunches \(4\) cannot exceed maxTotalLaunchesPerRun \(3\)/
  );
  assert.match(
    validateConfig({ maxPlanTasks: 8, confirmationPlanTasks: 9 }) ?? "",
    /confirmationPlanTasks \(9\) cannot exceed maxPlanTasks \(8\)/
  );
  assert.match(validateConfig({ tiers: { "": { thinking: "low" } } }) ?? "", /tier names/);
  assert.match(
    validateConfig({ tiers: { bad: { thinking: "extreme", fallbacks: [3] } } }) ?? "",
    /thinking/
  );
});

test("loadConfig preserves and ignores structurally invalid project config", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-config-invalid-"));
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-config-invalid-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const directory = join(cwd, ".pi");
  const file = join(directory, "maestro.json");
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, JSON.stringify({ maxParallel: "many" }));
    assert.equal(loadConfig(cwd).maxParallel, DEFAULT_CONFIG.maxParallel);
    assert.equal(existsSync(file), false);
    assert.equal(
      readdirSync(directory).filter((name) => /^maestro\.json\.invalid-\d+$/.test(name)).length,
      1
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("loadConfig archives corrupt project config and falls back", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-config-"));
  const baselineCwd = mkdtempSync(join(tmpdir(), "maestro-config-baseline-"));
  const directory = join(cwd, ".pi");
  const file = join(directory, "maestro.json");
  const corruptContents = "{invalid config";
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, corruptContents);

    assert.deepEqual(loadConfig(cwd), loadConfig(baselineCwd));
    assert.equal(existsSync(file), false);

    const archives = readdirSync(directory).filter((name) =>
      /^maestro\.json\.corrupt-\d+$/.test(name)
    );
    assert.equal(archives.length, 1);
    assert.equal(readFileSync(join(directory, archives[0] as string), "utf-8"), corruptContents);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(baselineCwd, { recursive: true, force: true });
  }
});

test("saveConfig writes the scope file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-config-"));
  try {
    saveConfig("project", cwd, DEFAULT_CONFIG);
    const written = JSON.parse(readFileSync(join(cwd, ".pi", "maestro.json"), "utf-8"));
    assert.deepEqual(written, DEFAULT_CONFIG);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadConfig rejects incompatible effective values from individually valid fragments", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-config-effective-invalid-"));
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-config-effective-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const user = { reviewRequiredApprovals: 8 };
    const project = { maxReviewerLaunches: 4 };
    assert.equal(validateConfig(user), undefined);
    assert.equal(validateConfig(project), undefined);
    writeFileSync(join(agentDir, "maestro.json"), JSON.stringify(user));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "maestro.json"), JSON.stringify(project));

    assert.throws(
      () => loadConfig(cwd),
      /effective maestro configuration.*reviewRequiredApprovals \(8\).*maxReviewerLaunches \(4\)/i
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts valid cross-scope override combinations", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-config-effective-valid-"));
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-config-effective-valid-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFileSync(join(agentDir, "maestro.json"), JSON.stringify({ reviewRequiredApprovals: 8 }));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "maestro.json"), JSON.stringify({ maxReviewerLaunches: 8 }));

    const loaded = loadConfig(cwd);
    assert.equal(loaded.reviewRequiredApprovals, 8);
    assert.equal(loaded.maxReviewerLaunches, 8);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("loadConfig resolves defaults, then user, then project, in that precedence order", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-config-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-config-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // No user or project file: defaults apply.
    assert.equal(loadConfig(cwd).maxAttempts, DEFAULT_CONFIG.maxAttempts);

    // User config overrides a default.
    writeFileSync(join(agentDir, "maestro.json"), JSON.stringify({ maxAttempts: 6 }));
    assert.equal(loadConfig(cwd).maxAttempts, 6);

    // Project config overrides the user config for the same field.
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "maestro.json"), JSON.stringify({ maxAttempts: 9 }));
    assert.equal(loadConfig(cwd).maxAttempts, 9);

    // Repository config may select, but never define, executable verification commands.
    writeFileSync(
      join(agentDir, "maestro.json"),
      JSON.stringify({
        maxAttempts: 6,
        verificationProfiles: { trusted: { command: "pnpm test", timeoutSeconds: 60 } },
      })
    );
    writeFileSync(
      join(cwd, ".pi", "maestro.json"),
      JSON.stringify({
        defaultVerificationProfile: "trusted",
        verificationProfiles: { malicious: { command: "touch owned", timeoutSeconds: 60 } },
      })
    );
    const selected = loadConfig(cwd);
    assert.equal(selected.defaultVerificationProfile, "trusted");
    assert.deepEqual(Object.keys(selected.verificationProfiles ?? {}), ["trusted"]);

    // An unknown project selection is ignored instead of becoming executable.
    writeFileSync(
      join(cwd, ".pi", "maestro.json"),
      JSON.stringify({ defaultVerificationProfile: "malicious" })
    );
    assert.equal(loadConfig(cwd).defaultVerificationProfile, undefined);

    // Removing the project override falls back to the user config again.
    rmSync(join(cwd, ".pi", "maestro.json"));
    assert.equal(loadConfig(cwd).maxAttempts, 6);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
