import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/run-isolated.mjs <command> [args...]");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "pi-maestro-test-"));
const home = join(root, "home");
const agentDir = join(root, "pi-agent");
const xdgConfig = join(root, "xdg-config");
const xdgCache = join(root, "xdg-cache");
const xdgData = join(root, "xdg-data");
const xdgState = join(root, "xdg-state");
const temporaryFiles = join(root, "tmp");

for (const directory of [home, agentDir, xdgConfig, xdgCache, xdgData, xdgState, temporaryFiles]) {
  mkdirSync(directory, { recursive: true });
}

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  rmSync(root, { recursive: true, force: true });
}

const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    TMPDIR: temporaryFiles,
    PI_MAESTRO_TEST_ROOT: root,
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

process.once("exit", cleanup);

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      resolve(1);
      return;
    }
    resolve(code ?? 1);
  });
}).finally(cleanup);

process.exitCode = exitCode;
