import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAESTRO_COMMANDS } from "../src/commands.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");

test("README onboarding links and exact model tools are documented", () => {
  const readme = read("README.md");
  for (const heading of [
    "## Five-minute start",
    "## Guides",
    "## Limitations and trust boundaries",
  ]) {
    assert.match(readme, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const path of [
    "docs/configuration.md",
    "docs/operations.md",
    "docs/architecture.md",
    "CONTRIBUTING.md",
  ]) {
    assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
  }
  const architecture = read("docs/architecture.md");
  assert.match(architecture, /maestro_plan.*maestro_update.*maestro_drive/s);
});

test("operations documents every drive stop and failure kind", () => {
  const operations = read("docs/operations.md");
  const terms = [
    "completed",
    "aborted",
    "paused",
    "plan_gate",
    "budget_blocked",
    "provider_blocked",
    "escalation_required",
    "attempt_cap",
    "blocked",
    "round_limit",
    "error",
    "provider_failure",
    "stalled",
    "executor_failure",
    "reviewer_rejection",
    "reviewer_failure",
    "review_disagreement",
    "launch_limit",
    "stale_completion",
    "user_abort",
    "cost_cap",
  ];
  for (const term of terms) assert.match(operations, new RegExp(`\\b${term}\\b`));
});

test("configuration docs match runtime defaults and commands remain documented", () => {
  const config = read("docs/configuration.md");
  const defaults: Array<[string, string | number | boolean]> = [
    ["maxParallel", DEFAULT_CONFIG.maxParallel],
    ["planGate", DEFAULT_CONFIG.planGate],
    ["useWorktrees", DEFAULT_CONFIG.useWorktrees],
    ["autoCommit", DEFAULT_CONFIG.autoCommit],
    ["maxAttempts", DEFAULT_CONFIG.maxAttempts],
    ["maxPlanTasks", DEFAULT_CONFIG.maxPlanTasks],
    ["maxDiscoveryGeneratedTasks", DEFAULT_CONFIG.maxDiscoveryGeneratedTasks],
    ["maxTotalLaunchesPerRun", DEFAULT_CONFIG.maxTotalLaunchesPerRun],
    ["confirmationPlanTasks", DEFAULT_CONFIG.confirmationPlanTasks],
    ["confirmationTotalLaunches", DEFAULT_CONFIG.confirmationTotalLaunches],
    ["reviewRequiredApprovals", DEFAULT_CONFIG.reviewRequiredApprovals],
    ["maxReviewerLaunches", DEFAULT_CONFIG.maxReviewerLaunches],
    ["maxCostPerTask", DEFAULT_CONFIG.maxCostPerTask],
    ["maxRunCost", DEFAULT_CONFIG.maxRunCost],
    ["statusWaitSeconds", DEFAULT_CONFIG.statusWaitSeconds],
    ["logEvents", DEFAULT_CONFIG.logEvents ?? "compact"],
    ["maxLogBytesPerRun", DEFAULT_CONFIG.maxLogBytesPerRun ?? 1_000_000],
    ["watchdogIdleSeconds", DEFAULT_CONFIG.watchdogIdleSeconds ?? 120],
    ["watchdogWarningTurns", DEFAULT_CONFIG.watchdogWarningTurns ?? 12],
    ["watchdogTerminationTurns", DEFAULT_CONFIG.watchdogTerminationTurns ?? 4],
    ["handoffContextRatio", DEFAULT_CONFIG.handoffContextRatio ?? 0.68],
    ["cleanupCompletedTasks", DEFAULT_CONFIG.cleanupCompletedTasks ?? true],
  ];
  const plainConfig = config.replaceAll("`", "");
  for (const [key, value] of defaults) {
    assert.ok(plainConfig.includes(`| ${key} | ${String(value)} |`));
  }
  for (const command of [
    "retry",
    "timeline",
    "reconcile",
    "plan diff",
    "plan compare",
    "recipe preview",
  ] as const) {
    assert.ok(MAESTRO_COMMANDS.includes(command));
    assert.ok(read("README.md").includes(`/maestro ${command}`));
  }
});

test("declared package shape contains runtime and required documentation", () => {
  const pkg = JSON.parse(read("package.json")) as { files: string[]; main: string };
  assert.equal(pkg.main, "./src/index.ts");
  for (const entry of ["src/", "docs/", "README.md", "CONTRIBUTING.md"]) {
    assert.ok(pkg.files.includes(entry));
  }
  assert.equal(existsSync(join(root, pkg.main)), true);
  for (const excluded of [".pi/", "plans/", "test/", "scripts/"]) {
    assert.equal(pkg.files.includes(excluded), false);
  }
  assert.match(read("scripts/smoke-test.mjs"), /registers exactly three model tools/);
});
