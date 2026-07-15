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

export function taskListWindow(
  taskCount: number,
  selected: number,
  height: number
): TaskListWindow {
  const selectedIndex = Math.min(Math.max(0, selected), taskCount - 1);
  let bestStart = selectedIndex;
  let bestEnd = selectedIndex + 1;
  let bestTaskCount = 0;
  let bestDistanceFromCenter = Number.POSITIVE_INFINITY;

  for (let start = 0; start <= selectedIndex; start += 1) {
    for (let end = selectedIndex + 1; end <= taskCount; end += 1) {
      const markerRows = (start > 0 ? 1 : 0) + (end < taskCount ? 1 : 0);
      const visibleTasks = end - start;
      if (markerRows + visibleTasks * 2 > height + 1) continue;

      const distanceFromCenter = Math.abs(selectedIndex - (start + end - 1) / 2);
      if (
        visibleTasks > bestTaskCount ||
        (visibleTasks === bestTaskCount && distanceFromCenter < bestDistanceFromCenter)
      ) {
        bestStart = start;
        bestEnd = end;
        bestTaskCount = visibleTasks;
        bestDistanceFromCenter = distanceFromCenter;
      }
    }
  }

  let showTop = bestStart > 0;
  let showBottom = bestEnd < taskCount;
  while (Number(showTop) + Number(showBottom) + 1 > height) {
    if (showBottom) showBottom = false;
    else showTop = false;
  }
  return { start: bestStart, end: bestEnd, showTop, showBottom };
}

export function visibleSelectionWindow<T>(items: readonly T[], selected: number, height: number) {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  return items
    .slice(start, start + height)
    .map((item, offset) => ({ item, index: start + offset }));
}

function clampSelectionIndex(selectedIndex: number, itemCount: number): number {
  return Math.min(Math.max(0, selectedIndex), Math.max(0, itemCount - 1));
}
