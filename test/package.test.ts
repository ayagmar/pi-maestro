import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The published package as npm sees it. `npm publish` in the release workflow
 * builds the tarball from the same packlist, and scripts/smoke-test.mjs loads
 * the manifest entry through the real pi CLI.
 */

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(rootDirectory, "package.json"), "utf-8")) as {
  main: string;
  pi: { extensions: string[] };
};

function packedFiles(): string[] {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: rootDirectory,
    encoding: "utf-8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [pack] = JSON.parse(output) as { files: { path: string }[] }[];
  assert.ok(pack, "npm pack --dry-run must describe one tarball");
  return pack.files.map((file) => file.path);
}

test("the packed tarball ships the runtime and public docs but no site, test, or tooling files", () => {
  const files = packedFiles();
  const required = [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "docs/operations.md",
    "src/detached-supervisor.mjs",
    manifest.main,
    ...manifest.pi.extensions,
  ].map((path) => path.replace(/^\.\//, ""));
  for (const path of required) {
    assert.ok(files.includes(path), `packed tarball is missing ${path}`);
  }
  const forbidden = [
    "src/pages/",
    "src/layouts/",
    "src/styles/",
    "src/data/",
    "public/",
    "astro.config.mjs",
    "test/",
    "scripts/",
    ".github/",
    ".pi/",
    "pnpm-lock.yaml",
  ];
  for (const prefix of forbidden) {
    assert.deepEqual(
      files.filter((path) => path.startsWith(prefix)),
      [],
      `packed tarball must not contain ${prefix}`
    );
  }
});

test("the manifest entry registers exactly the three model tools", async () => {
  // The extension is inert inside a spawned executor; make sure it registers here.
  delete process.env.PI_MAESTRO_EXECUTOR;
  assert.deepEqual(manifest.pi.extensions, [manifest.main]);
  const entry = (await import(pathToFileURL(join(rootDirectory, manifest.main)).href)) as {
    default: (pi: unknown) => void;
  };
  const toolNames: string[] = [];
  const pi = new Proxy(
    { registerTool: (tool: { name: string }) => toolNames.push(tool.name) },
    {
      get: (target, property) =>
        property in target ? target[property as keyof typeof target] : () => {},
    }
  );
  entry.default(pi);
  assert.deepEqual(toolNames.sort(), ["maestro_drive", "maestro_plan", "maestro_update"]);
});
