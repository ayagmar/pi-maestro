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

function clampSelectionIndex(selectedIndex: number, itemCount: number): number {
  return Math.min(Math.max(0, selectedIndex), Math.max(0, itemCount - 1));
}
