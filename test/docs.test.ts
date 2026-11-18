import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAESTRO_COMMANDS } from "../src/commands.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { projectEvidenceSections } from "../src/dashboard-evidence.js";
import { taskLaunches } from "../src/dashboard-launches.js";
import {
  exampleBoard,
  exampleEvidence,
  exampleLiveKinds,
  exampleNext,
  examplePhases,
  exampleStatusLine,
} from "../src/data/example-board.js";
import { boardUsage, progressBar } from "../src/format.js";
import { projectRunPhases, projectStatus } from "../src/status.js";

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
    ["maxCostPerReview", DEFAULT_CONFIG.maxCostPerReview ?? 0],
    ["reviewCheapModel", DEFAULT_CONFIG.reviewCheapModel ?? "(none)"],
    ["reviewEscalation", DEFAULT_CONFIG.reviewEscalation ?? "risk"],
    ["maxRunCost", DEFAULT_CONFIG.maxRunCost],
    ["reviewRejectionLimit", DEFAULT_CONFIG.reviewRejectionLimit ?? 2],
    ["retryContext", DEFAULT_CONFIG.retryContext ?? "resume"],
    ["statusWaitSeconds", DEFAULT_CONFIG.statusWaitSeconds],
    ["decisionNudgeMinutes", DEFAULT_CONFIG.decisionNudgeMinutes ?? 5],
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
  // Documented commands must be reachable. Nested leaves such as "plan diff"
  // are completed after their parent noun rather than listed up front, so the
  // check is on the parent the menu actually offers.
  for (const command of [
    "retry",
    "timeline",
    "insights",
    "reconcile",
    "plan diff",
    "recipe preview",
    "agents",
    "workflows",
  ]) {
    const parent = command.split(" ")[0] as (typeof MAESTRO_COMMANDS)[number];
    assert.ok(MAESTRO_COMMANDS.includes(parent), `${command} must be reachable`);
    assert.ok(read("README.md").includes(`/maestro ${command}`));
  }
  assert.equal(MAESTRO_COMMANDS.includes("plan compare" as never), false);
  assert.equal(MAESTRO_COMMANDS.includes("watch" as never), false);
  // The first menu a newcomer sees stays short enough to read.
  assert.ok(
    MAESTRO_COMMANDS.length <= 25,
    `top-level menu grew to ${MAESTRO_COMMANDS.length} entries`
  );
  assert.doesNotMatch(read("README.md"), /\/maestro list\b|plan compare|\/maestro watch\b/);
  assert.doesNotMatch(read("docs/operations.md"), /plan compare/);
});

test("documentation explains nested agent sessions and resume navigation", () => {
  const readme = read("README.md");
  const operations = read("docs/operations.md");
  const architecture = read("docs/architecture.md");

  // The docs site renders docs/operations.md, so it cannot drift from it.
  for (const content of [readme, operations]) {
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
    name: string;
    files: string[];
    main: string;
    repository: { url: string };
    homepage: string;
    bugs: { url: string };
    peerDependencies: Record<string, string>;
    publishConfig?: { access?: string };
    scripts: Record<string, string>;
    pi?: { image?: string };
  };
  // The unscoped "pi-maestro" npm name belongs to an unrelated project.
  assert.equal(pkg.name, "@ayagmar/pi-maestro");
  assert.equal(pkg.publishConfig?.access, "public");
  assert.equal(pkg.main, "./src/index.ts");
  assert.equal(pkg.repository.url, "git+https://github.com/ayagmar/pi-maestro.git");
  assert.equal(pkg.homepage, "https://ayagmar.github.io/pi-maestro/");
  assert.equal(pkg.bugs.url, "https://github.com/ayagmar/pi-maestro/issues");
  assert.doesNotMatch(pkg.pi?.image ?? "", /placehold\.co/i);
  for (const entry of [
    "src/",
    "docs/",
    "README.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "LICENSE",
  ]) {
    assert.ok(pkg.files.includes(entry));
  }
  // The Astro docs site lives under src/ but is not part of the extension runtime.
  for (const siteDirectory of ["src/pages/", "src/layouts/", "src/styles/", "src/data/"]) {
    assert.ok(pkg.files.includes(`!${siteDirectory}`), `${siteDirectory} must not be published`);
  }
  assert.equal(existsSync(join(root, pkg.main)), true);
  for (const excluded of [".pi/", "plans/", "test/", "scripts/"]) {
    assert.equal(pkg.files.includes(excluded), false);
  }
  // The smoke test loads the package through the real pi CLI; test/package.test.ts
  // covers the packed file list and the registered model tools.
  assert.match(read("scripts/smoke-test.mjs"), /--mode", "rpc"/);
  for (const script of [
    "typecheck",
    "lint",
    "format:check",
    "test",
    "test:integration",
    "smoke-test",
  ]) {
    assert.match(pkg.scripts.check ?? "", new RegExp(`pnpm run ${script}(?: |$)`));
  }
  // Pi provides its own packages at runtime; peers must accept whatever host version loads us.
  assert.ok(Object.values(pkg.peerDependencies).every((range) => range === "*"));
});

test("supported pi line in user docs matches the pi devDependency", () => {
  const pkg = JSON.parse(read("package.json")) as { devDependencies: Record<string, string> };
  const range = pkg.devDependencies["@earendil-works/pi-coding-agent"] ?? "";
  const [major, minor] = range.replace(/^[^\d]*/, "").split(".");
  const line = `\`${major}.${minor}.x\``;
  for (const doc of ["README.md", "SECURITY.md"]) {
    const text = read(doc);
    assert.ok(text.includes(line), `${doc} must name the tested pi line ${line}`);
    // Pi's pre-1.0 lines were 0.5x through 0.8x.
    assert.doesNotMatch(text, /`0\.[5-9]\d\.x`/, `${doc} still names a pre-1.0 pi line`);
  }
});

test("README, getting started, and the landing page lead with the working Git install", () => {
  const install = "pi install git:github.com/ayagmar/pi-maestro";
  const npm = "pi install npm:@ayagmar/pi-maestro";
  const commands = read("src/data/install.ts");
  assert.ok(commands.includes(`"${install}"`));
  assert.ok(commands.includes(`"${npm}"`));
  for (const doc of ["README.md", "docs/getting-started.md"]) {
    const text = read(doc);
    assert.ok(text.includes(install), `${doc} must show ${install}`);
    // The npm command stays documented, but after the working source and as unpublished.
    assert.ok(text.indexOf(install) < text.indexOf(npm), `${doc} must lead with the Git source`);
    assert.match(text, /not (?:on npm|published to npm) yet/, `${doc} must say npm is unpublished`);
  }
  const landing = read("src/pages/index.astro");
  assert.match(landing, /data-copy=\{installCommand\}/);
  assert.doesNotMatch(landing, /data-copy="pi install npm:/);
  assert.match(landing, /does not exist there yet/);
});

test("the landing example board shows what the extension projects for it", () => {
  const phases = projectRunPhases(exampleBoard, exampleLiveKinds);
  const status = projectStatus(exampleBoard, ["T2"], undefined, exampleLiveKinds);
  const progress = progressBar(status.approved, status.total);
  const cost = boardUsage(exampleBoard.tasks).cost.toFixed(2);
  assert.equal(
    exampleStatusLine,
    `⚡ maestro ${status.code} · ${status.phase} · ${progress} · ${status.running} running · $${cost}`
  );
  assert.deepEqual(
    examplePhases,
    phases.map((phase) => ({
      label: phase.label,
      // The labels the dashboard gives a phase.
      state: phase.current
        ? "current"
        : phase.taskIds.length > 0
          ? "retained evidence"
          : "no evidence",
      tasks: phase.taskIds.join(", ") || "none",
    }))
  );
  const task = exampleBoard.tasks.find((item) => item.id === "T2");
  assert.ok(task);
  const launch = taskLaunches(task).find((item) => item.kind === "review");
  const review = projectEvidenceSections(task, launch, { phaseLabel: "execution" }).find(
    (section) => section.title === "Review"
  );
  assert.deepEqual(
    review?.lines.filter((line) => !line.startsWith("Review usage")),
    exampleEvidence.lines
  );
  // The dashboard's Next lines are private to its renderer, so check the shipped source.
  const dashboard = read("src/dashboard.ts");
  assert.ok(dashboard.includes(exampleNext.live));
  assert.ok(dashboard.includes(exampleNext.stopped));
});

test("every markdown guide is a docs site page and the site keeps no copy of it", () => {
  const site = read("src/data/docs.ts");
  for (const guide of [
    "getting-started",
    "how-it-works",
    "commands",
    "configuration",
    "operations",
    "architecture",
  ]) {
    assert.ok(site.includes(`file: "docs/${guide}.md"`), `docs/${guide}.md must be a site page`);
    assert.equal(
      existsSync(join(root, `src/pages/docs/${guide}.astro`)),
      false,
      `${guide} must be rendered from markdown, not duplicated in an .astro page`
    );
  }
  for (const [slug, file] of [
    ["security", "SECURITY.md"],
    ["contributing", "CONTRIBUTING.md"],
    ["changelog", "CHANGELOG.md"],
  ]) {
    assert.match(site, new RegExp(`slug: "${slug}"[\\s\\S]*?file: "${file}"`));
  }
});
