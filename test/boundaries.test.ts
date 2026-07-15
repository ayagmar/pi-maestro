import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = join(testDirectory, "..", "src");
const rootDirectory = join(testDirectory, "..");

function sourceFiles(): { name: string; contents: string }[] {
  return readdirSync(sourceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => ({
      name: entry.name,
      contents: readFileSync(join(sourceDirectory, entry.name), "utf-8"),
    }));
}

function violatingFiles(
  files: { name: string; contents: string }[],
  allowedFile: string,
  pattern: RegExp
): string[] {
  return files
    .filter((file) => file.name !== allowedFile && pattern.test(file.contents))
    .map((file) => file.name);
}

test("only runner spawns child processes", () => {
  const files = sourceFiles();
  const spawnCall = /\bspawn\s*\(/;

  assert.match(
    files.find((file) => file.name === "runner.ts")?.contents ?? "",
    spawnCall,
    "src/runner.ts must contain the allowed spawn() call"
  );
  const violations = violatingFiles(files, "runner.ts", spawnCall);
  assert.deepEqual(
    violations,
    [],
    `Only src/runner.ts may call spawn(); violations: ${violations.join(", ")}`
  );
});

test("only worktree executes git commands", () => {
  const files = sourceFiles();
  const gitExecution = /\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*["']git["']/;

  assert.match(
    files.find((file) => file.name === "worktree.ts")?.contents ?? "",
    gitExecution,
    "src/worktree.ts must contain the allowed git execution"
  );
  const violations = violatingFiles(files, "worktree.ts", gitExecution);
  assert.deepEqual(
    violations,
    [],
    `Only src/worktree.ts may execute git commands; violations: ${violations.join(", ")}`
  );
});

test("only runner and worktree import child process APIs", () => {
  const childProcessImport = /(?:from|import\s*\()\s*["']node:child_process["']/;
  const violations = sourceFiles()
    .filter(
      (file) =>
        file.name !== "runner.ts" &&
        file.name !== "worktree.ts" &&
        childProcessImport.test(file.contents)
    )
    .map((file) => file.name);
  assert.deepEqual(violations, []);
});

test("only board owns the board persistence name", () => {
  const files = sourceFiles();
  const boardPersistenceName = /\bBOARD_FILE\b|board\.json/;

  assert.match(
    files.find((file) => file.name === "board.ts")?.contents ?? "",
    boardPersistenceName,
    "src/board.ts must define the board persistence name"
  );
  const violations = violatingFiles(files, "board.ts", boardPersistenceName);
  assert.deepEqual(
    violations,
    [],
    `Only src/board.ts may reference BOARD_FILE or board.json; violations: ${violations.join(", ")}`
  );
});

test("pure policy modules do not import Pi, TUI, process, runner, or Git adapters", () => {
  const pureFiles = new Set([
    "artifact-policy.ts",
    "dashboard-evidence.ts",
    "dashboard-launches.ts",
    "plan-review.ts",
    "plan-serialization.ts",
    "status.ts",
    "timeline.ts",
    "workflow-policy.ts",
  ]);
  const forbidden = /@earendil-works\/pi-|node:child_process|\.\/runner\.js|\.\/worktree\.js/;
  const violations = sourceFiles()
    .filter((file) => pureFiles.has(file.name) && forbidden.test(file.contents))
    .map((file) => file.name);
  assert.deepEqual(violations, []);
});

test("dashboard session IO lives outside the dashboard controller", () => {
  const dashboard = sourceFiles().find((file) => file.name === "dashboard.ts")?.contents ?? "";
  assert.doesNotMatch(dashboard, /node:fs|SessionManager|buildSessionContext/);

  const livePane = sourceFiles().find((file) => file.name === "live-pane.ts")?.contents ?? "";
  assert.match(livePane, /SessionManager/);
});

test("plan command UI and mutations live outside the extension root", () => {
  const files = sourceFiles();
  const extension = files.find((file) => file.name === "extension.ts")?.contents ?? "";
  assert.doesNotMatch(extension, /applyPlanTaskEdits|new SelectList|new Editor|approvePlan\(/);

  const commandUi = files.find((file) => file.name === "command-ui.ts")?.contents ?? "";
  assert.match(commandUi, /new SelectList/);
  assert.match(commandUi, /new Editor/);

  const planEditor = files.find((file) => file.name === "plan-task-editor.ts")?.contents ?? "";
  assert.match(planEditor, /applyPlanTaskEdits/);

  const planReview =
    files.find((file) => file.name === "plan-review-controller.ts")?.contents ?? "";
  assert.match(planReview, /approvePlan\(/);
});

test("workflow and task browsers own their command coordination", () => {
  const files = sourceFiles();
  const extension = files.find((file) => file.name === "extension.ts")?.contents ?? "";
  assert.doesNotMatch(extension, /workflowMarkdown|showTaskActions/);

  const workflowBrowser = files.find((file) => file.name === "workflow-browser.ts")?.contents ?? "";
  assert.match(workflowBrowser, /saveRecipeFromBoard/);
  assert.match(workflowBrowser, /replaceBoardWithArchive/);

  const taskBrowser = files.find((file) => file.name === "task-browser.ts")?.contents ?? "";
  assert.match(taskBrowser, /humanRetryEligibility/);
  assert.match(taskBrowser, /pruneTaskLogs/);
});

test("drive preflight, summaries, and manual approval live outside the extension root", () => {
  const files = sourceFiles();
  const extension = files.find((file) => file.name === "extension.ts")?.contents ?? "";
  assert.doesNotMatch(
    extension,
    /function validateDriveStart|function confirmDriveScale|function formatDrivePulse|function manuallyApproveTask/
  );

  const preflight = files.find((file) => file.name === "drive-preflight.ts")?.contents ?? "";
  assert.match(preflight, /function validateDriveStart/);
  assert.match(preflight, /function confirmDriveScale/);

  const summary = files.find((file) => file.name === "drive-summary.ts")?.contents ?? "";
  assert.match(summary, /function formatDrivePulse/);

  const approval = files.find((file) => file.name === "manual-approval.ts")?.contents ?? "";
  assert.match(approval, /captureApprovedProvenance/);
  assert.match(approval, /snapshotArtifact/);
});

test("command completion caching lives outside the extension root", () => {
  const files = sourceFiles();
  const extension = files.find((file) => file.name === "extension.ts")?.contents ?? "";
  assert.doesNotMatch(extension, /completionBoard|completionRecipes|COMPLETION_CACHE_MS/);

  const completions = files.find((file) => file.name === "command-completions.ts")?.contents ?? "";
  assert.match(completions, /class MaestroCommandCompletions/);
  assert.match(completions, /loadBoard/);
  assert.match(completions, /loadRecipeListings/);
});

test("session navigation state lives outside the extension root", () => {
  const files = sourceFiles();
  const extension = files.find((file) => file.name === "extension.ts")?.contents ?? "";
  assert.doesNotMatch(extension, /let previousSession|function switchWithReturn/);

  const navigator = files.find((file) => file.name === "session-navigator.ts")?.contents ?? "";
  assert.match(navigator, /class SessionNavigator/);
  assert.match(navigator, /private previousSession/);
  assert.match(navigator, /sessionSwitchBlocked/);
});

test("index is a composition entry point and adapters own registrations", () => {
  const files = sourceFiles();
  const index = files.find((file) => file.name === "index.ts")?.contents ?? "";
  assert.ok(index.split("\n").length <= 10, "src/index.ts must remain a small composition root");
  assert.doesNotMatch(index, /registerTool|registerCommand|newSession/);

  const toolRegistrations = files
    .filter((file) => /\.registerTool\s*</.test(file.contents))
    .map((file) => file.name);
  assert.deepEqual(toolRegistrations, ["tools.ts"]);
  const commandRegistrations = files
    .filter((file) => /\.registerCommand\s*\(/.test(file.contents))
    .map((file) => file.name);
  assert.deepEqual(commandRegistrations, ["commands.ts"]);
  const sessionReplacement = files
    .filter((file) => /\.newSession\s*\(/.test(file.contents))
    .map((file) => file.name);
  assert.deepEqual(sessionReplacement, ["handoff.ts"]);
});

test("board-facing modules do not depend on the coding agent", () => {
  const codingAgentImport =
    /\bfrom\s*["']@earendil-works\/pi-coding-agent["']|\bimport\s*(?:\(\s*)?["']@earendil-works\/pi-coding-agent["']/;
  const protectedFiles = new Set(["board.ts", "format.ts", "prompts.ts", "transcript.ts"]);
  const violations = sourceFiles()
    .filter((file) => protectedFiles.has(file.name) && codingAgentImport.test(file.contents))
    .map((file) => file.name);

  assert.deepEqual(
    violations,
    [],
    `Board-facing modules must not import @earendil-works/pi-coding-agent; violations: ${violations.join(", ")}`
  );
});

test("the model surface remains exactly three named tools", () => {
  const tools = readFileSync(join(sourceDirectory, "tools.ts"), "utf-8");
  const names = [...tools.matchAll(/name:\s*"(maestro_[a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(names)].sort(), ["maestro_drive", "maestro_plan", "maestro_update"]);
  assert.equal((tools.match(/\.registerTool\s*</g) ?? []).length, 3);
});

test("package shape adds no runtime dependency, database, analytics, plugin, or policy framework", () => {
  const pkg = JSON.parse(readFileSync(join(rootDirectory, "package.json"), "utf-8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(pkg.dependencies ?? {}, {});
  const forbiddenDependency = /sqlite|prisma|typeorm|sequelize|analytics|telemetry|plugin|policy/i;
  assert.deepEqual(
    Object.keys(pkg.dependencies ?? {}).filter((name) => forbiddenDependency.test(name)),
    []
  );
  for (const directory of ["database", "analytics", "plugins", "policies"]) {
    assert.equal(
      readdirSync(rootDirectory, { withFileTypes: true }).some(
        (entry) => entry.isDirectory() && entry.name === directory
      ),
      false
    );
  }
});

test("repository config and recipes cannot introduce executable commands", () => {
  const config = readFileSync(join(sourceDirectory, "config.ts"), "utf-8");
  const recipes = readFileSync(join(sourceDirectory, "recipes.ts"), "utf-8");
  assert.match(config, /verificationProfiles:\s*_ignoredCommands/);
  const taskKeys = recipes.match(/const TASK_KEYS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assert.doesNotMatch(taskKeys, /command|script|hook|executable/);
});

test("empty attributed paths are explicit no-op staging", () => {
  const worktree = readFileSync(join(sourceDirectory, "worktree.ts"), "utf-8");
  assert.match(worktree, /function commitAll[\s\S]*if \(paths\?\.length === 0\) return false;/);
  assert.match(worktree, /function captureDiff[\s\S]*if \(paths\?\.length === 0\) return "";/);
});
