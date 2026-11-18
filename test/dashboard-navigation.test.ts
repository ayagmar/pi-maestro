import assert from "node:assert/strict";
import test from "node:test";
import { createTask, groupTasks } from "../src/board.js";
import { type DashboardLaunch } from "../src/dashboard-launches.js";
import {
  findTaskByExactId,
  findTaskByFragment,
  findTaskByQuery,
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

/** The original exhaustive search, kept as the specification for the bounded one. */
function exhaustiveWindow(taskCount: number, selected: number, height: number) {
  const selectedIndex = Math.min(Math.max(0, selected), taskCount - 1);
  let best = { start: selectedIndex, end: selectedIndex + 1, count: 0, distance: Infinity };
  for (let start = 0; start <= selectedIndex; start += 1) {
    for (let end = selectedIndex + 1; end <= taskCount; end += 1) {
      const markers = (start > 0 ? 1 : 0) + (end < taskCount ? 1 : 0);
      if (markers + (end - start) * 2 > height + 1) continue;
      const distance = Math.abs(selectedIndex - (start + end - 1) / 2);
      if (end - start > best.count || (end - start === best.count && distance < best.distance)) {
        best = { start, end, count: end - start, distance };
      }
    }
  }
  let showTop = best.start > 0;
  let showBottom = best.end < taskCount;
  while (Number(showTop) + Number(showBottom) + 1 > height && height >= 1) {
    if (showBottom) showBottom = false;
    else showTop = false;
  }
  return { start: best.start, end: best.end, showTop, showBottom };
}

test("dashboard list window picks the same rows as an exhaustive search", () => {
  for (let count = 1; count <= 14; count++) {
    for (let selected = 0; selected < count; selected++) {
      for (let height = 1; height <= 30; height++) {
        assert.deepEqual(
          taskListWindow(count, selected, height),
          exhaustiveWindow(count, selected, height),
          `count ${count} selected ${selected} height ${height}`
        );
      }
    }
  }
});

test("dashboard list window stays cheap for huge boards and terminates on degenerate heights", () => {
  const started = performance.now();
  const huge = taskListWindow(200_000, 100_000, 60);
  assert.ok(huge.start <= 100_000 && huge.end > 100_000);
  assert.ok((huge.end - huge.start) * 2 + 2 <= 62);
  for (const height of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(taskListWindow(50, 10, height), {
      start: 10,
      end: 10,
      showTop: false,
      showBottom: false,
    });
  }
  assert.deepEqual(taskListWindow(0, 0, 10), {
    start: 0,
    end: 0,
    showTop: false,
    showBottom: false,
  });
  const unbounded = taskListWindow(10, 3, Number.POSITIVE_INFINITY);
  assert.deepEqual([unbounded.start, unbounded.end], [0, 10]);
  assert.ok(performance.now() - started < 250, "window math must not scale with task count");
});

test("dashboard selection helpers tolerate empty lists and out-of-range selections", () => {
  assert.deepEqual(visibleSelectionWindow(["a", "b"], 1, 0), []);
  assert.deepEqual(visibleSelectionWindow(["a", "b"], 1, -3), []);
  assert.deepEqual(visibleSelectionWindow([], 0, 5), []);
  assert.deepEqual(visibleSelectionWindow(["a", "b", "c"], 99, 2), [
    { item: "b", index: 1 },
    { item: "c", index: 2 },
  ]);
  assert.equal(stableTaskSelection([], "T1", Number.NaN).index, 0);
  assert.equal(stableTaskSelection(taskBoard().tasks, undefined, Number.NaN).task?.id, "T1");
});

test("dashboard task query prefers exact ids and bare numbers over fragments", () => {
  const tasks = taskBoard().tasks;
  tasks[0] = { ...tasks[0], id: "T10", title: "Ten" } as (typeof tasks)[number];
  tasks[1] = { ...tasks[1], id: "T1", title: "Parser for T10" } as (typeof tasks)[number];
  assert.equal(findTaskByQuery(tasks, "1")?.id, "T1");
  assert.equal(findTaskByQuery(tasks, "t10")?.id, "T10");
  assert.equal(findTaskByQuery(tasks, "pars")?.id, "T1");
  assert.equal(findTaskByQuery(tasks, "  "), undefined);
  assert.equal(findTaskByQuery(tasks, "nothing"), undefined);
});

test("dashboard exact task lookup ignores fragments so callers can scope them separately", () => {
  const tasks = taskBoard().tasks;
  assert.equal(findTaskByExactId(tasks, "2")?.id, "T2");
  assert.equal(findTaskByExactId(tasks, "T"), undefined);
  assert.equal(findTaskByExactId(tasks, "sec"), undefined);
  assert.equal(findTaskByFragment(tasks, "sec")?.id, "T2");
  assert.equal(findTaskByFragment(tasks, "T"), tasks[0]);
});
