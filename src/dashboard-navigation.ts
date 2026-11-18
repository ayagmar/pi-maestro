import { type DashboardLaunch } from "./dashboard-launches.js";
import { type Task, type TaskGroup } from "./types.js";

export type DashboardFilter = "all" | TaskGroup;

export const DASHBOARD_GROUPS: readonly TaskGroup[] = [
  "blocked",
  "ready",
  "running",
  "review-needed",
  "approved",
  "failed",
  "cancelled",
];

export const DASHBOARD_FILTERS: readonly DashboardFilter[] = ["all", ...DASHBOARD_GROUPS];

export function visibleDashboardTasks(
  grouped: Record<TaskGroup, Task[]>,
  filter: DashboardFilter,
  phaseTaskIds: readonly string[] | undefined,
  hideDone: boolean
): Task[] {
  let tasks =
    filter === "all" ? DASHBOARD_GROUPS.flatMap((group) => grouped[group]) : grouped[filter];
  if (phaseTaskIds) {
    const scopedIds = new Set(phaseTaskIds);
    tasks = tasks.filter((task) => scopedIds.has(task.id));
  }
  if (!hideDone) return tasks;
  return tasks.filter((task) => task.status !== "approved" && task.status !== "cancelled");
}

export function stableTaskSelection(
  tasks: readonly Task[],
  selectedTaskId: string | undefined,
  selectedIndex: number
): { index: number; task: Task | undefined } {
  const stableIndex = selectedTaskId ? tasks.findIndex((task) => task.id === selectedTaskId) : -1;
  const index = stableIndex >= 0 ? stableIndex : clampSelectionIndex(selectedIndex, tasks.length);
  return { index, task: tasks[index] };
}

export function stableLaunchSelection(
  launches: readonly DashboardLaunch[],
  selectedLaunchKey: string | undefined,
  selectedIndex: number
): { index: number; launch: DashboardLaunch | undefined } {
  const stableIndex = selectedLaunchKey
    ? launches.findIndex((launch) => launch.key === selectedLaunchKey)
    : -1;
  const index =
    stableIndex >= 0 ? stableIndex : clampSelectionIndex(selectedIndex, launches.length);
  return { index, launch: launches[index] };
}

export interface TaskListWindow {
  start: number;
  end: number;
  showTop: boolean;
  showBottom: boolean;
}

/**
 * Pick the rows of a two-line-per-task list that fit `height`: as many tasks as
 * fit, centred on the selection, with one marker row each for hidden tasks
 * above or below. The last task's detail row may be dropped by the renderer,
 * hence the `height + 1` budget. Work is bounded by the window size, not by
 * the task count, and a height below one row yields an empty window.
 */
export function taskListWindow(
  taskCount: number,
  selected: number,
  height: number
): TaskListWindow {
  const count = Number.isFinite(taskCount) ? Math.max(0, Math.floor(taskCount)) : 0;
  if (count === 0) return { start: 0, end: 0, showTop: false, showBottom: false };
  const selectedIndex = clampSelectionIndex(selected, count);
  const rows = Number.isNaN(height) ? 0 : Math.floor(Math.min(height, count * 2 + 2));
  if (rows < 1)
    return { start: selectedIndex, end: selectedIndex, showTop: false, showBottom: false };

  const best = bestTaskWindow(count, selectedIndex, rows);
  const start = best?.start ?? selectedIndex;
  const end = best ? best.start + best.size : selectedIndex + 1;
  let showTop = start > 0;
  let showBottom = end < count;
  // Marker rows never crowd out the task row itself: drop the bottom one first.
  if (Number(showTop) + Number(showBottom) + 1 > rows) showBottom = false;
  if (Number(showTop) + 1 > rows) showTop = false;
  return { start, end, showTop, showBottom };
}

function bestTaskWindow(
  count: number,
  selectedIndex: number,
  rows: number
): { start: number; size: number } | undefined {
  for (let size = Math.min(count, Math.floor((rows + 1) / 2)); size >= 1; size -= 1) {
    const lowest = Math.max(0, selectedIndex - size + 1);
    const highest = Math.min(selectedIndex, count - size);
    const ideal = selectedIndex - (size - 1) / 2;
    // Marker rows only get cheaper at the list edges and the distance to the
    // centre is convex, so the best start is one of these few candidates.
    const candidates = [
      lowest,
      Math.min(highest, Math.max(lowest, Math.floor(ideal))),
      Math.min(highest, Math.max(lowest, Math.ceil(ideal))),
      0,
      count - size,
      highest,
    ]
      .filter((start) => start >= lowest && start <= highest)
      .sort((a, b) => a - b);
    let found: { start: number; distance: number } | undefined;
    for (const start of candidates) {
      const markerRows = (start > 0 ? 1 : 0) + (start + size < count ? 1 : 0);
      if (markerRows + size * 2 > rows + 1) continue;
      const distance = Math.abs(selectedIndex - (2 * start + size - 1) / 2);
      if (!found || distance < found.distance) found = { start, distance };
    }
    if (found) return { start: found.start, size };
  }
  return undefined;
}

/** The task whose id a query names exactly: `T12`, `t12`, or the bare number `12`. */
export function findTaskByExactId(tasks: readonly Task[], query: string): Task | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const byId = (id: string) => tasks.find((task) => task.id.toLowerCase() === id);
  return byId(needle) ?? (/^\d+$/.test(needle) ? byId(`t${needle}`) : undefined);
}

/** First task whose id starts with, or whose title contains, the query. */
export function findTaskByFragment(tasks: readonly Task[], query: string): Task | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    tasks.find((task) => task.id.toLowerCase().startsWith(needle)) ??
    tasks.find((task) => task.title.toLowerCase().includes(needle))
  );
}

/** Exact id or number first, then an id prefix or title fragment, within one list. */
export function findTaskByQuery(tasks: readonly Task[], query: string): Task | undefined {
  return findTaskByExactId(tasks, query) ?? findTaskByFragment(tasks, query);
}

export function visibleSelectionWindow<T>(
  items: readonly T[],
  selected: number,
  height: number
): Array<{ item: T; index: number }> {
  const rows = Number.isNaN(height) ? 0 : Math.floor(Math.min(height, items.length));
  if (rows < 1) return [];
  const center = clampSelectionIndex(selected, items.length);
  const start = Math.max(0, Math.min(center - Math.floor(rows / 2), items.length - rows));
  return items.slice(start, start + rows).map((item, offset) => ({ item, index: start + offset }));
}

function clampSelectionIndex(selectedIndex: number, itemCount: number): number {
  const index = Number.isNaN(selectedIndex) ? 0 : Math.trunc(selectedIndex);
  return Math.min(Math.max(0, index), Math.max(0, itemCount - 1));
}
