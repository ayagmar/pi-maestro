import { type Board, type Task } from "../types.js";

/**
 * The example board on the landing page. It is a fixture, not a recording, but
 * every string the page shows for it (status line, phase rail, review evidence,
 * next action) is checked against the extension's own projections in
 * test/docs.test.ts, so the page cannot describe output the product does not print.
 */
const usage = (cost: number, turns: number) => ({ input: 0, output: 0, cost, turns });

const attempt = (index: number, cost: number, extra: Partial<Task["attempts"][number]> = {}) => ({
  index,
  logFile: `logs/T${index}.jsonl`,
  thinking: "medium",
  startedAt: 0,
  usage: usage(cost, 8),
  touchedFiles: [],
  ...extra,
});

const task = (fields: Partial<Task> & Pick<Task, "id" | "title" | "status">): Task => ({
  brief: fields.title,
  tier: "standard",
  dependsOn: [],
  attempts: [],
  createdAt: 0,
  updatedAt: 0,
  ...fields,
});

export const exampleRejection = {
  role: "single" as const,
  verdict: "request_changes" as const,
  model: "reviewer-model",
  provider: "provider",
  startedAt: 0,
  usage: usage(0.12, 5),
  criterionEvidence: [
    { criterion: 1, passed: true, evidence: "tsc exits 0 on src/auth/adapter.ts" },
    { criterion: 2, passed: false, evidence: "auth.test.ts still imports the old token helper" },
  ],
};

/** T1 is approved, T2 was rejected once and its second attempt is running, T3 and T4 wait. */
export const exampleBoard = {
  tasks: [
    task({
      id: "T1",
      title: "Map the session boundary",
      status: "approved",
      attempts: [attempt(1, 0.31, { endedAt: 1 })],
    }),
    task({
      id: "T2",
      title: "Port the adapter",
      status: "running",
      successCriteria: [
        "The adapter compiles against the new session API",
        "The existing auth tests pass unchanged",
      ],
      attempts: [
        attempt(1, 0.55, { endedAt: 1, reviewLaunches: [exampleRejection] }),
        attempt(2, 0.19),
      ],
    }),
    task({ id: "T3", title: "Update the call sites", status: "todo", dependsOn: ["T2"] }),
    task({ id: "T4", title: "Add replay tests", status: "todo", dependsOn: ["T3"] }),
  ],
} as Board;

/** T2's second executor is the only live process. */
export const exampleLiveKinds = new Map<string, "execute" | "review">([["T2", "execute"]]);

export const exampleSpend = (id: string): string => {
  const found = exampleBoard.tasks.find((item) => item.id === id);
  const cost = found?.attempts.reduce((sum, item) => sum + item.usage.cost, 0) ?? 0;
  return `$${cost.toFixed(2)}`;
};

/** The status line pi shows while this board runs. */
export const exampleStatusLine =
  "⚡ maestro running · execution · ▰▰▰▱▱▱▱▱▱▱ 1/4 (25%) · 1 running · $1.05";

/** `/maestro board` opens on this rail. A phase is "current", "retained evidence", or "no evidence". */
export const examplePhases: { label: string; state: string; tasks: string }[] = [
  { label: "discovery", state: "no evidence", tasks: "none" },
  { label: "plan approval", state: "no evidence", tasks: "none" },
  { label: "execution", state: "current", tasks: "T1, T2, T3, T4" },
  { label: "review", state: "retained evidence", tasks: "T2" },
  { label: "integration", state: "no evidence", tasks: "none" },
  { label: "verification", state: "no evidence", tasks: "none" },
  { label: "recovery", state: "no evidence", tasks: "none" },
  { label: "complete", state: "retained evidence", tasks: "T1" },
];

/** The evidence view for T2's first review launch, as the dashboard prints it. */
export const exampleEvidence = {
  path: "Run › execution › T2 › review #1 · single",
  lines: [
    "Reviewer: single · request_changes · model reviewer-model · provider provider",
    "Criterion evidence: 1 PASS tsc exits 0 on src/auth/adapter.ts",
    "Criterion evidence: 2 FAIL auth.test.ts still imports the old token helper",
  ],
};

/** The dashboard's `Next:` line for T2 while its retry runs, and once the drive has stopped. */
export const exampleNext = {
  live: "Monitor output, steer if needed, or abort.",
  stopped: "Retry with the reviewer notes (r).",
};
