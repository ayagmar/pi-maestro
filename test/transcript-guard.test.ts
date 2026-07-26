import assert from "node:assert/strict";
import test from "node:test";
import { guardTranscriptRead } from "../src/transcript-guard.js";

const own =
  "/home/u/.pi/agent/sessions/--home-u-project--/2026-07-26T00-29-48-462Z_019f9bd3-fa2e-7134-aa29-07c84d013253.jsonl";

test("reading the caller's own session transcript is blocked", () => {
  const decision = guardTranscriptRead("read", { path: own }, own);
  assert.equal(decision.blocked, true);
  assert.match(decision.reason ?? "", /your own session transcript/);
  assert.match(decision.reason ?? "", /maestro_drive inspect/);
});

test("reading another agent's session transcript or run log is blocked", () => {
  const paths = [
    // A maestro executor session under the nested agent namespace.
    "/home/u/.pi/agent/sessions/--home-u-project--/.maestro/T1-attempt-1-06d3e4bf/2026-07-26T00-33-21-648Z_019f9bd7-3af0.jsonl",
    // A sibling orchestrator session.
    "/home/u/.pi/agent/sessions/--home-u-other--/2026-07-24T15-29-30-099Z_019f94be-f3f3.jsonl",
    // A maestro per-run event log.
    ".pi/maestro/logs/T3-review-1-2-2.jsonl",
  ];
  for (const path of paths) {
    const decision = guardTranscriptRead("read", { path }, own);
    assert.equal(decision.blocked, true, `expected ${path} to be blocked`);
    assert.match(decision.reason ?? "", /maestro_drive inspect/);
  }
});

test("ordinary project files stay readable", () => {
  const paths = [
    "src/index.ts",
    "plans/012-stable-session-identity.md",
    ".pi/maestro/board.json",
    "docs/operations.md",
    // A data file that merely shares the extension is not a transcript.
    "fixtures/expected-output.jsonl",
  ];
  for (const path of paths) {
    assert.equal(
      guardTranscriptRead("read", { path }, own).blocked,
      false,
      `expected ${path} to stay readable`
    );
  }
});

test("only context-loading tools are guarded", () => {
  // A tool that does not put file contents in context is unaffected.
  assert.equal(guardTranscriptRead("bash", { path: own }, own).blocked, false);
  assert.equal(guardTranscriptRead("maestro_drive", { path: own }, own).blocked, false);
  // Missing or non-string paths are not decisions to make.
  assert.equal(guardTranscriptRead("read", {}, own).blocked, false);
  assert.equal(guardTranscriptRead("read", { path: 42 as unknown as string }, own).blocked, false);
  assert.equal(guardTranscriptRead("read", undefined, own).blocked, false);
});

test("a transcript is blocked even without a known caller session", () => {
  const decision = guardTranscriptRead("read", { path: own }, undefined);
  assert.equal(decision.blocked, true);
});

test("windows-style separators are normalized before matching", () => {
  const windowsOwn = String.raw`C:\Users\u\.pi\agent\sessions\--c-project--\2026-07-26T00-29-48-462Z_019f9bd3-fa2e.jsonl`;
  assert.equal(guardTranscriptRead("read", { path: windowsOwn }, windowsOwn).blocked, true);
  assert.equal(
    guardTranscriptRead("read", { path: String.raw`.pi\maestro\logs\T1-attempt-1.jsonl` }, own)
      .blocked,
    true
  );
});
