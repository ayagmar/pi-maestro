import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildModelChoices } from "../src/settings-ui.js";

function registryWithModels(
  models: Array<{ provider: string; id: string }>
): ExtensionCommandContext["modelRegistry"] {
  return {
    getAvailable: () => models,
  } as unknown as ExtensionCommandContext["modelRegistry"];
}

test("settings model choices use sorted unique available model ids after each sentinel", () => {
  const choices = buildModelChoices(
    registryWithModels([
      { provider: "provider-b", id: "zeta" },
      { provider: "provider-a", id: "alpha" },
      { provider: "provider-c", id: "zeta" },
    ])
  );

  assert.deepEqual(choices.model, ["(pi default)", "alpha", "zeta"]);
  assert.deepEqual(choices.fallback, ["(none)", "alpha", "zeta"]);
});

test("settings model choices retain static menus when no authenticated models are available", () => {
  const choices = buildModelChoices(registryWithModels([]));

  assert.deepEqual(choices.model, [
    "(pi default)",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "claude-sonnet-5",
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
