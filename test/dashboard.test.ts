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
  const dashboard = new Dashboard(fakeTheme, makeActions(board), { bodyHeight: 3 });
  try {
    const lines = dashboard.render(100);
    const body = lines.slice(1, 4).join("\n");

    assert.equal(lines.length, 6);
    assert.match(body, /T2 Do thing/);
    assert.doesNotMatch(body, /T3 Do thing/);
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

test("dashboard approve/reopen shortcuts only work on finished tasks", () => {
  const board: Board = {
    version: 1,
    nextTaskNumber: 2,
    tasks: [makeTask({ status: "ready_for_review" })],
  };
  const changes: string[] = [];
  const dashboard = new Dashboard(
    fakeTheme,
    makeActions(board, { setTaskStatus: (taskId, status) => changes.push(`${taskId}:${status}`) })
  );
  try {
    dashboard.handleInput("a");
    dashboard.handleInput("r");
    assert.deepEqual(changes, ["T1:approved", "T1:todo"]);
  } finally {
    dashboard.dispose();
  }
});
