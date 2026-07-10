import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrencyLimit, touchedFile } from "../src/runner.js";

test("touchedFile picks up write/edit paths from tool_execution_start", () => {
  // pi's JSON stream carries args on tool_execution_start; tool_execution_end has args: null
  assert.equal(
    touchedFile(
      { type: "tool_execution_start", toolName: "write", args: { path: "/repo/a.ts" } },
      "/repo"
    ),
    "a.ts"
  );
  assert.equal(
    touchedFile(
      { type: "tool_execution_start", toolName: "edit", args: { path: "src/b.ts" } },
      "/repo"
    ),
    "src/b.ts"
  );
});

test("touchedFile ignores other tools and end events", () => {
  assert.equal(
    touchedFile(
      { type: "tool_execution_start", toolName: "bash", args: { command: "ls" } },
      "/repo"
    ),
    undefined
  );
  assert.equal(
    touchedFile(
      { type: "tool_execution_end", toolName: "write", args: { path: "/repo/a.ts" } },
      "/repo"
    ),
    undefined
  );
});

test("mapWithConcurrencyLimit preserves order and limits concurrency", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrencyLimit([10, 20, 30, 40, 50], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 2;
  });
  assert.deepEqual(results, [20, 40, 60, 80, 100]);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test("mapWithConcurrencyLimit handles empty input", async () => {
  assert.deepEqual(await mapWithConcurrencyLimit([], 4, async () => 1), []);
});
