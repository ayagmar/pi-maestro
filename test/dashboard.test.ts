import assert from "node:assert/strict";
import test from "node:test";
import { type Theme } from "@earendil-works/pi-coding-agent";
import { Dashboard, type DashboardActions } from "../src/dashboard.js";
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
    assert.match(joined, /maestro dashboard · 2 task\(s\)/);
    assert.match(joined, /T1 Do thing/);
    assert.match(joined, /T2 Do thing/);
    assert.match(joined, /esc close/);
  } finally {
    dashboard.dispose();
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
    dashboard.handleInput("s"); // enter steer mode
    for (const ch of "focus on tests") dashboard.handleInput(ch);
    dashboard.handleInput("\r"); // submit
    assert.deepEqual(steered, ["T1:focus on tests"]);
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
