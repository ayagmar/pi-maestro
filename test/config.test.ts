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
  assert.equal(DEFAULT_CONFIG.useWorktrees, false);
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
    assert.equal(preset.config.useWorktrees, false, `preset ${preset.name}`);
    assert.equal(preset.config.tiers.review?.tools, REVIEW_TOOLS, `preset ${preset.name}`);
    assert.ok(preset.description.length > 0, `preset ${preset.name} needs a description`);
  }
});

test("findPreset and matchingPreset round-trip", () => {
  const balanced = findPreset("balanced");
  assert.ok(balanced);
  assert.equal(matchingPreset(balanced.config), "balanced");
  assert.equal(matchingPreset(DEFAULT_CONFIG), "inherit");
  const custom = mergeConfig(DEFAULT_CONFIG, { maxParallel: 7 });
  assert.equal(matchingPreset(custom), "custom");
});

test("describeConfig lists preset name and every tier", () => {
  const text = describeConfig(DEFAULT_CONFIG);
  assert.match(text, /preset: inherit/);
  assert.match(text, /maxParallel: 3/);
  assert.match(text, /useWorktrees: false/);
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

test("mergeConfig carries attempt and cost caps", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { maxAttempts: 5, maxCostPerTask: 2 });
  assert.equal(merged.maxAttempts, 5);
  assert.equal(merged.maxCostPerTask, 2);
  const untouched = mergeConfig(DEFAULT_CONFIG, {});
  assert.equal(untouched.maxAttempts, DEFAULT_CONFIG.maxAttempts);
  assert.equal(untouched.maxCostPerTask, 0);
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
