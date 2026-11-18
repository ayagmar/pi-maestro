import { type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { bindingLabel, DASHBOARD_BINDINGS } from "./dashboard-controls.js";
import { wrapText } from "./dashboard-format.js";

export interface DashboardFooterView {
  mode: "browse" | "confirm_abort" | "confirm_accept" | "help" | "jump" | string;
  pendingTaskId?: string;
  /** Input and trailing hint for the jump prompt, shown while it is open. */
  jumpPrompt?: string;
  navigationLevel: "phase" | "task" | "launch";
  planPending: boolean;
  live: boolean;
  hasTask: boolean;
  canViewReport: boolean;
  canViewReview: boolean;
  canOpenExecutor: boolean;
  canOpenReviewer: boolean;
  canApprove: boolean;
  canSetManualStatus: boolean;
  canRetry: boolean;
  groupFilter: string;
}

/** Why a binding cannot be used right now, keyed by binding key. Absent means available. */
export type DashboardUnavailable = ReadonlyMap<string, string>;

export interface DashboardHelpPage {
  lines: string[];
  /** The scroll offset actually applied after clamping to the content. */
  scroll: number;
  /** Rows of help content visible at once, so callers can page by a screenful. */
  pageSize: number;
}

/** Every binding, grouped by context, wrapped to `width`, with unavailable rows labelled. */
export function dashboardHelpLines(
  theme: Theme,
  width: number,
  unavailable: DashboardUnavailable
): string[] {
  const keyWidth = Math.max(...DASHBOARD_BINDINGS.map((binding) => binding.key.length));
  const indent = Math.min(keyWidth + 3, Math.max(2, Math.floor(width / 2)));
  const contexts = [...new Set(DASHBOARD_BINDINGS.map((binding) => binding.context))];
  const lines: string[] = [];
  for (const context of contexts) {
    lines.push(theme.fg("accent", truncateToWidth(context, width)));
    for (const binding of DASHBOARD_BINDINGS) {
      if (binding.context !== context) continue;
      const reason = unavailable.get(binding.key);
      const text = reason ? `${binding.description} · unavailable: ${reason}` : binding.description;
      const wrapped = wrapText(text, Math.max(1, width - indent));
      const lead = `  ${binding.key}`.padEnd(indent);
      wrapped.forEach((part, index) => {
        const line = `${index === 0 ? lead : " ".repeat(indent)}${part}`;
        lines.push(truncateToWidth(reason ? theme.fg("dim", line) : line, width));
      });
    }
  }
  return lines;
}

/**
 * One scrollable page of help in `height` rows, the last of which always shows
 * how to scroll and close. Nothing is dropped: the rest is reachable by scrolling.
 */
export function renderDashboardHelp(
  theme: Theme,
  width: number,
  height: number,
  scroll: number,
  unavailable: DashboardUnavailable = new Map()
): DashboardHelpPage {
  const rows = Math.max(1, Math.floor(height));
  const all = [theme.bold("Dashboard help"), ...dashboardHelpLines(theme, width, unavailable)];
  const pageSize = Math.max(0, rows - 1);
  const maxScroll = Math.max(0, all.length - pageSize);
  const offset = Math.min(Math.max(0, Math.floor(scroll) || 0), maxScroll);
  const shown = all.slice(offset, offset + pageSize);
  const position =
    maxScroll > 0 ? `${offset + 1}-${offset + shown.length}/${all.length} ↑↓ scroll · ` : "";
  const hint = theme.fg("dim", `${position}esc close`);
  return {
    lines: [...shown, hint].map((line) => truncateToWidth(line, width)),
    scroll: offset,
    pageSize: Math.max(1, pageSize),
  };
}

export function renderDashboardFooter(
  theme: Theme,
  width: number,
  view: DashboardFooterView
): string {
  if (view.mode === "confirm_abort" && view.pendingTaskId) {
    return theme.fg(
      "error",
      ` Abort ${view.pendingTaskId}? Press y to confirm, any other key to cancel `
    );
  }
  if (view.mode === "confirm_accept" && view.pendingTaskId) {
    return theme.fg(
      "warning",
      ` Approve ${view.pendingTaskId} without review? Press y to confirm, any other key to cancel `
    );
  }
  if (view.mode === "help") {
    return theme.fg("dim", truncateToWidth(" ↑↓ PgUp/PgDn scroll · esc close help ", width));
  }
  if (view.mode === "jump") {
    return truncateToWidth(` ${theme.fg("accent", "jump ▸")} ${view.jumpPrompt ?? ""}`, width);
  }
  if (view.navigationLevel === "phase") {
    const parts = [
      bindingLabel("?"),
      bindingLabel("↑↓"),
      bindingLabel("←→"),
      bindingLabel("/"),
      bindingLabel("esc"),
    ];
    return theme.fg("dim", truncateToWidth(` ${parts.join(" · ")} `, width));
  }

  const parts = [
    bindingLabel("?"),
    ...(view.planPending ? ["plan gated · /maestro plan to review"] : []),
    bindingLabel("↑↓"),
    bindingLabel("/"),
    bindingLabel("esc"),
    bindingLabel("PgUp/PgDn"),
  ];
  if (view.live) {
    parts.push(bindingLabel("s"), bindingLabel("F"), bindingLabel("x"));
  } else if (view.hasTask) {
    if (view.canViewReport) parts.push(bindingLabel("p"));
    if (view.canViewReview) parts.push(bindingLabel("v"));
    if (view.canOpenExecutor) parts.push(bindingLabel("enter"));
    if (view.canOpenReviewer) parts.push(bindingLabel("O"));
    if (view.canApprove) parts.push(bindingLabel("a"));
    if (view.canSetManualStatus) parts.push(bindingLabel("m"));
    if (view.canRetry) parts.push(bindingLabel("r"));
  }
  parts.push(
    `${bindingLabel("g")} (${view.groupFilter})`,
    bindingLabel("t"),
    bindingLabel("e"),
    bindingLabel("f"),
    bindingLabel("←→")
  );
  return theme.fg("dim", truncateToWidth(` ${parts.join(" · ")} `, width));
}
