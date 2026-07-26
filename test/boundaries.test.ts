import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Capability boundaries that source text is the only practical way to check:
 * which modules may spawn processes, execute Git, or own persistence, plus the
 * shape of the published package.
 *
 * These deliberately do not assert where ordinary functions live. Such checks
 * pass on completely broken code — gutting a function while keeping its name
 * left all of them green — so they only taxed refactors without protecting
 * behavior. Module composition is covered by the behavioral suites instead.
 */

const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = join(testDirectory, "..", "src");
const rootDirectory = join(testDirectory, "..");

function sourceFiles(): { name: string; contents: string }[] {
  // Recursive: website code under src/pages and src/data must not silently
  // gain process, Git, or registration capabilities either.
  return readdirSync(sourceDirectory, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".mts") || entry.name.endsWith(".mjs"))
    )
    .map((entry) => ({
      name: join(relative(sourceDirectory, entry.parentPath), entry.name),
      contents: readFileSync(join(entry.parentPath, entry.name), "utf-8"),
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

test("only runner transport modules spawn child processes", () => {
  const spawnCall = /\bspawn\s*\(/;
  const owners = sourceFiles()
    .filter((file) => spawnCall.test(file.contents))
    .map((file) => file.name)
    .sort();

  assert.deepEqual(owners, ["detached-supervisor.mjs", "runner.ts"]);
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

test("git execution cannot hang the editor on a prompt", () => {
  // Git runs synchronously on Pi's main thread. A command that waits for input
  // (a signing passphrase, credentials) freezes the whole editor, so every
  // invocation is bounded and non-interactive, and maestro's own commits and
  // merges never request a signature.
  const worktree = readFileSync(join(sourceDirectory, "worktree.ts"), "utf-8");
  assert.match(worktree, /timeout: GIT_TIMEOUT_MS/);
  assert.match(worktree, /GIT_TERMINAL_PROMPT: "0"/);
  assert.match(
    worktree,
    /const COMMIT_ARGS = \["commit", "--no-gpg-sign"\]/,
    "maestro's commits must never request a signature"
  );
  const rawCommits = worktree.match(/\["commit"(?!-tree)[^\]]*\]/g) ?? [];
  assert.deepEqual(
    rawCommits.filter((call) => !call.includes("--no-gpg-sign")),
    [],
    "every commit invocation must go through COMMIT_ARGS"
  );
  for (const merge of worktree.match(/\["merge", "--no-edit"[^\]]*\]/g) ?? []) {
    assert.match(merge, /--no-gpg-sign/, `merge commit must not be signed: ${merge}`);
  }
});

test("only runner transports and worktree import child process APIs", () => {
  const childProcessImport = /(?:from|import\s*\()\s*["']node:child_process["']/;
  const allowed = new Set(["detached-supervisor.mjs", "runner.ts", "worktree.ts"]);
  const violations = sourceFiles()
    .filter((file) => !allowed.has(file.name) && childProcessImport.test(file.contents))
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

test("only the lifecycle adapter registers session events", () => {
  const sessionRegistration = /pi\.on\(\s*["']session_(?:start|shutdown)["']/;
  const owners = sourceFiles()
    .filter((file) => sessionRegistration.test(file.contents))
    .map((file) => file.name)
    .sort();
  assert.deepEqual(owners, ["extension-lifecycle.ts"]);
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
