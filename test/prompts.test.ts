import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutorPrompt,
  buildOrchestratorBriefing,
  buildReviewPrompt,
  parseVerdict,
} from "../src/prompts.js";
import { type Task } from "../src/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "T1",
    title: "Add health endpoint",
    brief: "Add GET /health returning 200. Verify with curl.",
    tier: "standard",
    status: "todo",
    dependsOn: [],
    attempts: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("executor prompt contains task, success criteria, stop rule, and report contract", () => {
  const prompt = buildExecutorPrompt(makeTask(), []);
  assert.match(prompt, /## Task T1: Add health endpoint/);
  assert.match(prompt, /GET \/health/);
  assert.match(prompt, /## Success criteria/);
  assert.match(prompt, /## Stop rule/);
  assert.match(prompt, /## Report/);
  assert.match(prompt, /fresh context/);
  assert.match(prompt, /steering messages mid-run/);
});

test("executor prompt includes review notes on retry", () => {
  const prompt = buildExecutorPrompt(makeTask({ reviewNotes: "1. Missing test for 500 path" }), []);
  assert.match(prompt, /## Review feedback/);
  assert.match(prompt, /Missing test for 500 path/);
});

test("executor prompt includes dependency reports", () => {
  const prompt = buildExecutorPrompt(makeTask(), [
    { id: "T0", title: "Setup", report: "Created src/server.ts" },
  ]);
  assert.match(prompt, /dependency T0 \(Setup\)/);
  assert.match(prompt, /Created src\/server\.ts/);
});

test("review prompt is adversarial, scoped, and demands a verdict", () => {
  const prompt = buildReviewPrompt(makeTask(), "Did the thing.");
  assert.match(prompt, /adversarial/);
  assert.match(prompt, /read-only tools/);
  assert.match(prompt, /Style preferences are not findings/);
  assert.match(prompt, /VERDICT: APPROVE/);
  assert.match(prompt, /VERDICT: REQUEST_CHANGES/);
});

test("parseVerdict handles approve, request changes, and missing verdicts", () => {
  assert.deepEqual(parseVerdict("All good.\nVERDICT: APPROVE"), { approved: true, notes: "" });
  assert.deepEqual(parseVerdict("verdict: approve"), { approved: true, notes: "" });
  const rejected = parseVerdict("Bad.\nVERDICT: REQUEST_CHANGES\n1. fix null check\n2. add test");
  assert.equal(rejected?.approved, false);
  assert.match(rejected?.notes ?? "", /1\. fix null check/);
  assert.equal(parseVerdict("I think it looks fine"), undefined);
});

test("orchestrator briefing embeds the goal, tier guidance, and workflow tools", () => {
  const tierGuidance = "Pick the cheapest tier that can meet the acceptance criteria";
  const briefing = buildOrchestratorBriefing("Migrate to Spring Boot 4", tierGuidance);
  assert.match(briefing, /cheapest tier/);
  assert.match(briefing, /Migrate to Spring Boot 4/);
  assert.match(briefing, /conductor_plan/);
  assert.match(briefing, /conductor_run/);
  assert.match(briefing, /conductor_review/);
  assert.match(briefing, /You do not implement tasks yourself/);
  assert.match(briefing, /fails twice with the same root cause/);
});
