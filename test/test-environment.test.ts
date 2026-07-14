import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";

function assertInsideTestRoot(path: string, root: string): void {
  const relativePath = relative(root, path);
  assert.notEqual(relativePath, "");
  assert.equal(relativePath.startsWith(".."), false);
}

test("test process uses isolated user, XDG, temporary, and Git settings", () => {
  const root = process.env.PI_MAESTRO_TEST_ROOT;
  assert.ok(root, "tests must run through scripts/run-isolated.mjs");

  const isolatedDirectories = [
    process.env.HOME,
    process.env.PI_CODING_AGENT_DIR,
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_CACHE_HOME,
    process.env.XDG_DATA_HOME,
    process.env.XDG_STATE_HOME,
    process.env.TMPDIR,
  ];

  for (const directory of isolatedDirectories) {
    assert.ok(directory);
    assertInsideTestRoot(directory, root);
    assert.equal(existsSync(directory), true);
  }

  const gitConfig = process.env.GIT_CONFIG_GLOBAL;
  assert.ok(gitConfig);
  assertInsideTestRoot(gitConfig, root);
  assert.equal(dirname(gitConfig), root);
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1");

  const agentDir = process.env.PI_CODING_AGENT_DIR;
  assert.ok(agentDir);
  assert.equal(existsSync(join(agentDir, "maestro.json")), false);
});
