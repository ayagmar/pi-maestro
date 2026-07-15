import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createTask, saveBoard } from "../src/board.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildDoctorReport } from "../src/diagnostics.js";
import { createWorktree } from "../src/worktree.js";

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

test("doctor reports the live reviewer phase", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-doctor-"));
  try {
    const board = { version: 1 as const, nextTaskNumber: 1, tasks: [] };
    const task = createTask(board, { title: "Review", brief: "inspect", tier: "standard" });
    task.status = "ready_for_review";
    saveBoard(cwd, board);

    const report = buildDoctorReport(
      cwd,
      fakeRegistry([]),
      undefined,
      new Set([task.id]),
      new Map([[task.id, "review"]])
    );

    assert.match(report, /Status: running · review/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("doctor reports quarantined corrupt boards", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-doctor-"));
  try {
    const directory = join(cwd, ".pi", "maestro");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "board.json.corrupt-123"), "{");
    const report = buildDoctorReport(cwd, fakeRegistry([]));
    assert.match(report, /board\.json\.corrupt-123/);
    assert.match(report, /Restore an archive with \/maestro replay/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("doctor reports the user config's attempt cap when no project file overrides it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-doctor-"));
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-doctor-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFileSync(join(agentDir, "maestro.json"), JSON.stringify({ maxAttempts: 6 }));

    const report = buildDoctorReport(cwd, fakeRegistry([]));

    assert.match(report, /project: .*\(not present\)/);
    assert.match(report, /attempts: 6/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
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

test("doctor reports orphaned worktrees and confirmed cleanup guidance", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-doctor-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd });
    const orphaned = createWorktree(cwd, "orphan", 1);

    const report = buildDoctorReport(cwd, fakeRegistry([]));

    assert.match(report, /orphaned:/);
    assert.match(report, new RegExp(orphaned.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(report, /\/maestro doctor cleanup/);
    assert.match(report, /after confirmation/);
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
