import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildDoctorReport } from "../src/diagnostics.js";

function fakeRegistry(available: { provider: string; id: string }[]): ModelRegistry {
  return {
    getAvailable: () => available,
    hasConfiguredAuth: (model: { provider: string }) =>
      available.some((candidate) => candidate.provider === model.provider),
    find: (provider: string, id: string) =>
      available.find((model) => model.provider === provider && model.id === id),
    getAll: () => available,
  } as unknown as ModelRegistry;
}

test("doctor reports config, effective settings, inherited models, and git guidance", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-doctor-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "maestro.json"), JSON.stringify(DEFAULT_CONFIG));
    const report = buildDoctorReport(cwd, fakeRegistry([]), {
      provider: "authenticated-provider",
      id: "current-model",
    });

    assert.match(report, /Config \(defaults → user → project\)/);
    assert.match(report, /effective preset: inherit/);
    assert.match(report, /plan gate: off · attempts: 3 · parallelism: 3/);
    assert.match(report, /primary: available via authenticated-provider\/current-model/);
    assert.match(report, /not a git repository with an initial commit/);
    assert.doesNotMatch(report, /api.?key\s*[:=]/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("doctor reports invalid config and unavailable primary and fallback models", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-doctor-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "maestro.json"), "{invalid");

    const report = buildDoctorReport(cwd, fakeRegistry([]));

    assert.match(report, /maestro\.json \(INVALID JSON/);
    assert.match(report, /normally archives it on load/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("doctor shows resolved primary and fallback availability", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-doctor-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "maestro.json"),
      JSON.stringify({
        tiers: {
          standard: {
            model: "primary",
            fallbacks: ["missing", "fallback"],
            thinking: "medium",
          },
        },
      })
    );
    const report = buildDoctorReport(
      cwd,
      fakeRegistry([
        { provider: "provider", id: "primary" },
        { provider: "provider", id: "fallback" },
      ])
    );

    assert.match(report, /✓ primary "primary": available as provider\/primary/);
    assert.match(report, /✗ fallback 1 "missing": unavailable/);
    assert.match(report, /no authed provider serves "missing"/);
    assert.match(report, /Run \/login or pick another model/);
    assert.match(report, /✓ fallback 2 "fallback": available as provider\/fallback/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
