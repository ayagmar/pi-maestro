import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = mkdtempSync(join(root, ".package-smoke-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", temporaryDirectory], {
    cwd: root,
    stdio: "pipe",
  });

  const archives = readdirSync(temporaryDirectory).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected one packed archive, found ${archives.length}.`);
  }
  const archive = join(temporaryDirectory, archives[0]);
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  const entries = new Set(listing.split("\n").filter(Boolean));
  for (const entry of [
    "package/package.json",
    "package/src/index.ts",
    "package/README.md",
    "package/docs/operations.md",
    "package/SECURITY.md",
  ]) {
    if (!entries.has(entry)) throw new Error(`Packed archive is missing ${entry}.`);
  }
  for (const prefix of ["package/.pi/", "package/test/", "package/scripts/", "package/.github/"]) {
    if ([...entries].some((entry) => entry.startsWith(prefix))) {
      throw new Error(`Packed archive contains forbidden path ${prefix}`);
    }
  }

  execFileSync("tar", ["-xzf", archive, "-C", temporaryDirectory]);
  const packageDirectory = join(temporaryDirectory, "package");
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  const entry = join(packageDirectory, manifest.main);
  if (!existsSync(entry)) throw new Error(`Packed entry does not exist: ${manifest.main}`);
  if (manifest.pi?.extensions?.length !== 1 || manifest.pi.extensions[0] !== manifest.main) {
    throw new Error("Packed manifest does not register its declared extension entry point.");
  }

  const probe = `
    const mod = await import(${JSON.stringify(pathToFileURL(entry).href)});
    const names = [];
    const pi = new Proxy(
      { registerTool(tool) { names.push(tool.name); } },
      { get(target, property) { return property in target ? target[property] : () => {}; } },
    );
    mod.default(pi);
    const expected = ["maestro_drive", "maestro_plan", "maestro_update"];
    if (JSON.stringify([...names].sort()) !== JSON.stringify(expected)) {
      throw new Error("Packed extension registered an unexpected model-tool surface.");
    }
  `;
  execFileSync(process.execPath, ["--import=tsx", "--input-type=module", "--eval", probe], {
    cwd: root,
    stdio: "inherit",
  });
  console.log(
    "✓ Packed artifact contains the public files and registers exactly three model tools"
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
