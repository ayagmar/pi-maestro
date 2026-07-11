import assert from "node:assert/strict";
import test from "node:test";
import { previousOwnedSession } from "../src/index.js";

test("restores the previous session when it owns the maestro board", () => {
  assert.equal(
    previousOwnedSession("/sessions/orchestrator.jsonl", [
      "/sessions/other.jsonl",
      "/sessions/orchestrator.jsonl",
    ]),
    "/sessions/orchestrator.jsonl"
  );
});

test("does not restore unrelated or executor sessions", () => {
  assert.equal(
    previousOwnedSession("/sessions/executor.jsonl", ["/sessions/orchestrator.jsonl"]),
    undefined
  );
  assert.equal(previousOwnedSession("/sessions/unscoped.jsonl", undefined), undefined);
});
