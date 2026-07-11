import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";
import {
  applySettingsChange,
  buildModelChoices,
  buildModelPickerChoices,
  filterModelChoices,
} from "../src/settings-ui.js";

function registryWithModels(
  models: Array<{ provider: string; id: string }>
): ExtensionCommandContext["modelRegistry"] {
  return {
    getAvailable: () => models,
  } as unknown as ExtensionCommandContext["modelRegistry"];
}

test("settings model choices display provider-qualified authenticated models", () => {
  const choices = buildModelChoices(
    registryWithModels([
      { provider: "provider-b", id: "zeta" },
      { provider: "provider-a", id: "alpha" },
      { provider: "provider-c", id: "zeta" },
      { provider: "provider-b", id: "zeta" },
    ])
  );

  assert.deepEqual(choices.model, [
    "(pi default)",
    "provider-a/alpha",
    "provider-b/zeta",
    "provider-c/zeta",
  ]);
  assert.deepEqual(choices.fallback, [
    "(none)",
    "provider-a/alpha",
    "provider-b/zeta",
    "provider-c/zeta",
  ]);
});

test("settings model filtering matches provider, model id, and sentinels", () => {
  const choices = ["(pi default)", "anthropic/claude-sonnet-5", "openai/gpt-5.6-sol"];

  assert.deepEqual(filterModelChoices(choices, "claude"), ["anthropic/claude-sonnet-5"]);
  assert.deepEqual(filterModelChoices(choices, "OPENAI"), ["openai/gpt-5.6-sol"]);
  assert.deepEqual(filterModelChoices(choices, "default"), ["(pi default)"]);
  assert.deepEqual(filterModelChoices(choices, ""), choices);
});

test("picker selects bare primary and fallback values without qualifying them", () => {
  const registry = registryWithModels([
    { provider: "openai", id: "gpt-5.6-sol" },
    { provider: "proxy", id: "gpt-5.6-sol" },
    { provider: "anthropic", id: "claude-sonnet-5" },
  ]);
  const choices = buildModelChoices(registry);

  const standard = { model: "gpt-5.6-sol", thinking: "medium", fallbacks: ["claude-sonnet-5"] };

  const primaryItems = buildModelPickerChoices(registry, choices.model, standard.model, "openai");
  const fallbackItems = buildModelPickerChoices(
    registry,
    choices.fallback,
    standard.fallbacks[0] as string,
    "openai"
  );

  assert.deepEqual(
    primaryItems.find((item) => item.value === standard.model),
    {
      value: "gpt-5.6-sol",
      label: "openai/gpt-5.6-sol",
    }
  );
  assert.deepEqual(
    fallbackItems.find((item) => item.value === standard.fallbacks?.[0]),
    {
      value: "claude-sonnet-5",
      label: "anthropic/claude-sonnet-5",
    }
  );
  assert.equal(primaryItems.filter((item) => item.label === "openai/gpt-5.6-sol").length, 1);
  assert.ok(primaryItems.some((item) => item.value === "proxy/gpt-5.6-sol"));

  const config = structuredClone(DEFAULT_CONFIG);
  applySettingsChange(config, "model:standard", standard.model);
  applySettingsChange(config, "fallback:standard", standard.fallbacks[0] as string);
  assert.equal(config.tiers.standard?.model, "gpt-5.6-sol");
  assert.equal(config.tiers.standard?.fallbacks?.[0], "claude-sonnet-5");
});

test("settings model choices retain static menus when no authenticated models are available", () => {
  const choices = buildModelChoices(registryWithModels([]));

  assert.deepEqual(choices.model, [
    "(pi default)",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "claude-haiku-4-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-fable-5",
  ]);
  assert.deepEqual(choices.fallback, [
    "(none)",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ]);
});

test("model picker changes preserve qualified values, sentinels, and fallback chains", () => {
  let config = structuredClone(DEFAULT_CONFIG);
  const standard = config.tiers.standard;
  assert.ok(standard);
  standard.fallbacks = ["old-primary", "provider-c/last-resort"];

  config = applySettingsChange(config, "model:standard", "provider-a/shared-id");
  config = applySettingsChange(config, "fallback:standard", "provider-b/shared-id");
  assert.equal(config.tiers.standard?.model, "provider-a/shared-id");
  assert.deepEqual(config.tiers.standard?.fallbacks, [
    "provider-b/shared-id",
    "provider-c/last-resort",
  ]);

  config = applySettingsChange(config, "model:standard", "(pi default)");
  config = applySettingsChange(config, "fallback:standard", "(none)");
  assert.equal(config.tiers.standard?.model, undefined);
  assert.deepEqual(config.tiers.standard?.fallbacks, ["provider-c/last-resort"]);
});

test("settings changes preserve existing values and persist provider-qualified selections", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-settings-"));
  try {
    let config = structuredClone(DEFAULT_CONFIG);
    config = applySettingsChange(config, "planGate", "on");
    config = applySettingsChange(config, "maxParallel", "6");
    config = applySettingsChange(config, "maxCostPerTask", "$5");
    config = applySettingsChange(config, "model:complex", "anthropic/claude-sonnet-5");
    saveConfig("project", cwd, config);

    const persisted = JSON.parse(readFileSync(join(cwd, ".pi", "maestro.json"), "utf-8"));
    assert.equal(persisted.planGate, true);
    assert.equal(persisted.maxParallel, 6);
    assert.equal(persisted.maxCostPerTask, 5);
    assert.equal(persisted.autoCommit, DEFAULT_CONFIG.autoCommit);
    assert.equal(persisted.tiers.complex.model, "anthropic/claude-sonnet-5");
    assert.equal(persisted.tiers.review.tools, DEFAULT_CONFIG.tiers.review?.tools);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
