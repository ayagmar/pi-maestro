import assert from "node:assert/strict";
import test from "node:test";
import { createTask, groupTasks } from "../src/board.js";
import { type DashboardLaunch } from "../src/dashboard-launches.js";
import {
  stableLaunchSelection,
  stableTaskSelection,
  taskListWindow,
  visibleDashboardTasks,
  visibleSelectionWindow,
} from "../src/dashboard-navigation.js";
import { type Board } from "../src/types.js";

function taskBoard(): Board {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const first = createTask(board, { title: "First", brief: "first", tier: "standard" });
  const second = createTask(board, { title: "Second", brief: "second", tier: "standard" });
  const third = createTask(board, { title: "Third", brief: "third", tier: "standard" });
  first.status = "todo";
  second.status = "approved";
  third.status = "cancelled";
  return board;
}

test("dashboard task selection stays on the same task across board reordering", () => {
  const board = taskBoard();
  const reordered = [board.tasks[2], board.tasks[0], board.tasks[1]].filter(
    (task) => task !== undefined
  );

  const selection = stableTaskSelection(reordered, "T1", 2);

  assert.equal(selection.task?.id, "T1");
  assert.equal(selection.index, 1);
});

test("dashboard task selection clamps when filtering removes the selected task", () => {
  const board = taskBoard();
  const visible = visibleDashboardTasks(groupTasks(board), "all", undefined, true);

  const selection = stableTaskSelection(visible, "T2", 4);

  assert.deepEqual(
    visible.map((task) => task.id),
    ["T1"]
  );
  assert.equal(selection.task?.id, "T1");
  assert.equal(selection.index, 0);
});

test("dashboard phase scope and workflow filter compose before done filtering", () => {
  const board = taskBoard();
  const visible = visibleDashboardTasks(groupTasks(board), "approved", ["T1", "T2"], false);

  assert.deepEqual(
    visible.map((task) => task.id),
    ["T2"]
  );
});

test("dashboard list window keeps the selection visible with bounded overflow markers", () => {
  const window = taskListWindow(20, 10, 7);

  assert.ok(window.start <= 10);
  assert.ok(window.end > 10);
  assert.equal(window.showTop, true);
  assert.equal(window.showBottom, true);
  assert.ok(
    Number(window.showTop) + Number(window.showBottom) + (window.end - window.start) * 2 <= 8
  );
});

test("dashboard selection window centers the current item when space allows", () => {
  const visible = visibleSelectionWindow(["a", "b", "c", "d", "e"], 3, 3);

  assert.deepEqual(visible, [
    { item: "c", index: 2 },
    { item: "d", index: 3 },
    { item: "e", index: 4 },
  ]);
});

test("dashboard launch selection remains stable when launches are appended", () => {
  const launch = (key: string) => ({ key }) as DashboardLaunch;
  const launches = [launch("execute:1"), launch("review:1"), launch("review:2")];

  const selection = stableLaunchSelection(launches, "review:1", 0);

  assert.equal(selection.launch?.key, "review:1");
  assert.equal(selection.index, 1);
});
