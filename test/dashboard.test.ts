import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Theme } from "@earendil-works/pi-coding-agent";
import {
  Dashboard,
  type DashboardActions,
  DEFAULT_DASHBOARD_BODY_HEIGHT,
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
    liveActivity: () => undefined,
    steer: () => {},
    abort: () => {},
    setTaskStatus: () => {},
    openSession: () => {},
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
    assert.match(joined, /maestro dashboard · 2 task\(s\)/);
    assert.match(joined, /T1 Do thing/);
    assert.match(joined, /T2 Do thing/);
    assert.match(joined, /esc close/);
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
    assert.match(output, /enter open session · a approve/);
    assert.doesNotMatch(output, /r reopen/);
  } finally {
    dashboard.dispose();
  }
});

test("dashboard only applies task actions valid for the selected state", () => {
  const task = makeTask({ status: "ready_for_review" });
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [task] };
  const changes: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, { setTaskStatus: (taskId, status) => changes.push(`${taskId}:${status}`) })
  );
  try {
    dashboard.handleInput("a");
    dashboard.handleInput("r");
    task.status = "failed";
    dashboard.handleInput("a");
    dashboard.handleInput("r");
    assert.deepEqual(changes, ["T1:approved", "T1:todo"]);
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

test("dashboard opens the selected task session", () => {
  const board: Board = { version: 1, nextTaskNumber: 2, tasks: [makeTask()] };
  const opened: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, { openSession: (taskId) => opened.push(taskId) })
  );
  try {
    dashboard.handleInput("o");
    assert.deepEqual(opened, ["T1"]);
  } finally {
    dashboard.dispose();
  }
});
