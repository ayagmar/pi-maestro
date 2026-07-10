import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, describeConfig, mergeConfig } from "../src/config.js";

test("mergeConfig without override returns base", () => {
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, undefined), DEFAULT_CONFIG);
});

test("mergeConfig overrides maxParallel and merges tiers", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    maxParallel: 5,
    tiers: { standard: { model: "openai/gpt-5-mini", thinking: "low" } },
  });
  assert.equal(merged.maxParallel, 5);
  assert.equal(merged.tiers.standard?.model, "openai/gpt-5-mini");
  assert.equal(merged.tiers.standard?.thinking, "low");
  // Untouched tiers survive
  assert.equal(merged.tiers.complex?.thinking, "high");
  assert.equal(merged.tiers.review?.tools, "read,bash,grep,find,ls");
});

test("default config has the documented tiers", () => {
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.tiers).sort(), [
    "complex",
    "review",
    "standard",
    "trivial",
  ]);
  assert.equal(DEFAULT_CONFIG.maxParallel, 3);
});

test("describeConfig lists every tier", () => {
  const text = describeConfig(DEFAULT_CONFIG);
  assert.match(text, /maxParallel: 3/);
  assert.match(text, /trivial: \(pi default model\) thinking=low/);
  assert.match(text, /review: .* tools=read,bash,grep,find,ls/);
});
