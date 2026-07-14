import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { humanRetryEligibility } from "../src/board.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  Dashboard,
  type DashboardActions,
  DASHBOARD_BINDINGS,
  DEFAULT_DASHBOARD_BODY_HEIGHT,
  type LivePaneLaunch,
  LivePaneComponent,
  projectEvidenceSections,
  taskLaunches,
  wrapText,
} from "../src/dashboard.js";
import { type Board, type Task } from "../src/types.js";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "T1",
    title: "Do thing",
    brief: "brief",
    tier: "standard",
    status: "running",
    dependsOn: [],
    attempts: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeActions(board: Board, overrides: Partial<DashboardActions> = {}): DashboardActions {
  return {
    getBoard: () => board,
    isLive: () => false,
    liveKind: () => undefined,
    liveActivity: () => undefined,
    steer: () => {},
    abort: () => {},
    setTaskStatus: () => {},
    hasExecutorSession: () => false,
    hasReviewerSession: () => false,
    retryEligibility: (taskId) =>
      humanRetryEligibility(board, taskId, { maxAttempts: 3, isLive: () => false }),
    selectTaskAction: () => {},
    close: () => {},
    requestRender: () => {},
    ...overrides,
  };
}

test("dashboard renders header, tasks, and footer within width", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 3,
    tasks: [makeTask(), makeTask({ id: "T2", status: "approved" })],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    const lines = dashboard.render(100);
    const joined = lines.join("\n");
    assert.equal(lines.length, DEFAULT_DASHBOARD_BODY_HEIGHT + 3);
    assert.ok(lines.every((line) => visibleWidth(line) <= 100));
    assert.match(joined, /maestro dashboard · 2 task\(s\)/);
    assert.match(joined, /T1 Do thing/);
    assert.match(joined, /T2 Do thing/);
    assert.match(joined, /esc close/);
  } finally {
    dashboard.dispose();
  }
});

test("task list windowing renders every task when the pane is taller than the list", () => {
  // Five dependent tasks with an active reviewer-failure decision, more rows than the terminal needs.
  const board: Board = {
    version: 1,
    nextTaskNumber: 6,
    tasks: [
      makeTask({ id: "T1", status: "ready_for_review", title: "Board parity" }),
      makeTask({ id: "T2", status: "todo", title: "Remove list", dependsOn: ["T1"] }),
      makeTask({ id: "T3", status: "todo", title: "Merge compare", dependsOn: ["T2"] }),
      makeTask({ id: "T4", status: "todo", title: "Run summary", dependsOn: ["T3"] }),
      makeTask({
        id: "T5",
        status: "todo",
        title: "Group help",
        dependsOn: ["T2", "T3", "T4"],
      }),
    ],
    activeDecision: {
      id: "decision-1",
      kind: "reviewer_failure",
      taskIds: ["T1"],
      evidence: "review operation failed",
      allowedInterventions: ["handoff", "abort"],
      createdAt: 0,
    },
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { getRows: () => 60 });
  try {
    for (let index = 0; index < 4; index += 1) dashboard.handleInput("\x1b[B");
    const rendered = dashboard.render(120).join("\n");
    for (const task of board.tasks) assert.match(rendered, new RegExp(`${task.id} ${task.title}`));
  } finally {
    dashboard.dispose();
  }
});

test("dashboard task window shows correct earlier and later task counts", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 9,
    tasks: Array.from({ length: 8 }, (_, index) =>
      makeTask({ id: `T${index + 1}`, title: `Task ${index + 1}`, status: "todo" })
    ),
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { getRows: () => 8 });
  try {
    for (let index = 0; index < 4; index += 1) dashboard.handleInput("\x1b[B");
    const rendered = dashboard.render(120).join("\n");

    assert.match(rendered, /↑ 3 earlier tasks/);
    assert.match(rendered, /↓ 3 more tasks/);
    assert.match(rendered, /T5 Task 5/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard task window keeps the selected task visible in a short terminal", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 6,
    tasks: Array.from({ length: 5 }, (_, index) =>
      makeTask({ id: `T${index + 1}`, title: `Task ${index + 1}`, status: "todo" })
    ),
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { getRows: () => 8 });
  try {
    for (let index = 0; index < 4; index += 1) dashboard.handleInput("\x1b[B");
    const rendered = dashboard.render(120).join("\n");
    assert.match(rendered, /T5 Task 5/);
    assert.doesNotMatch(rendered, /T1 Task 1/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard shows supersession lineage in task status and contract evidence", () => {
  const predecessor = makeTask({
    id: "T1",
    title: "Original",
    status: "cancelled",
    supersededBy: "T2",
  });
  const successor = makeTask({
    id: "T2",
    title: "Replacement",
    status: "todo",
    supersedes: "T1",
  });
  const board: Board = { version: 1, nextTaskNumber: 3, tasks: [predecessor, successor] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    assert.match(dashboard.render(120).join("\n"), /cancelled · superseded by T2/);
    const contract = projectEvidenceSections(successor, undefined, {
      phaseLabel: "execution",
    }).find((section) => section.title === "Contract");
    assert.ok(contract?.lines.includes("Lineage: supersedes T1"));
  } finally {
    dashboard.dispose();
  }
});

test("dashboard clamps both panes to its configured body height", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-maestro-dashboard-"));
  const logFile = join(directory, "executor.jsonl");
  writeFileSync(
    logFile,
    `${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "transcript one\ntranscript two\ntranscript three\ntranscript four",
          },
        ],
      },
    })}\n`
  );

  const board: Board = {
    version: 1,
    nextTaskNumber: 4,
    tasks: [
      makeTask({
        attempts: [
          {
            index: 1,
            logFile,
            thinking: "medium",
            startedAt: 0,
            usage: { input: 0, output: 0, cost: 0, turns: 0 },
            touchedFiles: [],
          },
        ],
      }),
      makeTask({ id: "T2" }),
      makeTask({ id: "T3" }),
    ],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { bodyHeight: 7 });
  try {
    const lines = dashboard.render(100);
    const body = lines.slice(1, 8).join("\n");

    assert.equal(lines.length, 10);
    assert.match(body, /T3 Do thing/);
    assert.doesNotMatch(body, /transcript one/);
    assert.match(body, /transcript two/);
    assert.match(body, /transcript three/);
    assert.match(body, /transcript four/);
  } finally {
    dashboard.dispose();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("dashboard steer mode routes submitted text to the live run", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  const steered: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      isLive: () => true,
      steer: (taskId, message) => steered.push(`${taskId}:${message}`),
    })
  );
  try {
    dashboard.handleInput("s"); // open steering templates
    dashboard.handleInput("\x1b[B");
    dashboard.handleInput("\x1b[B");
    dashboard.handleInput("\x1b[B");
    dashboard.handleInput("\r"); // select Custom message...
    for (const ch of "focus on tests") dashboard.handleInput(ch);
    dashboard.handleInput("\r"); // submit
    assert.deepEqual(steered, ["T1:focus on tests"]);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard sends the selected steering template", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  const steered: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      isLive: () => true,
      steer: (taskId, message) => steered.push(`${taskId}:${message}`),
    })
  );
  try {
    dashboard.handleInput("s");
    dashboard.handleInput("\x1b[B");
    dashboard.handleInput("\r");

    assert.deepEqual(steered, ["T1:Run the project checks before finishing"]);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard keeps every steering template visible at constrained height", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board, { isLive: () => true }), {
    bodyHeight: 2,
  });
  const options = [
    "Stop - wrong approach, report current state",
    "Run the project checks before finishing",
    "Stay strictly within the task brief scope",
    "Custom message...",
  ];
  try {
    dashboard.handleInput("s");
    for (const option of options) {
      const body = dashboard.render(120).slice(1, 3).join("\n");
      assert.match(body, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      dashboard.handleInput("\x1b[B");
    }
  } finally {
    dashboard.dispose();
  }
});

test("dashboard cancels the steering template chooser with escape", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  let closed = false;
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, { isLive: () => true, close: () => (closed = true) })
  );
  try {
    dashboard.handleInput("s");
    assert.match(dashboard.render(100).join("\n"), /Custom message\.\.\./);

    dashboard.handleInput("\x1b");

    assert.equal(closed, false);
    assert.doesNotMatch(dashboard.render(100).join("\n"), /Custom message\.\.\./);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard abort requires y confirmation", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  const aborted: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, { isLive: () => true, abort: (taskId) => aborted.push(taskId) })
  );
  try {
    dashboard.handleInput("x");
    dashboard.handleInput("n"); // decline
    assert.deepEqual(aborted, []);
    dashboard.handleInput("x");
    dashboard.handleInput("y"); // confirm
    assert.deepEqual(aborted, ["T1"]);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard confirms the captured task after the list reorders", () => {
  const first = makeTask({ status: "ready_for_review" });
  const second = makeTask({ id: "T2", status: "ready_for_review" });
  const board: Board = { version: 1, nextTaskNumber: 3, tasks: [first, second] };
  const approved: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      setTaskStatus: (taskId) => approved.push(taskId),
    })
  );
  try {
    dashboard.handleInput("a");
    board.tasks = [second, first];
    assert.match(dashboard.render(100).at(-1) ?? "", /Approve T1/);
    dashboard.handleInput("y");
    assert.deepEqual(approved, ["T1"]);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard manual status selector routes the captured task through setTaskStatus", () => {
  const task = makeTask({ status: "todo" });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const changes: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      setTaskStatus: (taskId, status) => changes.push(`${taskId}:${status}`),
    })
  );
  try {
    assert.match(dashboard.render(120).at(-1) ?? "", /m manual status/);
    dashboard.handleInput("m");
    assert.match(dashboard.render(120).join("\n"), /Set T1 status:/);
    assert.match(dashboard.render(120).join("\n"), /ready for review/);
    dashboard.handleInput("\x1b[B");
    dashboard.handleInput("\x1b[B");
    dashboard.handleInput("\r");

    assert.deepEqual(changes, ["T1:approved"]);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard cancels manual status selection without mutation", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask({ status: "todo" })] };
  const changes: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      setTaskStatus: (taskId, status) => changes.push(`${taskId}:${status}`),
    })
  );
  try {
    dashboard.handleInput("m");
    dashboard.handleInput("\x1b");

    assert.deepEqual(changes, []);
    assert.doesNotMatch(dashboard.render(120).join("\n"), /Set T1 status:/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard rejects manual status selection for live and terminal tasks", () => {
  const task = makeTask({ status: "running" });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const changes: string[] = [];
  let live = true;
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      isLive: () => live,
      setTaskStatus: (taskId, status) => changes.push(`${taskId}:${status}`),
    })
  );
  try {
    dashboard.handleInput("m");
    assert.doesNotMatch(dashboard.render(120).join("\n"), /Set T1 status:/);

    live = false;
    task.status = "approved";
    dashboard.handleInput("m");
    dashboard.handleInput("\r");

    assert.deepEqual(changes, []);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard cancels manual status when the captured task disappears", () => {
  const first = makeTask({ status: "todo" });
  const second = makeTask({ id: "T2", status: "todo" });
  const board: Board = { version: 1, nextTaskNumber: 3, tasks: [first, second] };
  const changes: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      setTaskStatus: (taskId, status) => changes.push(`${taskId}:${status}`),
    })
  );
  try {
    dashboard.handleInput("m");
    board.tasks = [second];
    dashboard.handleInput("\r");

    assert.deepEqual(changes, []);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard cancels manual status when the captured task becomes terminal", () => {
  const task = makeTask({ status: "todo" });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const changes: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      setTaskStatus: (taskId, status) => changes.push(`${taskId}:${status}`),
    })
  );
  try {
    dashboard.handleInput("m");
    task.status = "failed";
    dashboard.handleInput("\r");

    assert.deepEqual(changes, []);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard renders the mutated status immediately after a confirmed approval", () => {
  const task = makeTask({ status: "ready_for_review" });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      setTaskStatus: (taskId) => {
        const target = board.tasks.find((candidate) => candidate.id === taskId);
        if (target) target.status = "approved";
      },
    })
  );
  try {
    dashboard.handleInput("a");
    dashboard.handleInput("y");
    assert.match(dashboard.render(100).join("\n"), /approved/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard ignores approval when the captured task leaves ready for review", () => {
  const task = makeTask({ status: "ready_for_review" });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const approved: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      setTaskStatus: (taskId) => approved.push(taskId),
    })
  );
  try {
    dashboard.handleInput("a");
    assert.match(dashboard.render(100).at(-1) ?? "", /Approve T1/);
    task.status = "todo";
    dashboard.handleInput("y");

    assert.deepEqual(approved, []);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard ignores approval when the captured task becomes live", () => {
  const task = makeTask({ status: "ready_for_review" });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  let live = false;
  const approved: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      isLive: () => live,
      setTaskStatus: (taskId) => approved.push(taskId),
    })
  );
  try {
    dashboard.handleInput("a");
    live = true;
    task.status = "running";
    dashboard.handleInput("y");
    assert.deepEqual(approved, []);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard escape closes in browse mode", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  let closed = false;
  const dashboard = new Dashboard(fakeTheme, makeActions(board, { close: () => (closed = true) }));
  try {
    dashboard.handleInput("\x1b");
    assert.equal(closed, true);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard shows selected task context and state-aware actions", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 3,
    tasks: [
      makeTask({
        status: "ready_for_review",
        tier: "complex",
        dependsOn: ["T2"],
        attempts: [
          {
            index: 1,
            logFile: "missing.jsonl",
            thinking: "high",
            startedAt: 0,
            usage: { input: 10, output: 20, cost: 0.125, turns: 2 },
            touchedFiles: [],
          },
        ],
      }),
      makeTask({ id: "T2", status: "approved" }),
    ],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    const output = dashboard.render(120).join("\n");
    assert.match(output, /T1 · ready for review · complex/);
    assert.match(output, /Dependencies: T2 · 1 attempt · \$0\.1250/);
    assert.match(output, /Next: Review the result; open its session or approve it\./);
    assert.match(output, /a approve/);
    assert.doesNotMatch(output, /r reopen/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard shows a todo task as ready when all dependencies are approved", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 3,
    tasks: [
      makeTask({ status: "todo", dependsOn: ["T2"] }),
      makeTask({ id: "T2", status: "approved" }),
    ],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    const output = dashboard.render(120).join("\n");
    assert.match(output, /Next: Ready to run when the orchestrator dispatches it\./);
    assert.doesNotMatch(output, /Waiting for T2 to complete\./);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard only lists dependencies that still block a task", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 4,
    tasks: [
      makeTask({ status: "todo", dependsOn: ["T2", "T3"] }),
      makeTask({ id: "T2", status: "approved" }),
      makeTask({ id: "T3", status: "running" }),
    ],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    assert.match(dashboard.render(120).join("\n"), /Next: Waiting for T3 to complete\./);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard only applies task actions valid for the selected state", () => {
  const task = makeTask({ status: "ready_for_review" });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const changes: string[] = [];
  const actions: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      setTaskStatus: (taskId, status) => changes.push(`${taskId}:${status}`),
      selectTaskAction: (taskId, action) => actions.push(`${taskId}:${action}`),
    })
  );
  try {
    dashboard.handleInput("a");
    assert.deepEqual(changes, []);
    dashboard.handleInput("y");
    dashboard.handleInput("r");
    task.status = "failed";
    dashboard.handleInput("a");
    dashboard.handleInput("r");
    assert.deepEqual(changes, ["T1:approved"]);
    assert.deepEqual(actions, ["T1:retry"]);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard routes approved retries through the centralized action without reopening status", () => {
  const task = makeTask({ status: "approved", approvalKind: "manual" });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const changes: string[] = [];
  const actions: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      setTaskStatus: (_taskId, status) => changes.push(status),
      selectTaskAction: (taskId, action) => actions.push(`${taskId}:${action}`),
    })
  );
  try {
    dashboard.handleInput("r");
    assert.deepEqual(actions, ["T1:retry"]);
    assert.deepEqual(changes, []);
    assert.equal(task.status, "approved");
  } finally {
    dashboard.dispose();
  }
});

test("dashboard makes complete and filtered boards clear while preserving the done filter", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 2,
    tasks: [makeTask({ status: "approved" })],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    assert.match(dashboard.render(100).join("\n"), /board complete/);
    dashboard.handleInput("f");
    const filtered = dashboard.render(100).join("\n");
    assert.match(filtered, /All tasks are done\./);
    assert.match(filtered, /f show them again/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard keeps an empty board distinct when the done filter is toggled", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    assert.match(dashboard.render(100).join("\n"), /No tasks yet/);
    dashboard.handleInput("f");
    const filtered = dashboard.render(100).join("\n");
    assert.match(filtered, /No tasks yet/);
    assert.doesNotMatch(filtered, /All tasks are done\./);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard points archived empty boards to replay", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, { getLatestArchive: () => ({ name: "run.json", at: Date.now() }) })
  );
  try {
    const output = dashboard.render(160).join("\n");
    assert.match(output, /last run archived/);
    assert.match(output, /\/maestro replay to restore/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard describes an invalid archive timestamp as recent", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, { getLatestArchive: () => ({ name: "run.json", at: Number.NaN }) })
  );
  try {
    assert.match(dashboard.render(160).join("\n"), /archived recently/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard marks stale approvals and names blockers in task rows", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 3,
    tasks: [
      makeTask({ status: "approved" }),
      makeTask({ id: "T2", status: "todo", dependsOn: ["T3"] }),
      makeTask({ id: "T3", status: "running" }),
    ],
  };
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, { getConfig: () => DEFAULT_CONFIG })
  );
  try {
    const output = dashboard.render(160).join("\n");
    assert.match(output, /approved \(stale\)/);
    assert.match(output, /blocked by T3/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard exposes available report and session actions and routes their keys", () => {
  const task = makeTask({
    status: "approved",
    attempts: [
      {
        index: 1,
        sessionFile: "executor.jsonl",
        logFile: "missing.jsonl",
        thinking: "medium",
        startedAt: 0,
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
        finalReport: "executor report",
        reviewReport: "approved verdict",
        reviewSessionFile: "reviewer.jsonl",
        touchedFiles: [],
      },
    ],
  });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const selected: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      hasExecutorSession: () => true,
      hasReviewerSession: () => true,
      selectTaskAction: (taskId, action) => selected.push(`${taskId}:${action}`),
    })
  );
  try {
    const footer = dashboard.render(140).at(-1) ?? "";
    assert.match(footer, /p report/);
    assert.match(footer, /v verdict/);
    assert.match(footer, /enter executor/);
    assert.match(footer, /O reviewer/);

    dashboard.handleInput("p");
    dashboard.handleInput("v");
    dashboard.handleInput("o");
    dashboard.handleInput("O");
    assert.deepEqual(selected, [
      "T1:view_report",
      "T1:view_review",
      "T1:open_executor",
      "T1:open_reviewer",
    ]);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard hides reviewer routing when the host cannot switch sessions", () => {
  const task = makeTask({
    attempts: [
      {
        index: 1,
        sessionFile: "executor.jsonl",
        logFile: "missing.jsonl",
        thinking: "medium",
        startedAt: 0,
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
        reviewSessionFile: "reviewer.jsonl",
        touchedFiles: [],
      },
    ],
  });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const selected: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      hasExecutorSession: () => true,
      hasReviewerSession: () => false,
      selectTaskAction: (_taskId, action) => selected.push(action),
    })
  );
  try {
    const footer = dashboard.render(120).at(-1) ?? "";
    assert.match(footer, /enter executor/);
    assert.doesNotMatch(footer, /reviewer/);

    dashboard.handleInput("O");
    assert.deepEqual(selected, []);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard groups tasks and cycles through every status filter", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 9,
    tasks: [
      makeTask({ id: "T1", status: "todo", dependsOn: ["T7"] }),
      makeTask({ id: "T2", status: "todo" }),
      makeTask({ id: "T3", status: "running" }),
      makeTask({ id: "T4", status: "ready_for_review" }),
      makeTask({ id: "T5", status: "approved" }),
      makeTask({ id: "T6", status: "failed" }),
      makeTask({ id: "T7", status: "cancelled" }),
    ],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    const all = dashboard.render(140).join("\n");
    for (const label of [
      "blocked · todo",
      "ready · todo",
      "running",
      "review needed · ready for review",
      "approved",
      "failed",
      "cancelled",
    ]) {
      assert.match(all, new RegExp(label));
    }

    for (const group of [
      "blocked",
      "ready",
      "running",
      "review needed",
      "approved",
      "failed",
      "cancelled",
    ]) {
      dashboard.handleInput("g");
      assert.match(dashboard.render(140)[0] ?? "", new RegExp(`filter: ${group}`));
    }
    dashboard.handleInput("g");
    assert.doesNotMatch(dashboard.render(140)[0] ?? "", /filter:/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard makes blockers and failure retry details prominent", () => {
  const failed = makeTask({
    status: "failed",
    dependsOn: ["T2", "missing"],
    attempts: [
      {
        index: 1,
        logFile: "missing.jsonl",
        model: "openai/model-a",
        provider: "openai",
        thinking: "medium",
        startedAt: 0,
        exitCode: 1,
        failureReason: {
          kind: "provider_failure",
          message: "provider quota exhausted",
          retryable: true,
        },
        usage: { input: 10, output: 2, cost: 0.01, turns: 1 },
        touchedFiles: [],
      },
    ],
  });
  const board: Board = {
    version: 1,
    nextTaskNumber: 3,
    tasks: [failed, makeTask({ id: "T2", status: "running" })],
  };
  const actions: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      selectTaskAction: (id, action) => actions.push(`${id}:${action}`),
    })
  );
  try {
    dashboard.handleInput("\x1b[B");
    const output = dashboard.render(140).join("\n");
    assert.match(output, /Blocked by: T2 \(running\), missing \(missing\)/);
    assert.match(output, /Failure: provider failure · provider quota exhausted · retryable/);
    assert.doesNotMatch(output, /r retry/);
    dashboard.handleInput("r");
    assert.deepEqual(actions, []);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard shows retryable review notes and compact attempt history", () => {
  const task = makeTask({
    status: "changes_requested",
    reviewNotes: "Tests fail on Windows.\nPreserve path separators.",
    attempts: [
      {
        index: 1,
        logFile: "attempt-1.jsonl",
        model: "anthropic/model-old",
        provider: "anthropic",
        thinking: "medium",
        startedAt: 0,
        failureReason: { kind: "executor_failure", message: "test failed", retryable: true },
        usage: { input: 10, output: 2, cost: 0.01, turns: 2 },
        touchedFiles: ["src/old.ts"],
      },
      {
        index: 2,
        logFile: "attempt-2.jsonl",
        model: "openai/model-new",
        provider: "openai",
        thinking: "high",
        startedAt: 1,
        finalReport: "implemented",
        reviewReport: "request changes",
        reviewNotes: "Tests fail on Windows.",
        reviewModel: "review-model",
        reviewProvider: "google",
        reviewUsage: { input: 5, output: 2, cost: 0.02, turns: 1 },
        usage: { input: 20, output: 4, cost: 0.03, turns: 3 },
        touchedFiles: ["src/dashboard.ts", "test/dashboard.test.ts"],
      },
    ],
  });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const actions: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      selectTaskAction: (id, action) => actions.push(`${id}:${action}`),
    })
  );
  try {
    const output = dashboard.render(160).join("\n");
    assert.match(output, /Failure: reviewer rejection/);
    assert.match(output, /Reviewer notes: Tests fail on Windows\. Preserve path separators\./);
    assert.match(
      output,
      /Latest #2: model openai\/model-new · provider openai · 3 turns · \$0\.0300/
    );
    assert.match(output, /Reviewer: model review-model · provider google · 1 turns · \$0\.0200/);
    assert.match(output, /Changed files: src\/dashboard\.ts, test\/dashboard\.test\.ts/);
    assert.match(output, /History: #1 executor failure · anthropic\/model-old · 2t · \$0\.0100/);
    assert.match(output, /History: #2 changes requested · openai\/model-new · 3t · \$0\.0300/);
    assert.match(output, /r retry/);

    dashboard.handleInput("r");
    assert.deepEqual(actions, ["T1:retry"]);
    assert.equal(task.status, "changes_requested");
  } finally {
    dashboard.dispose();
  }
});

test("dashboard resolves blocker ids with the board's canonical lookup", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 3,
    tasks: [
      makeTask({ status: "todo", dependsOn: [" t2 "] }),
      makeTask({ id: "T2", status: "approved" }),
    ],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    const output = dashboard.render(120).join("\n");
    assert.match(output, /ready · todo/);
    assert.doesNotMatch(output, /Blocked by:|\(missing\)/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard shows reviewer failures while the task remains ready for review", () => {
  const task = makeTask({
    status: "ready_for_review",
    attempts: [
      {
        index: 1,
        logFile: "missing.jsonl",
        thinking: "high",
        startedAt: 0,
        failureReason: {
          kind: "reviewer_failure",
          message: "reviewer gave no VERDICT line",
          retryable: true,
        },
        usage: { input: 4, output: 2, cost: 0.02, turns: 1 },
        touchedFiles: ["src/dashboard.ts"],
      },
    ],
  });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    assert.match(
      dashboard.render(140).join("\n"),
      /Failure: reviewer failure · reviewer gave no VERDICT line · retryable/
    );
  } finally {
    dashboard.dispose();
  }
});

test("dashboard is width-safe in its narrow single-pane layout", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    for (const width of [1, 20, 47, 48, 80, 140]) {
      for (const bodyHeight of [2, 7, 22]) {
        const sized = new Dashboard(fakeTheme, makeActions(board), { bodyHeight });
        try {
          const lines = sized.render(width);
          assert.equal(lines.length, bodyHeight + 3);
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
        } finally {
          sized.dispose();
        }
      }
    }
    assert.match(dashboard.render(20).join("\n"), /T1 · running/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard derives legacy launches and drills down through phase, task, and launch", () => {
  const task = makeTask({
    attempts: [
      {
        index: 1,
        logFile: "attempt.log",
        thinking: "low",
        startedAt: 1,
        usage: { input: 2, output: 1, cost: 0.01, turns: 1 },
        finalReport: "implemented",
        reviewReport: "VERDICT: APPROVE",
        reviewModel: "review/model",
        reviewProvider: "review",
        reviewUsage: { input: 1, output: 1, cost: 0.02, turns: 1 },
        touchedFiles: [],
      },
    ],
  });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  assert.deepEqual(
    taskLaunches(task).map((launch) => launch.kind),
    ["execute", "review"]
  );
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    dashboard.handleInput("\x1b[D");
    assert.match(dashboard.render(100).join("\n"), /Run › execution/);
    dashboard.handleInput("\x1b[C");
    assert.match(dashboard.render(100).join("\n"), /Run › execution › T1/);
    dashboard.handleInput("\x1b[C");
    assert.match(dashboard.render(100).join("\n"), /Run › execution › T1 › execute #1/);
    dashboard.handleInput("\x1b[B");
    assert.match(dashboard.render(100).join("\n"), /review #1 · single/);
  } finally {
    dashboard.dispose();
  }
});

test("constrained phase and launch panes keep later selections visible", () => {
  const attempts = [1, 2, 3].map((index) => ({
    index,
    logFile: `attempt-${index}.log`,
    thinking: "low",
    startedAt: index,
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    finalReport: `result ${index}`,
    touchedFiles: [],
  }));
  const task = makeTask({ status: "approved", attempts });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { bodyHeight: 2 });
  try {
    dashboard.handleInput("\x1b[D");
    for (let index = 0; index < 7; index += 1) dashboard.handleInput("\x1b[B");
    assert.match(dashboard.render(80).slice(1, 3).join("\n"), /complete/);

    dashboard.handleInput("\x1b[C");
    dashboard.handleInput("\x1b[C");
    dashboard.handleInput("\x1b[B");
    dashboard.handleInput("\x1b[B");
    assert.match(dashboard.render(80).slice(1, 3).join("\n"), /execute #3/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard evidence view exposes persisted execution, review, artifact, verification, and recovery data", () => {
  const task = makeTask({
    brief: "Implement the durable dashboard projection",
    successCriteria: ["Evidence is visible"],
    verificationProfile: "required",
    verificationSummary: "all checks passed",
    integratedCommit: "legacy-commit",
    findings: [
      {
        fingerprint: "finding-1",
        message: "inspect retained evidence",
        status: "verified",
        firstAttempt: 1,
        lastAttempt: 1,
      },
    ],
    provenance: {
      candidateTree: "candidate-tree",
      capturedAt: 1,
      integratedCommit: "integrated-commit",
      integratedTree: "integrated-tree",
      verifiedAt: 2,
      verificationProfile: "required",
    },
    attempts: [
      {
        index: 1,
        logFile: "missing.log",
        sessionFile: "executor-session.jsonl",
        model: "provider/executor",
        provider: "provider",
        thinking: "low",
        startedAt: 1,
        usage: { input: 15, output: 7, cost: 0.3, turns: 3 },
        reviewUsage: { input: 5, output: 2, cost: 0.1, turns: 1 },
        promptCharacters: 500,
        promptApproximateTokens: 125,
        finalReport: "implemented successfully",
        worktreePath: "/tmp/worktree",
        branch: "maestro/t1",
        touchedFiles: ["src/dashboard.ts"],
        reviewLaunches: [
          {
            id: "review-1",
            reviewerIndex: 1,
            role: "confirmer",
            verdict: "approve",
            model: "provider/reviewer",
            provider: "provider",
            sessionFile: "review-session.jsonl",
            startedAt: 2,
            usage: { input: 5, output: 2, cost: 0.1, turns: 1 },
            promptCharacters: 200,
            promptApproximateTokens: 50,
            finalReport: "VERDICT: APPROVE",
            criterionEvidence: [{ criterion: 1, passed: true, evidence: "observed" }],
          },
        ],
        reviewConvergence: {
          policy: "confirm",
          status: "approved",
          requiredApprovals: 1,
          actualApprovals: 1,
          reviewerCount: 1,
          summary: "converged",
          decidedAt: 3,
        },
      },
    ],
  });
  const board: Board = {
    version: 1,
    nextTaskNumber: 2,
    pausedDrive: { ownerSession: "owner.jsonl", taskIds: ["T1"] },
    activeDecision: {
      id: "decision-1",
      ownerSession: "owner.jsonl",
      kind: "review",
      taskIds: ["T1"],
      evidence: "human input required",
      allowedInterventions: ["steer"],
      createdAt: 4,
    },
    tasks: [task],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { bodyHeight: 40 });
  try {
    dashboard.handleInput("e");
    const output = dashboard.render(140).join("\n");
    for (const expected of [
      "Prompt source:",
      "Executor identity:",
      "Executor usage: 2 turns · $0.2000 · 10 input · 5 output",
      "Executor prompt:",
      "Final result:",
      "Reviewer: confirmer · approve",
      "Review usage:",
      "Criterion evidence:",
      "Convergence:",
      "Finding:",
      "Candidate tree: candidate-tree",
      "Integrated tree: integrated-tree",
      "Integration commit: integrated-commit",
      "Verification: passed",
      "Recovery refs:",
      "Paused drive:",
      "Decision: decision-1",
    ]) {
      assert.match(output, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    dashboard.dispose();
  }
});

test("projectEvidenceSections omits empty sections and is deterministic for a task with no attempts", () => {
  const task = makeTask({ brief: "Investigate the flaky retry path" });
  const extras = { phaseLabel: "execution" };
  const sections = projectEvidenceSections(task, undefined, extras);
  assert.deepEqual(
    sections.map((section) => section.title),
    ["Contract"]
  );
  assert.deepEqual(sections, projectEvidenceSections(task, undefined, extras));
});

test("projectEvidenceSections truncates a section past its line budget with an explicit marker", () => {
  const findings = Array.from({ length: 15 }, (_, index) => ({
    fingerprint: `finding-${index}`,
    message: `issue ${index}`,
    status: "open" as const,
    firstAttempt: 1,
    lastAttempt: 1,
  }));
  const task = makeTask({ findings });
  const sections = projectEvidenceSections(task, undefined, { phaseLabel: "execution" });
  const review = sections.find((section) => section.title === "Review");
  assert.ok(review);
  assert.equal(review.lines.length, 13);
  assert.equal(review.lines.at(-1), "… (+3 more — open session for full detail)");
  assert.ok(review.lines.slice(0, 12).every((line) => line.startsWith("Finding: ")));
});

test("projectEvidenceSections reflects the selected launch's attempt, not just the latest one", () => {
  const attempts = [1, 2].map((index) => ({
    index,
    logFile: `attempt-${index}.log`,
    thinking: "low" as const,
    startedAt: index,
    usage: { input: 1, output: 1, cost: 0.01 * index, turns: index },
    model: `model-${index}`,
    finalReport: `result ${index}`,
    touchedFiles: [],
  }));
  const task = makeTask({ attempts });
  const [firstLaunch] = taskLaunches(task);
  assert.ok(firstLaunch);
  const sections = projectEvidenceSections(task, firstLaunch, { phaseLabel: "execution" });
  const execution = sections.find((section) => section.title === "Execution");
  assert.ok(execution);
  assert.ok(execution.lines.some((line) => line.includes("model-1")));
  assert.ok(!execution.lines.some((line) => line.includes("model-2")));
});

test("dashboard evidence view shows the failure banner first, section headers in order, and accounting last", () => {
  const task = makeTask({
    status: "changes_requested",
    attempts: [
      {
        index: 1,
        logFile: "missing.log",
        thinking: "low",
        startedAt: 1,
        usage: { input: 10, output: 5, cost: 0.2, turns: 2 },
        promptCharacters: 100,
        promptApproximateTokens: 25,
        touchedFiles: ["src/dashboard.ts"],
        failureReason: {
          kind: "reviewer_rejection",
          message: "reviewer requested changes",
          retryable: true,
        },
      },
    ],
  });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { bodyHeight: 40 });
  try {
    dashboard.handleInput("e");
    const output = dashboard.render(140).join("\n");
    const bannerIndex = output.indexOf("Reason: reviewer rejection");
    const contractIndex = output.indexOf("Contract");
    const executionIndex = output.indexOf("Execution");
    const recoveryIndex = output.indexOf("Recovery");
    const accountingIndex = output.indexOf("Accounting");
    assert.ok(bannerIndex >= 0 && bannerIndex < contractIndex);
    assert.ok(contractIndex < executionIndex);
    assert.ok(executionIndex < recoveryIndex);
    assert.ok(recoveryIndex < accountingIndex);
    assert.ok(accountingIndex === output.lastIndexOf("Accounting"));
  } finally {
    dashboard.dispose();
  }
});

test("dashboard evidence view keeps the selected task fixed while switching launches", () => {
  const attempts = [1, 2].map((index) => ({
    index,
    logFile: `attempt-${index}.log`,
    thinking: "low" as const,
    startedAt: index,
    usage: { input: 1, output: 1, cost: 0.01 * index, turns: index },
    model: `model-${index}`,
    finalReport: `result ${index}`,
    touchedFiles: [],
  }));
  const task = makeTask({ attempts });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { bodyHeight: 40 });
  try {
    dashboard.handleInput("\x1b[D");
    dashboard.handleInput("\x1b[C");
    dashboard.handleInput("\x1b[C");
    let output = dashboard.render(140).join("\n");
    assert.match(output, /Run › execution › T1 › execute #1/);
    assert.match(output, /model-1/);

    dashboard.handleInput("\x1b[B");
    output = dashboard.render(140).join("\n");
    assert.match(output, /Run › execution › T1 › execute #2/);
    assert.match(output, /model-2/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard help lists every shared binding at width 80 and closes on the next key", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    dashboard.handleInput("?");
    const help = dashboard.render(80).join("\n");
    for (const binding of DASHBOARD_BINDINGS) {
      assert.ok(help.includes(binding.key), `missing ${binding.key}`);
    }
    dashboard.handleInput("z");
    assert.doesNotMatch(dashboard.render(80).join("\n"), /Dashboard help/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard footer uses the shared help binding label", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    const binding = DASHBOARD_BINDINGS.find((candidate) => candidate.key === "?");
    assert.ok(binding);
    assert.ok(
      (dashboard.render(100).at(-1) ?? "").includes(`${binding.key} ${binding.description}`)
    );
  } finally {
    dashboard.dispose();
  }
});

test("dashboard reuses the input frame for the following render", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  let reads = 0;
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      getBoard: () => {
        reads += 1;
        return board;
      },
    })
  );
  try {
    reads = 0;
    dashboard.handleInput("g");
    dashboard.render(100);
    assert.equal(reads, 1);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard snapshots the board once per render", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  let reads = 0;
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      getBoard: () => {
        reads += 1;
        return board;
      },
    })
  );
  try {
    reads = 0;
    dashboard.render(100);
    assert.equal(reads, 1);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard prefers live usage while settled tasks keep persisted usage", () => {
  const liveTask = makeTask({
    attempts: [
      {
        index: 1,
        logFile: "live.log",
        thinking: "medium",
        startedAt: 0,
        usage: { input: 10, output: 5, cost: 0.1, turns: 2 },
        touchedFiles: [],
      },
    ],
  });
  const settledTask = makeTask({
    id: "T2",
    status: "approved",
    attempts: [
      {
        index: 1,
        logFile: "settled.log",
        thinking: "medium",
        startedAt: 0,
        usage: { input: 20, output: 10, cost: 0.25, turns: 3 },
        touchedFiles: [],
      },
    ],
  });
  const board: Board = { version: 1, nextTaskNumber: 3, tasks: [liveTask, settledTask] };
  const originalBoard = structuredClone(board);
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      isLive: (taskId) => taskId === "T1",
      getLiveRun: (taskId) =>
        taskId === "T1" ? { cost: 0.9, turns: 7, lastActivity: "live now" } : undefined,
    })
  );
  try {
    const output = dashboard.render(160).join("\n");
    assert.match(output, /running \[standard\] · 7t · \$0\.9000/);
    assert.match(output, /Dependencies: none · 1 attempt · \$0\.9000 · 7 turns · live now/);
    assert.match(output, /approved \[standard\] · \$0\.2500/);
    assert.doesNotMatch(output, /approved \[standard\] · 3t/);
    assert.deepEqual(board, originalBoard);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard reads each live run once per frame for both row and summary", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 3,
    tasks: [makeTask(), makeTask({ id: "T2", status: "approved" })],
  };
  const reads = new Map<string, number>();
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      isLive: (taskId) => taskId === "T1",
      getLiveRun: (taskId) => {
        reads.set(taskId, (reads.get(taskId) ?? 0) + 1);
        return { cost: 0.5, turns: 4, lastActivity: "checking" };
      },
    })
  );
  try {
    reads.clear();
    const firstFrame = dashboard.render(160).join("\n");
    assert.match(firstFrame, /4t · \$0\.5000/);
    assert.match(firstFrame, /\$0\.5000 · 4 turns · checking/);
    assert.deepEqual([...reads], [["T1", 1]]);

    dashboard.render(160);
    assert.deepEqual([...reads], [["T1", 2]]);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard uses live terminal rows for its body height", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { getRows: () => 40 });
  try {
    assert.equal(dashboard.render(100).length, 40);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard counts only done tasks removed by the active filters", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 3,
    tasks: [makeTask(), makeTask({ id: "T2", status: "approved" })],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board));
  try {
    dashboard.handleInput("f");
    dashboard.handleInput("g");
    dashboard.handleInput("g");
    dashboard.handleInput("g");
    assert.match(dashboard.render(160)[0] ?? "", /filter: running · hiding 0 done/);
  } finally {
    dashboard.dispose();
  }
});

test("wrapText respects display width and prefers word boundaries", () => {
  const wide = wrapText("界".repeat(10), 10);
  assert.equal(wide.length, 2);
  assert.ok(wide.every((line) => visibleWidth(line) <= 10));
  assert.deepEqual(wrapText("hello world", 7), ["hello", "world"]);
});

test("dashboard keeps transcript scrollback fixed while output appends", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-maestro-dashboard-scroll-"));
  const logFile = join(directory, "executor.jsonl");
  const event = (text: string) =>
    `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
  writeFileSync(
    logFile,
    event(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"))
  );
  const board: Board = {
    version: 1,
    nextTaskNumber: 2,
    tasks: [
      makeTask({
        attempts: [
          {
            index: 1,
            logFile,
            thinking: "low",
            startedAt: 0,
            usage: { input: 0, output: 0, cost: 0, turns: 0 },
            touchedFiles: [],
          },
        ],
      }),
    ],
  };
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { bodyHeight: 10 });
  try {
    dashboard.render(100);
    dashboard.handleInput("\x1b[5~");
    const before = dashboard.render(100).filter((line) => line.includes("line "));
    appendFileSync(logFile, event("line 21\nline 22"));
    const after = dashboard.render(100).filter((line) => line.includes("line "));
    assert.deepEqual(after, before);
  } finally {
    dashboard.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("changes requested uses an error color distinct from running", () => {
  const colors: Array<[string, string]> = [];
  const theme = {
    fg: (color: string, text: string) => {
      colors.push([color, text]);
      return text;
    },
    bold: (text: string) => text,
  } as unknown as Theme;
  const board: Board = {
    version: 1,
    nextTaskNumber: 2,
    tasks: [makeTask({ status: "changes_requested" })],
  };
  const dashboard = new Dashboard(theme, makeActions(board));
  try {
    dashboard.render(100);
    assert.ok(colors.some(([color, text]) => color === "error" && text === "↻"));
  } finally {
    dashboard.dispose();
  }
});

test("live pane renders bounded empty, title, transcript, and settled states", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-maestro-live-pane-render-"));
  const logFile = join(directory, "executor.jsonl");
  writeFileSync(
    logFile,
    `${[
      { type: "tool_execution_start", toolName: "bash", args: { command: "pnpm test" } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first line\nsecond line" }],
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`
  );
  const theme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => text,
  } as unknown as Theme;
  let launches: LivePaneLaunch[] = [];
  const pane = new LivePaneComponent(theme, {
    getLaunches: () => launches,
    requestRender: () => {},
    onEscape: () => {},
    onCycleVisibility: () => {},
    height: 7,
  });
  try {
    assert.match(pane.render(80).join("\n"), /Agents settled/);
    launches = [
      {
        key: "execute:T1:one",
        taskId: "T1",
        title: "A deliberately long executor title",
        kind: "execute",
        logFile,
        model: "provider/model",
        turns: 2,
        cost: 0.25,
        lastActivity: "testing",
      },
    ];
    const lines = pane.render(80);
    const text = lines.join("\n");
    assert.ok(lines.length <= 7);
    assert.ok(lines.every((line) => visibleWidth(line) <= 80));
    assert.match(text, /<accent>T1 · A deliberately long executor title \[provider\/model\]/);
    assert.match(text, /<toolTitle>\$ pnpm test/);
    assert.match(text, /<toolOutput>second line/);
    assert.doesNotMatch(text, /▶ T1/, "one launch must not render the agent strip");

    launches = [];
    assert.match(pane.render(80).join("\n"), /✓ T1 settled/);
  } finally {
    pane.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live pane follows output and keeps manually scrolled rows anchored", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-maestro-live-pane-scroll-"));
  const logFile = join(directory, "executor.jsonl");
  const append = (text: string) =>
    appendFileSync(
      logFile,
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`
    );
  for (let index = 1; index <= 8; index += 1) append(`line ${index}`);
  const pane = new LivePaneComponent(fakeTheme, {
    getLaunches: () => [
      {
        key: "execute:T1:scroll",
        taskId: "T1",
        title: "Scroll",
        kind: "execute",
        logFile,
        turns: 1,
        cost: 0,
        lastActivity: "working",
      },
    ],
    requestRender: () => {},
    onEscape: () => {},
    onCycleVisibility: () => {},
    height: 5,
  });
  try {
    pane.focused = true;
    assert.match(pane.render(40).join("\n"), /line 8/);
    pane.handleInput("k");
    const anchored = pane.render(40);
    assert.doesNotMatch(anchored.join("\n"), /line 8/);
    append("line 9");
    assert.deepEqual(pane.render(40).slice(0, -1), anchored.slice(0, -1));
    pane.handleInput("G");
    assert.match(pane.render(40).join("\n"), /line 9/);
  } finally {
    pane.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live pane keeps selection stable and advances once when the selected launch settles", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-maestro-live-pane-select-"));
  const launch = (taskId: string): LivePaneLaunch => {
    const logFile = join(directory, `${taskId}.jsonl`);
    writeFileSync(
      logFile,
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `${taskId} transcript` }] } })}\n`
    );
    return {
      key: `execute:${taskId}`,
      taskId,
      title: `Task ${taskId}`,
      kind: "execute",
      logFile,
      turns: 1,
      cost: 0,
      lastActivity: "working",
    };
  };
  let launches = [launch("T1")];
  let cycleCalls = 0;
  const pane = new LivePaneComponent(fakeTheme, {
    getLaunches: () => launches,
    requestRender: () => {},
    onEscape: () => {},
    onCycleVisibility: () => {
      cycleCalls += 1;
    },
    height: 8,
  });
  try {
    assert.match(pane.render(80).join("\n"), /T1 transcript/);
    launches = [...launches, launch("T2"), launch("T3")];
    const three = pane.render(80).join("\n");
    assert.match(three, /▶ T1/);
    assert.match(three, /T1 transcript/);
    assert.doesNotMatch(three, /T2 transcript/);

    pane.focused = true;
    pane.handleInput("\x1b[C");
    assert.match(pane.render(80).join("\n"), /T2 transcript/);
    launches = launches.filter((launch) => launch.taskId !== "T2");
    const advanced = pane.render(80).join("\n");
    assert.match(advanced, /✓ T2 settled · following T3/);
    assert.match(advanced, /T3 transcript/);
    assert.equal(
      (
        pane
          .render(80)
          .join("\n")
          .match(/✓ T2 settled/g) ?? []
      ).length,
      1
    );

    pane.handleInput("\x1b\x17");
    assert.equal(cycleCalls, 1, "focused overlay input must handle ctrl+alt+w itself");
  } finally {
    pane.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live pane windows multiple agents without consuming every transcript row", () => {
  const launches: LivePaneLaunch[] = Array.from({ length: 8 }, (_, index) => ({
    key: `execute:T${index + 1}`,
    taskId: `T${index + 1}`,
    title: `Task ${index + 1}`,
    kind: "execute",
    logFile: `/missing/live-pane-${index + 1}.jsonl`,
    turns: 0,
    cost: 0,
    lastActivity: "starting",
  }));
  const pane = new LivePaneComponent(fakeTheme, {
    getLaunches: () => launches,
    requestRender: () => {},
    onEscape: () => {},
    onCycleVisibility: () => {},
    height: 5,
  });
  try {
    pane.focused = true;
    for (let index = 0; index < 5; index += 1) pane.handleInput("\x1b[C");
    const lines = pane.render(42);
    assert.ok(lines.length <= 5);
    assert.match(lines.join("\n"), /T6 · Task 6/);
    assert.match(lines.join("\n"), /Waiting for agent output/);
    assert.ok(lines.every((line) => visibleWidth(line) <= 42));
  } finally {
    pane.dispose();
  }
});

test("dashboard hides unavailable actions and ignores their keys while live", () => {
  const liveTask = makeTask({
    attempts: [
      {
        index: 1,
        sessionFile: "executor.jsonl",
        logFile: "missing.jsonl",
        thinking: "medium",
        startedAt: 0,
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
        finalReport: "persisted executor report",
        reviewReport: "persisted verdict",
        reviewSessionFile: "reviewer.jsonl",
        touchedFiles: [],
      },
    ],
  });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [liveTask] };
  const selected: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, {
      isLive: () => true,
      hasExecutorSession: () => true,
      hasReviewerSession: () => true,
      selectTaskAction: (_taskId, action) => selected.push(action),
    })
  );
  try {
    const footer = dashboard.render(120).at(-1) ?? "";
    assert.match(footer, /s steer · x abort/);
    assert.doesNotMatch(footer, /report|verdict|executor|reviewer|approve|reopen/);

    dashboard.handleInput("p");
    dashboard.handleInput("v");
    dashboard.handleInput("o");
    dashboard.handleInput("O");
    dashboard.handleInput("a");
    dashboard.handleInput("r");
    assert.deepEqual(selected, []);
  } finally {
    dashboard.dispose();
  }
});
