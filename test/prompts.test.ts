import assert from "node:assert/strict";
import test from "node:test";
import {
  accountPromptContext,
  buildExecutorPrompt,
  buildOrchestratorBriefing,
  buildRetryFollowUpPrompt,
  buildReviewPrompt,
  buildSupervisorBriefing,
  MAX_INJECTED_CONTEXT_LENGTH,
  MODEL_PROMPT_BUDGET,
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

function injectedSection(prompt: string, sectionPrefix: string): string {
  const start = prompt.indexOf(sectionPrefix);
  assert.notEqual(start, -1);
  const valueStart = start + sectionPrefix.length;
  const end = prompt.indexOf("\n\n## ", valueStart);
  assert.notEqual(end, -1);
  return prompt.slice(valueStart, end);
}

test("maximum injected context length is 10000 characters", () => {
  assert.equal(MAX_INJECTED_CONTEXT_LENGTH, 10_000);
});

test("dependency reports preserve boundary values and truncate oversized values", () => {
  const prefix = "## Context from completed dependency T0 (Setup)\n";
  for (const length of [MAX_INJECTED_CONTEXT_LENGTH - 1, MAX_INJECTED_CONTEXT_LENGTH]) {
    const report = "d".repeat(length);
    const prompt = buildExecutorPrompt(makeTask(), [{ id: "T0", title: "Setup", report }]);
    assert.equal(injectedSection(prompt, prefix), report);
  }

  const report = "d".repeat(MAX_INJECTED_CONTEXT_LENGTH + 1);
  const prompt = buildExecutorPrompt(makeTask(), [{ id: "T0", title: "Setup", report }]);
  const injected = injectedSection(prompt, prefix);
  assert.equal(injected.length, MAX_INJECTED_CONTEXT_LENGTH);
  assert.match(injected, /\[\.\.\. lower-priority context omitted;.*\]$/);
});

test("review notes are bounded in executor retry and review prompts", () => {
  const promptBuilders = [
    {
      build: (reviewNotes: string) => buildExecutorPrompt(makeTask({ reviewNotes }), []),
      prefix:
        "## Review feedback\nA reviewer rejected the previous attempt. Address every point:\n",
    },
    {
      build: (reviewNotes: string) => buildReviewPrompt(makeTask({ reviewNotes }), "done"),
      prefix: "## Previous review findings\nExplicitly verify every prior finding:\n",
    },
  ];

  for (const { build, prefix } of promptBuilders) {
    for (const length of [MAX_INJECTED_CONTEXT_LENGTH - 1, MAX_INJECTED_CONTEXT_LENGTH]) {
      const reviewNotes = "r".repeat(length);
      assert.equal(injectedSection(build(reviewNotes), prefix), reviewNotes);
    }

    const prompt = build("r".repeat(MAX_INJECTED_CONTEXT_LENGTH + 1));
    const injected = injectedSection(prompt, prefix);
    assert.equal(injected.length, MAX_INJECTED_CONTEXT_LENGTH);
    assert.match(injected, /\[\.\.\. lower-priority context omitted;.*\]$/);
  }
});

test("large prompts retain criteria and blockers within the deterministic budget", () => {
  const task = makeTask({
    brief: "b".repeat(20_000),
    successCriteria: Array.from(
      { length: 12 },
      (_, index) => `criterion-${index} ${"c".repeat(400)}`
    ),
    findings: Array.from({ length: 8 }, (_, index) => ({
      fingerprint: `finding-${index}`,
      message: `blocker-${index} ${"x".repeat(450)}`,
      status: "open" as const,
      firstAttempt: 1,
      lastAttempt: 1,
    })),
  });
  const dependencies = Array.from({ length: 8 }, (_, index) => ({
    id: `D${index}`,
    title: "Dependency",
    report: "d".repeat(10_000),
  }));
  const prompt = buildExecutorPrompt(task, dependencies);
  const accounting = accountPromptContext(prompt);

  assert.ok(accounting.characters < MODEL_PROMPT_BUDGET);
  assert.ok(accounting.sections.some((section) => section.name === "Success criteria"));
  for (let index = 0; index < 12; index += 1)
    assert.match(prompt, new RegExp(`criterion-${index}`));
  for (let index = 0; index < 8; index += 1) assert.match(prompt, new RegExp(`finding-${index}`));
});

test("explicit success criteria appear once in executor and reviewer prompts", () => {
  const task = makeTask({
    successCriteria: ["Returns the expected value", "Passes focused tests"],
  });
  for (const prompt of [buildExecutorPrompt(task, []), buildReviewPrompt(task, "Done.")]) {
    assert.equal(prompt.match(/Returns the expected value/g)?.length, 1);
    assert.equal(prompt.match(/Passes focused tests/g)?.length, 1);
  }
});

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

test("executor prompt includes dependency reports and their optional transcript references", () => {
  const withTranscript = "## Context from completed dependency T0 (Setup)\n";
  const withoutTranscript = "## Context from completed dependency T2 (Tests)\n";
  const prompt = buildExecutorPrompt(makeTask(), [
    {
      id: "T0",
      title: "Setup",
      report: "Created src/server.ts",
      sessionFile: "/sessions/T0-attempt-1.jsonl",
    },
    { id: "T2", title: "Tests", report: "Added tests" },
  ]);

  assert.equal(
    injectedSection(prompt, withTranscript),
    "Created src/server.ts\nFull transcript (read sparingly, only if this report is insufficient): /sessions/T0-attempt-1.jsonl"
  );
  assert.equal(injectedSection(prompt, withoutTranscript), "Added tests");
});

test("review prompt is adversarial, scoped, and demands a verdict", () => {
  const prompt = buildReviewPrompt(makeTask(), "Did the thing.");
  assert.match(prompt, /adversarial/);
  assert.match(prompt, /read-only tools/);
  assert.match(prompt, /Style preferences are not findings/);
  assert.match(prompt, /VERDICT: APPROVE/);
  assert.match(prompt, /VERDICT: REQUEST_CHANGES/);
});

test("review prompt asks the reviewer to judge write-scope deviations", () => {
  const task = makeTask();
  task.writePaths = ["src/**"];
  task.attempts = [
    {
      index: 1,
      logFile: "attempt.jsonl",
      thinking: "medium",
      startedAt: 1,
      usage: { input: 0, output: 0, cost: 0, turns: 1 },
      touchedFiles: ["README.md", "src/app.ts"],
    },
  ];
  const prompt = buildReviewPrompt(task, "done");
  assert.match(prompt, /Write-scope deviation/);
  assert.match(prompt, /README\.md/);
  assert.match(prompt, /planning and scheduling guidance/);
});

test("review prompt includes only a bounded diff when the attempt has one", () => {
  const attempt = {
    index: 1,
    logFile: "attempt.log",
    thinking: "low",
    startedAt: 0,
    usage: { input: 0, output: 0, cost: 0, turns: 1 },
    touchedFiles: ["src/file.ts"],
    diff: "d".repeat(MAX_INJECTED_CONTEXT_LENGTH + 1),
  };
  const prompt = buildReviewPrompt(makeTask({ attempts: [attempt] }), "Done.");
  const diff = injectedSection(prompt, "## Bounded display diff\n");

  assert.equal(diff.length, 8_000);
  assert.match(diff, /\[\.\.\. lower-priority context omitted;.*\]$/);
  assert.doesNotMatch(buildReviewPrompt(makeTask(), "Done."), /## Bounded display diff/);
});

test("parseVerdict handles approve, request changes, and missing verdicts", () => {
  assert.deepEqual(parseVerdict("All good.\nVERDICT: APPROVE"), { approved: true, notes: "" });
  assert.deepEqual(parseVerdict("verdict: approve"), { approved: true, notes: "" });
  const rejected = parseVerdict("Bad.\nVERDICT: REQUEST_CHANGES\n1. fix null check\n2. add test");
  assert.equal(rejected?.approved, false);
  assert.match(rejected?.notes ?? "", /1\. fix null check/);
  assert.equal(parseVerdict("I think it looks fine"), undefined);
});

test("supervisor briefing renders structured task blocks in stable field order", () => {
  const task = makeTask({
    status: "ready_for_review",
    tier: "complex",
    dependsOn: ["T0", "T2"],
    reviewNotes: "r".repeat(501),
    attempts: [
      {
        index: 1,
        logFile: "attempt.log",
        thinking: "high",
        startedAt: 0,
        usage: { input: 100, output: 20, cost: 0.01234, turns: 2 },
        touchedFiles: [],
      },
      {
        index: 2,
        logFile: "attempt-2.log",
        thinking: "high",
        startedAt: 1,
        usage: { input: 50, output: 10, cost: 0.00006, turns: 1 },
        touchedFiles: [],
      },
    ],
  });
  const briefing = buildSupervisorBriefing("Migrate auth", [task], "tier guidance here");
  const expectedBlock = [
    "id: T1",
    "title: Add health endpoint",
    "status: ready_for_review",
    "tier: complex",
    "dependsOn: T0, T2",
    "attempts: 2",
    "cost: $0.0124",
    `reviewNotes: ${"r".repeat(500)}`,
  ].join("\n");

  assert.ok(briefing.includes(`## Board\n${expectedBlock}\n\n## Success criteria`));
  assert.doesNotMatch(briefing, new RegExp(`reviewNotes: ${"r".repeat(501)}`));
  assert.match(briefing, /fresh context/);
  assert.match(briefing, /Migrate auth/);
  assert.match(briefing, /maestro_drive/);
  assert.match(briefing, /Do not re-plan/);
  assert.match(briefing, /you do not implement tasks yourself/);
  assert.match(briefing, /tier guidance here/);
});

test("supervisor briefing keeps multiline review notes on one capped field line", () => {
  const reviewNotes = `first line\r\nsecond line\n${"r".repeat(500)}`;
  const briefing = buildSupervisorBriefing("Migrate auth", [makeTask({ reviewNotes })], "tiers");
  const reviewNotesLine = briefing.split("\n").find((line) => line.startsWith("reviewNotes: "));

  assert.equal(
    reviewNotesLine,
    `reviewNotes: ${reviewNotes.replace(/\r\n?|\n/g, "\\n").slice(0, 500)}`
  );
  assert.equal(reviewNotesLine?.slice("reviewNotes: ".length).length, 500);
  assert.match(reviewNotesLine ?? "", /^reviewNotes: first line\\nsecond line\\n/);
});

test("supervisor briefing formats empty task fields and a missing goal gracefully", () => {
  const briefing = buildSupervisorBriefing(undefined, [makeTask()], "tiers");
  assert.match(briefing, /infer from the board/);
  assert.match(briefing, /dependsOn: \(none\)\nattempts: 0\ncost: \$0\.0000/);
  assert.doesNotMatch(briefing, /reviewNotes:/);
});

test("parseVerdict uses the last verdict when the reviewer quotes the instruction", () => {
  const report =
    "The task says end with VERDICT: APPROVE or VERDICT: REQUEST_CHANGES.\nI checked the files.\nVERDICT: REQUEST_CHANGES\n1. x.ts is missing the null check";
  const verdict = parseVerdict(report);
  assert.equal(verdict?.approved, false);
  assert.match(verdict?.notes ?? "", /null check/);
});

test("review prompt carries previous review findings on re-review", () => {
  const task = makeTask({
    reviewNotes: "1. missing null check in x.ts",
  });
  const prompt = buildReviewPrompt(task, "## Report\nfixed it");
  assert.match(prompt, /Previous review findings/);
  assert.match(prompt, /missing null check/);
  // First review has no such section
  const first = buildReviewPrompt(makeTask({}), "## Report\ndone");
  assert.doesNotMatch(first, /Previous review findings/);
});

test("orchestrator briefing embeds the goal, tier guidance, and workflow tools", () => {
  const tierGuidance = "Pick the cheapest tier that can meet the acceptance criteria";
  const briefing = buildOrchestratorBriefing("Migrate to Spring Boot 4", tierGuidance);
  assert.match(briefing, /cheapest tier/);
  assert.match(briefing, /Migrate to Spring Boot 4/);
  assert.match(briefing, /maestro_plan/);
  assert.match(briefing, /maestro_drive/);
  assert.match(briefing, /maestro_update/);
  assert.doesNotMatch(briefing, /maestro_(?:run|review|status)/);
  assert.match(briefing, /You do not implement tasks yourself/);
  assert.match(briefing, /fails twice with the same root cause/);
  assert.match(briefing, /in-flight attempt.*settle/);

  const gated = buildOrchestratorBriefing("Goal", tierGuidance, true);
  assert.match(gated, /planGate is enabled/);
  assert.match(gated, /\/maestro plan/);
  assert.doesNotMatch(briefing, /planGate is enabled/);
});

test("prompts disclose open findings beyond the injected bound", () => {
  const task = makeTask({
    findings: Array.from({ length: 11 }, (_, index) => ({
      fingerprint: `criterion-${index + 1}`,
      message: `defect ${index + 1}`,
      status: "open" as const,
      firstAttempt: 1,
      lastAttempt: 1,
    })),
  });
  const executorPrompt = buildExecutorPrompt(task, []);
  const reviewPrompt = buildReviewPrompt(task, "done");
  for (const prompt of [executorPrompt, reviewPrompt]) {
    assert.match(prompt, /\[criterion-8\]/);
    assert.doesNotMatch(prompt, /\[criterion-9\]/);
    assert.match(prompt, /\+3 more open findings recorded on the board/);
  }
  // Exactly eight findings need no disclosure.
  const bounded = makeTask({
    findings: Array.from({ length: 8 }, (_, index) => ({
      fingerprint: `criterion-${index + 1}`,
      message: `defect ${index + 1}`,
      status: "open" as const,
      firstAttempt: 1,
      lastAttempt: 1,
    })),
  });
  assert.doesNotMatch(buildExecutorPrompt(bounded, []), /more open finding/);
});

test("retry follow-up prompt carries only the findings, criteria, and report contract", () => {
  const task = makeTask({
    successCriteria: ["endpoint returns 200"],
    reviewNotes: "1. Criterion 1: /health returns 500 under load.",
    attempts: [
      {
        index: 1,
        logFile: "a.jsonl",
        thinking: "medium",
        startedAt: 0,
        usage: { input: 1, output: 1, cost: 1, turns: 1 },
        touchedFiles: [],
        finalReport: "## Report\nImplemented /health.",
      },
    ],
  });
  const prompt = buildRetryFollowUpPrompt(task);
  assert.match(prompt, /A reviewer rejected your work on Task T1/);
  assert.match(prompt, /\/health returns 500 under load/);
  assert.match(prompt, /1\. endpoint returns 200/);
  assert.match(prompt, /## Report/);
  // The resumed session already contains the brief; re-sending it would only
  // duplicate context the provider bills again.
  assert.doesNotMatch(prompt, /Add GET \/health returning 200/);
});

test("a fresh retry prompt includes the predecessor attempt's report", () => {
  const task = makeTask({
    reviewNotes: "1. Criterion 1: broken.",
    attempts: [
      {
        index: 1,
        logFile: "a.jsonl",
        thinking: "medium",
        startedAt: 0,
        usage: { input: 1, output: 1, cost: 1, turns: 1 },
        touchedFiles: [],
        finalReport: "## Report\nRewrote the handler and added tests.",
      },
    ],
  });
  const prompt = buildExecutorPrompt(task, []);
  assert.match(prompt, /## Previous attempt's report/);
  assert.match(prompt, /Rewrote the handler and added tests/);
  // A first attempt has no feedback and must not gain the section.
  const first = buildExecutorPrompt(makeTask(), []);
  assert.doesNotMatch(first, /## Previous attempt's report/);
});
