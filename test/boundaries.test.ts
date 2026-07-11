import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = join(testDirectory, "..", "src");

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
