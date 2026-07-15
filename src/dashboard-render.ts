import { type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { bindingLabel, DASHBOARD_BINDINGS } from "./dashboard-controls.js";

export interface DashboardFooterView {
  mode: "browse" | "confirm_abort" | "confirm_accept" | string;
  pendingTaskId?: string;
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

export function renderDashboardHelp(theme: Theme, width: number, height: number): string[] {
  const lines = [theme.bold("Dashboard help")];
  for (const binding of DASHBOARD_BINDINGS) {
    lines.push(`${binding.context.padEnd(12)} ${binding.key.padEnd(12)} ${binding.description}`);
  }
  lines.push(theme.fg("dim", "Press any key to close help"));
  return lines.map((line) => truncateToWidth(line, width)).slice(0, height);
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
  if (view.navigationLevel === "phase") {
    const parts = [bindingLabel("↑↓"), bindingLabel("←→"), bindingLabel("esc")];
    return theme.fg("dim", truncateToWidth(` ${parts.join(" · ")} `, width));
  }

  const parts = [
    bindingLabel("?"),
    ...(view.planPending ? ["plan gated · /maestro plan to review"] : []),
    bindingLabel("↑↓"),
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
