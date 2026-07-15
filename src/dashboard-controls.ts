import { type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export const REFRESH_MS = 500;
export const DEFAULT_DASHBOARD_BODY_HEIGHT = 22;

export const DASHBOARD_BINDINGS = [
  { key: "↑↓", context: "Navigation", description: "tasks/phases" },
  { key: "←→", context: "Navigation", description: "levels" },
  { key: "PgUp/PgDn", context: "Navigation", description: "scroll" },
  { key: "esc", context: "Navigation", description: "close" },
  { key: "s", context: "Task", description: "steer" },
  { key: "F", context: "Task", description: "follow-up" },
  { key: "x", context: "Task", description: "abort" },
  { key: "a", context: "Task", description: "approve (review bypass)" },
  { key: "m", context: "Task", description: "manual status" },
  { key: "r", context: "Task", description: "retry" },
  { key: "p", context: "Task", description: "report" },
  { key: "v", context: "Task", description: "verdict" },
  { key: "o", context: "Task", description: "executor session" },
  { key: "O", context: "Task", description: "reviewer session" },
  { key: "e", context: "Task", description: "evidence" },
  { key: "g", context: "View", description: "group filter" },
  { key: "f", context: "View", description: "hide done" },
  { key: "t", context: "View", description: "transcript/timeline" },
  { key: "enter", context: "View", description: "executor session" },
  { key: "?", context: "View", description: "help" },
] as const;

export const STEER_OPTIONS = [
  "Stop - wrong approach, report current state",
  "Run the project checks before finishing",
  "Stay strictly within the task brief scope",
  "Custom message...",
] as const;

export function steerTemplateLines(
  theme: Theme,
  selected: number,
  width: number,
  height: number
): string[] {
  const optionRows = Math.min(STEER_OPTIONS.length, height);
  const firstOption = Math.min(
    Math.max(0, selected - optionRows + 1),
    STEER_OPTIONS.length - optionRows
  );
  const lines = STEER_OPTIONS.slice(firstOption, firstOption + optionRows).map((option, offset) => {
    const index = firstOption + offset;
    const marker = index === selected ? "▶ " : "  ";
    const text = truncateToWidth(`${marker}${option}`, width);
    return index === selected ? theme.fg("accent", text) : text;
  });
  if (height > STEER_OPTIONS.length) {
    lines.push(theme.fg("dim", "↑↓ select · enter choose · esc cancel"));
  }
  return lines;
}

export function bindingLabel(key: (typeof DASHBOARD_BINDINGS)[number]["key"]): string {
  const binding = DASHBOARD_BINDINGS.find((candidate) => candidate.key === key);
  return binding ? `${binding.key} ${binding.description}` : key;
}
