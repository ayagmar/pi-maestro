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
  assert.match(readme, /maestro_update.*invalidateInFlight/s);
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
    "no_progress",
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
    ["livePanes", DEFAULT_CONFIG.livePanes],
    ["useWorktrees", DEFAULT_CONFIG.useWorktrees],
    ["detachedExecutors", DEFAULT_CONFIG.detachedExecutors ?? false],
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
    "insights",
    "reconcile",
    "plan diff",
    "recipe preview",
    "agents",
    "workflows",
  ] as const) {
    assert.ok(MAESTRO_COMMANDS.includes(command));
    assert.ok(read("README.md").includes(`/maestro ${command}`));
  }
  assert.equal(MAESTRO_COMMANDS.includes("plan compare" as never), false);
  assert.equal(MAESTRO_COMMANDS.includes("watch" as never), false);
  assert.equal(MAESTRO_COMMANDS.length, 40);
  assert.doesNotMatch(read("README.md"), /\/maestro list\b|plan compare|\/maestro watch\b/);
  assert.doesNotMatch(read("docs/operations.md"), /plan compare/);
});

test("documentation explains nested agent sessions and resume navigation", () => {
  const readme = read("README.md");
  const operations = read("docs/operations.md");
  const architecture = read("docs/architecture.md");
  const siteOperations = read("src/pages/docs/operations.astro");

  for (const content of [readme, operations, siteOperations]) {
    assert.match(content, /\.maestro.*launch/is);
    assert.match(content, /\/maestro back/is);
    assert.match(content, /usage.*recurs|recurs.*usage/is);
  }
  assert.match(architecture, /unique `--session-dir`/i);
  assert.match(architecture, /ordinary session picker is\s+non-recursive/i);
  assert.doesNotMatch(readme, /\/resume` and usage reports include them/i);
});

test("documentation matches review fallback, reset, and settled-task behavior", () => {
  const readme = read("README.md");
  assert.match(readme, /review launches use the same\s+provider-failure fallback rules/i);
  assert.doesNotMatch(readme, /review runs currently use its primary `model` only/i);
  assert.match(readme, /non-interactive.*reset confirm/is);
  assert.match(readme, /approved and cancelled tasks are settled/i);
  assert.match(read("docs/configuration.md"), /effective configuration.*after.*merg/is);
});

test("declared package shape contains runtime and required documentation", () => {
  const pkg = JSON.parse(read("package.json")) as {
    files: string[];
    main: string;
    repository: { url: string };
    homepage: string;
    bugs: string;
    peerDependencies: Record<string, string>;
    scripts: Record<string, string>;
    pi?: { image?: string };
  };
  assert.equal(pkg.main, "./src/index.ts");
  assert.equal(pkg.repository.url, "git+https://github.com/ayagmar/pi-maestro.git");
  assert.equal(pkg.homepage, "https://github.com/ayagmar/pi-maestro#readme");
  assert.equal(pkg.bugs, "https://github.com/ayagmar/pi-maestro/issues");
  assert.doesNotMatch(pkg.pi?.image ?? "", /placehold\.co/i);
  for (const entry of [
    "src/",
    "docs/",
    "README.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "SECURITY.md",
  ]) {
    assert.ok(pkg.files.includes(entry));
  }
  assert.equal(existsSync(join(root, pkg.main)), true);
  for (const excluded of [".pi/", "plans/", "test/", "scripts/"]) {
    assert.equal(pkg.files.includes(excluded), false);
  }
  assert.match(read("scripts/smoke-test.mjs"), /registers exactly three model tools/);
  assert.match(pkg.scripts.check ?? "", /package-smoke-test/);
  assert.ok(Object.values(pkg.peerDependencies).every((range) => range !== "*"));
});
