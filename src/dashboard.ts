import { type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { completionFreshness } from "./artifact-policy.js";
import {
  blockedReason,
  findTask,
  groupTasks,
  type HumanRetryEligibility,
  taskGroup,
} from "./board.js";
import {
  bindingLabel,
  DASHBOARD_BINDINGS,
  DEFAULT_DASHBOARD_BODY_HEIGHT,
  REFRESH_MS,
  STEER_OPTIONS,
  steerTemplateLines,
} from "./dashboard-controls.js";
import { projectEvidenceSections } from "./dashboard-evidence.js";
import {
  attemptDetails,
  attemptHistory,
  executorUsage,
  lastAttemptReport,
  latestFailure,
  padToWidth,
  relativeTime,
  singleLine,
  wrapText,
} from "./dashboard-format.js";

import { type DashboardLaunch, taskLaunches } from "./dashboard-launches.js";
import {
  type DashboardFilter,
  DASHBOARD_FILTERS,
  stableLaunchSelection,
  stableTaskSelection,
  visibleDashboardTasks,
} from "./dashboard-navigation.js";
import {
  boardUsage,
  formatCostSummary,
  formatStatusHistory,
  STATUS_GLYPHS,
  STATUS_LABELS,
  taskUsage,
} from "./format.js";
import { styledTranscriptLines } from "./live-pane.js";
import { projectRunPhases, projectStatus } from "./status.js";
import { deriveRunTimeline, formatRunTimeline } from "./timeline.js";
import { TranscriptTail } from "./transcript.js";
import {
  type Board,
  type MaestroConfig,
  type Task,
  type TaskGroup,
  type TaskStatus,
} from "./types.js";

export { DASHBOARD_BINDINGS, DEFAULT_DASHBOARD_BODY_HEIGHT } from "./dashboard-controls.js";
export {
  type EvidenceExtras,
  type EvidenceSection,
  projectEvidenceSections,
} from "./dashboard-evidence.js";
export { wrapText } from "./dashboard-format.js";
export { type DashboardLaunch, taskLaunches } from "./dashboard-launches.js";
export {
  LivePaneComponent,
  type LivePaneLaunch,
  type LivePaneOptions,
  styledTranscriptLines,
} from "./live-pane.js";

export type DashboardTaskAction =
  | "retry"
  | "view_report"
  | "view_review"
  | "open_executor"
  | "open_reviewer";

export interface DashboardActions {
  getBoard(): Board;
  getConfig?(): MaestroConfig;
  isLive(taskId: string): boolean;
  liveKind(taskId: string): "execute" | "review" | undefined;
  liveActivity(taskId: string): string | undefined;
  getLiveRun?(taskId: string): { cost: number; turns: number; lastActivity: string } | undefined;
  steer(taskId: string, message: string): void;
  followUp(taskId: string, message: string): void;
  abort(taskId: string): void;
  setTaskStatus(taskId: string, status: TaskStatus): void;
  hasExecutorSession(taskId: string): boolean;
  hasReviewerSession(taskId: string): boolean;
  retryEligibility(taskId: string): HumanRetryEligibility;
  /** Close the dashboard and route an inspection action through the command helpers. */
  selectTaskAction(taskId: string, action: DashboardTaskAction): void;
  close(): void;
  requestRender(): void;
  getLatestArchive?(): { name: string; at: number } | undefined;
  getStatusHistory?():
    | {
        entries: readonly { ts: string; taskId: string; from: TaskStatus; to: TaskStatus }[];
        skipped: number;
      }
    | undefined;
}

const MIN_DASHBOARD_BODY_HEIGHT = 2;

type Mode =
  | "browse"
  | "steer_templates"
  | "steer"
  | "follow_up"
  | "manual_status"
  | "confirm_abort"
  | "confirm_accept"
  | "help";
type ConfirmAction = "abort" | "accept";
type NavigationLevel = "phase" | "task" | "launch";
type DetailView = "transcript" | "timeline" | "summary" | "evidence";

const GROUP_LABELS: Record<TaskGroup, string> = {
  blocked: "blocked",
  ready: "ready",
  running: "running",
  "review-needed": "review needed",
  approved: "approved",
  failed: "failed",
  cancelled: "cancelled",
};

const MANUAL_STATUS_OPTIONS: readonly TaskStatus[] = [
  "todo",
  "ready_for_review",
  "changes_requested",
  "approved",
  "cancelled",
];

function isManualStatusEligible(task: Task, isLive: boolean): boolean {
  if (isLive) return false;
  return !(["approved", "failed", "cancelled"] as TaskStatus[]).includes(task.status);
}

export interface DashboardOptions {
  /** Number of rows shared by the task list and transcript panes. */
  bodyHeight?: number;
  /** Live terminal row count. */
  getRows?: () => number;
  /** Initial information level shown when the dashboard opens. */
  initialView?: "phase" | "task";
}

type DashboardFrame = {
  board: Board;
  config: MaestroConfig | undefined;
  grouped: ReturnType<typeof groupTasks>;
  phases: ReturnType<typeof projectRunPhases>;
  staleTaskIds: Set<string>;
  liveRuns: Map<string, { cost: number; turns: number; lastActivity: string }>;
};

function statusColor(status: TaskStatus): "success" | "error" | "warning" | "accent" | "muted" {
  if (status === "approved") return "success";
  if (status === "failed" || status === "cancelled" || status === "changes_requested")
    return "error";
  if (status === "running") return "warning";
  if (status === "ready_for_review") return "accent";
  return "muted";
}

/**
 * Full-screen live dashboard: task list on the left, live transcript of the
 * selected task on the right (tailed from the executor's JSONL event log).
 * Refreshes itself twice a second while open.
 */
export class Dashboard {
  private _focused = false;
  private selected = 0;
  private selectedTaskId: string | undefined;
  private navigationLevel: NavigationLevel = "task";
  private phaseIndex = 0;
  private phaseScoped = false;
  private launchIndex = 0;
  private selectedLaunchKey: string | undefined;
  private mode: Mode = "browse";
  private pendingConfirm: { taskId: string; action: ConfirmAction } | undefined;
  private pendingManualStatus:
    | { taskId: string; options: readonly TaskStatus[]; selected: number }
    | undefined;
  private scrollUp = 0;
  private hideDone = false;
  private filter: DashboardFilter = "all";
  private detailView: DetailView = "transcript";
  private steerOption = 0;
  private steerInput = new Input();
  private followUpInput = new Input();
  private queuedNotice: string | undefined;
  private tails = new Map<string, TranscriptTail>();
  private timer: ReturnType<typeof setInterval>;
  private bodyHeight: number;
  private frame: DashboardFrame;
  private frameFresh = false;
  private transcriptLinesAtScroll: number | undefined;

  constructor(
    private theme: Theme,
    private actions: DashboardActions,
    private options: DashboardOptions = {}
  ) {
    this.bodyHeight = Math.max(
      MIN_DASHBOARD_BODY_HEIGHT,
      Math.floor(options.bodyHeight ?? DEFAULT_DASHBOARD_BODY_HEIGHT)
    );
    this.frame = this.buildFrame();
    if (options.initialView === "phase") {
      this.navigationLevel = "phase";
      this.phaseIndex = Math.max(
        0,
        this.frame.phases.findIndex((phase) => phase.current)
      );
    }
    this.steerInput.onSubmit = (value) => this.submitSteer(value);
    this.steerInput.onEscape = () => {
      this.mode = "browse";
      this.syncInputFocus();
    };
    this.followUpInput.onSubmit = (value) => this.submitFollowUp(value);
    this.followUpInput.onEscape = () => {
      this.mode = "browse";
      this.syncInputFocus();
    };
    this.timer = setInterval(() => actions.requestRender(), REFRESH_MS);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  private syncInputFocus(): void {
    this.steerInput.focused = this._focused && this.mode === "steer";
    this.followUpInput.focused = this._focused && this.mode === "follow_up";
  }

  dispose(): void {
    this._focused = false;
    this.syncInputFocus();
    clearInterval(this.timer);
  }

  invalidate(): void {}

  private buildFrame(): DashboardFrame {
    const board = this.actions.getBoard();
    const config = this.actions.getConfig?.();
    const liveKinds = new Map<string, "execute" | "review">();
    const liveRuns = new Map<string, { cost: number; turns: number; lastActivity: string }>();
    for (const task of board.tasks) {
      const kind = this.actions.liveKind(task.id);
      if (kind) liveKinds.set(task.id, kind);
      if (!this.actions.isLive(task.id)) continue;
      const liveRun = this.actions.getLiveRun?.(task.id);
      if (liveRun) liveRuns.set(task.id, liveRun);
    }
    const staleTaskIds = new Set<string>();
    if (config) {
      const freshnessCache = new Map();
      for (const task of board.tasks) {
        if (
          task.status === "approved" &&
          completionFreshness(board, task, config, freshnessCache).state !== "fresh"
        ) {
          staleTaskIds.add(task.id);
        }
      }
    }
    return {
      board,
      config,
      grouped: groupTasks(board),
      phases: projectRunPhases(board, liveKinds, config),
      staleTaskIds,
      liveRuns,
    };
  }

  private tasksBeforeDoneFilter(): Task[] {
    return visibleDashboardTasks(
      this.frame.grouped,
      this.filter,
      this.phaseScoped ? this.phases()[this.phaseIndex]?.taskIds : undefined,
      false
    );
  }

  /** Tasks currently shown, ordered by their workflow group. */
  private visibleTasks(): Task[] {
    return visibleDashboardTasks(
      this.frame.grouped,
      this.filter,
      this.phaseScoped ? this.phases()[this.phaseIndex]?.taskIds : undefined,
      this.hideDone
    );
  }

  private selectedTask(): Task | undefined {
    if (this.navigationLevel === "phase") return undefined;
    const selection = stableTaskSelection(this.visibleTasks(), this.selectedTaskId, this.selected);
    this.selected = selection.index;
    this.selectedTaskId = selection.task?.id;
    return selection.task;
  }

  private phases() {
    return this.frame.phases;
  }

  private selectedLaunch(): DashboardLaunch | undefined {
    const task = this.selectedTask();
    if (!task) return undefined;
    const selection = stableLaunchSelection(
      taskLaunches(task),
      this.selectedLaunchKey,
      this.launchIndex
    );
    this.launchIndex = selection.index;
    this.selectedLaunchKey = selection.launch?.key;
    return selection.launch;
  }

  private tailFor(task: Task): TranscriptTail | undefined {
    const launch = this.navigationLevel === "launch" ? this.selectedLaunch() : undefined;
    const logFile = launch
      ? launch.kind === "review"
        ? launch.review?.logFile
        : launch.attempt.logFile
      : task.attempts.at(-1)?.logFile;
    if (!logFile) return undefined;
    let tail = this.tails.get(logFile);
    if (!tail) {
      tail = new TranscriptTail(logFile);
      this.tails.set(logFile, tail);
    }
    return tail;
  }

  private submitSteer(value: string): void {
    const task = this.selectedTask();
    this.mode = "browse";
    this.steerInput.setValue("");
    if (!task || !value.trim()) return;
    this.actions.steer(task.id, value.trim());
    this.queuedNotice = `Queued steer for ${task.id}`;
  }

  private submitFollowUp(value: string): void {
    const task = this.selectedTask();
    this.mode = "browse";
    this.followUpInput.setValue("");
    if (!task || !value.trim()) return;
    this.actions.followUp(task.id, value.trim());
    this.queuedNotice = `Queued follow-up for ${task.id}`;
  }

  handleInput(data: string): void {
    try {
      this.routeInput(data);
    } finally {
      this.syncInputFocus();
    }
  }

  private routeInput(data: string): void {
    this.frame = this.buildFrame();
    this.frameFresh = true;
    if (this.mode === "steer_templates") {
      this.handleSteerTemplateInput(data);
      this.actions.requestRender();
      return;
    }

    if (this.mode === "steer") {
      this.steerInput.handleInput(data);
      this.actions.requestRender();
      return;
    }

    if (this.mode === "follow_up") {
      this.followUpInput.handleInput(data);
      this.actions.requestRender();
      return;
    }

    if (this.mode === "manual_status") {
      this.handleManualStatusInput(data);
      this.actions.requestRender();
      return;
    }

    if (this.mode === "confirm_abort" || this.mode === "confirm_accept") {
      const pending = this.pendingConfirm;
      const task = pending ? findTask(this.frame.board, pending.taskId) : undefined;
      if (data === "y" || data === "Y") {
        if (pending?.action === "abort" && task && this.actions.isLive(task.id)) {
          this.actions.abort(task.id);
        }
        if (
          pending?.action === "accept" &&
          task?.status === "ready_for_review" &&
          !this.actions.isLive(task.id)
        ) {
          this.actions.setTaskStatus(task.id, "approved");
        }
      }
      this.pendingConfirm = undefined;
      this.mode = "browse";
      this.frameFresh = false;
      this.actions.requestRender();
      return;
    }

    if (this.mode === "help") {
      this.mode = "browse";
      this.actions.requestRender();
      return;
    }
    if (data === "?") {
      this.mode = "help";
      this.actions.requestRender();
      return;
    }

    const visible = this.visibleTasks();
    const task = this.selectedTask();

    if (matchesKey(data, "escape") || data === "q") {
      this.actions.close();
      return;
    }
    if (matchesKey(data, "left")) {
      if (this.navigationLevel === "launch") {
        this.navigationLevel = "task";
      } else if (this.navigationLevel === "task") {
        const phases = this.phases();
        const taskPhase = phases.findIndex(
          (phase) => phase.current && (!task || phase.taskIds.includes(task.id))
        );
        const firstTaskPhase = phases.findIndex((phase) => task && phase.taskIds.includes(task.id));
        this.phaseIndex = taskPhase >= 0 ? taskPhase : Math.max(0, firstTaskPhase);
        this.navigationLevel = "phase";
        this.phaseScoped = false;
      }
      this.scrollUp = 0;
    } else if (matchesKey(data, "right")) {
      if (this.navigationLevel === "phase") {
        this.navigationLevel = "task";
        this.phaseScoped = true;
        this.selected = 0;
        this.selectedTaskId = undefined;
      } else if (task && taskLaunches(task).length > 0) {
        this.navigationLevel = "launch";
        this.launchIndex = 0;
        this.selectedLaunchKey = undefined;
      }
      this.scrollUp = 0;
    } else if (matchesKey(data, "up") && this.navigationLevel === "phase") {
      this.phaseIndex = Math.max(0, this.phaseIndex - 1);
      this.scrollUp = 0;
    } else if (matchesKey(data, "down") && this.navigationLevel === "phase") {
      this.phaseIndex = Math.min(this.phases().length - 1, this.phaseIndex + 1);
      this.scrollUp = 0;
    } else if (matchesKey(data, "up") && this.navigationLevel === "launch") {
      this.launchIndex = Math.max(0, this.launchIndex - 1);
      this.selectedLaunchKey = task ? taskLaunches(task)[this.launchIndex]?.key : undefined;
      this.scrollUp = 0;
    } else if (matchesKey(data, "down") && this.navigationLevel === "launch") {
      this.launchIndex = Math.min(
        Math.max(0, task ? taskLaunches(task).length - 1 : 0),
        this.launchIndex + 1
      );
      this.selectedLaunchKey = task ? taskLaunches(task)[this.launchIndex]?.key : undefined;
      this.scrollUp = 0;
    } else if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.selectedTaskId = visible[this.selected]?.id;
      this.scrollUp = 0;
    } else if (matchesKey(data, "down")) {
      this.selected = Math.min(Math.max(0, visible.length - 1), this.selected + 1);
      this.selectedTaskId = visible[this.selected]?.id;
      this.scrollUp = 0;
    } else if (data === "f") {
      this.hideDone = !this.hideDone;
      this.selected = 0;
      this.selectedTaskId = undefined;
      this.scrollUp = 0;
    } else if (data === "g") {
      const current = DASHBOARD_FILTERS.indexOf(this.filter);
      this.filter = DASHBOARD_FILTERS[(current + 1) % DASHBOARD_FILTERS.length] ?? "all";
      this.selected = 0;
      this.selectedTaskId = undefined;
      this.scrollUp = 0;
    } else if (data === "t") {
      this.detailView =
        this.detailView === "transcript"
          ? "timeline"
          : this.detailView === "timeline"
            ? "summary"
            : "transcript";
      this.scrollUp = 0;
    } else if (data === "e") {
      this.detailView = this.detailView === "evidence" ? "transcript" : "evidence";
      this.scrollUp = 0;
    } else if (matchesKey(data, "pageUp")) {
      this.scrollUp += 10;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollUp = Math.max(0, this.scrollUp - 10);
    } else if (data === "s" && task && this.actions.isLive(task.id)) {
      this.steerOption = 0;
      this.mode = "steer_templates";
    } else if (data === "F" && task && this.actions.isLive(task.id)) {
      this.mode = "follow_up";
    } else if (data === "x" && task && this.actions.isLive(task.id)) {
      this.pendingConfirm = { taskId: task.id, action: "abort" };
      this.mode = "confirm_abort";
    } else if (
      data === "a" &&
      task?.status === "ready_for_review" &&
      !this.actions.isLive(task.id)
    ) {
      this.pendingConfirm = { taskId: task.id, action: "accept" };
      this.mode = "confirm_accept";
    } else if (data === "m" && task && isManualStatusEligible(task, this.actions.isLive(task.id))) {
      this.pendingManualStatus = {
        taskId: task.id,
        options: MANUAL_STATUS_OPTIONS.filter((status) => status !== task.status),
        selected: 0,
      };
      this.mode = "manual_status";
    } else if (
      data === "r" &&
      task &&
      !this.actions.isLive(task.id) &&
      this.actions.retryEligibility(task.id).eligible
    ) {
      this.actions.selectTaskAction(task.id, "retry");
      return;
    } else if (data === "p" && task && !this.actions.isLive(task.id) && lastAttemptReport(task)) {
      this.actions.selectTaskAction(task.id, "view_report");
      return;
    } else if (
      data === "v" &&
      task &&
      !this.actions.isLive(task.id) &&
      task.attempts.at(-1)?.reviewReport
    ) {
      this.actions.selectTaskAction(task.id, "view_review");
      return;
    } else if (
      (matchesKey(data, "return") || data === "o") &&
      task &&
      !this.actions.isLive(task.id) &&
      this.actions.hasExecutorSession(task.id)
    ) {
      this.actions.selectTaskAction(task.id, "open_executor");
      return;
    } else if (
      data === "O" &&
      task &&
      !this.actions.isLive(task.id) &&
      this.actions.hasReviewerSession(task.id)
    ) {
      this.actions.selectTaskAction(task.id, "open_reviewer");
      return;
    }
    this.actions.requestRender();
  }

  private handleManualStatusInput(data: string): void {
    const pending = this.pendingManualStatus;
    const task = pending ? findTask(this.frame.board, pending.taskId) : undefined;
    if (!pending || !task || !isManualStatusEligible(task, this.actions.isLive(task.id))) {
      this.pendingManualStatus = undefined;
      this.mode = "browse";
      return;
    }
    if (matchesKey(data, "escape")) {
      this.pendingManualStatus = undefined;
      this.mode = "browse";
      return;
    }
    if (matchesKey(data, "up")) {
      pending.selected = Math.max(0, pending.selected - 1);
      return;
    }
    if (matchesKey(data, "down")) {
      pending.selected = Math.min(pending.options.length - 1, pending.selected + 1);
      return;
    }
    if (!matchesKey(data, "return")) return;

    const status = pending.options[pending.selected];
    this.pendingManualStatus = undefined;
    this.mode = "browse";
    if (!status || status === task.status) return;
    this.actions.setTaskStatus(task.id, status);
    this.frameFresh = false;
  }

  private handleSteerTemplateInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.mode = "browse";
      return;
    }
    if (matchesKey(data, "up")) {
      this.steerOption = Math.max(0, this.steerOption - 1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.steerOption = Math.min(STEER_OPTIONS.length - 1, this.steerOption + 1);
      return;
    }
    if (!matchesKey(data, "return")) return;

    const message = STEER_OPTIONS[this.steerOption];
    if (!message) return;
    if (message === "Custom message...") {
      this.mode = "steer";
      return;
    }
    this.submitSteer(message);
  }

  render(width: number): string[] {
    this.syncInputFocus();
    if (this.frameFresh) this.frameFresh = false;
    else this.frame = this.buildFrame();
    width = Math.max(1, Math.floor(width));
    const theme = this.theme;
    const board = this.frame.board;
    const visible = this.visibleTasks();
    if (this.selected >= visible.length) this.selected = Math.max(0, visible.length - 1);

    const narrow = width < 48 || this.mode === "help";
    const listWidth = narrow ? 0 : Math.min(44, Math.max(24, Math.floor(width * 0.35)));
    const transcriptWidth = narrow ? width : Math.max(1, width - listWidth - 3);
    const rows = this.options.getRows?.();
    const bodyHeight =
      rows && rows > 0
        ? Math.max(MIN_DASHBOARD_BODY_HEIGHT, Math.floor(rows) - 3)
        : this.bodyHeight;

    const left = narrow ? [] : this.renderNavigation(visible, board, listWidth, bodyHeight);
    const right =
      this.mode === "help"
        ? this.renderHelp(width, bodyHeight)
        : this.navigationLevel === "phase"
          ? this.renderSelectedPhase(transcriptWidth, bodyHeight)
          : this.renderTranscript(transcriptWidth, bodyHeight);

    const lines: string[] = [];
    const usage = boardUsage(board.tasks);
    const status = projectStatus(
      board,
      board.tasks.filter((task) => this.actions.isLive(task.id)).map((task) => task.id),
      this.frame.config
    );
    const running = status.running;
    const hiddenCount = this.tasksBeforeDoneFilter().filter(
      (task) => task.status === "approved" || task.status === "cancelled"
    ).length;
    const doneFilterPart = this.hideDone ? ` · hiding ${hiddenCount} done` : "";
    const statusFilterPart = this.filter === "all" ? "" : ` · filter: ${GROUP_LABELS[this.filter]}`;
    const completed = status.code === "complete" ? " · board complete" : "";
    const title = ` ⚡ maestro dashboard · ${board.tasks.length} task(s) · ${status.code} · ${running} running · $${usage.cost.toFixed(4)}${completed}${statusFilterPart}${doneFilterPart} `;
    lines.push(theme.fg("accent", truncateToWidth(title + "─".repeat(width), width)));

    for (let i = 0; i < bodyHeight; i++) {
      const r = right[i] ?? "";
      if (narrow) {
        lines.push(r);
        continue;
      }
      const l = left[i] ?? " ".repeat(listWidth);
      lines.push(`${padToWidth(l, listWidth)} ${theme.fg("dim", "│")} ${r}`);
    }

    lines.push(theme.fg("dim", "─".repeat(width)));
    lines.push(this.renderFooter(width));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderHelp(width: number, height: number): string[] {
    const lines = [this.theme.bold("Dashboard help")];
    for (const binding of DASHBOARD_BINDINGS) {
      lines.push(`${binding.context.padEnd(12)} ${binding.key.padEnd(12)} ${binding.description}`);
    }
    lines.push(this.theme.fg("dim", "Press any key to close help"));
    return lines.map((line) => truncateToWidth(line, width)).slice(0, height);
  }

  private renderNavigation(tasks: Task[], board: Board, width: number, height: number): string[] {
    if (this.navigationLevel === "phase") return this.renderPhaseList(width, height);
    if (this.navigationLevel === "launch") return this.renderLaunchList(width, height);
    return this.renderTaskList(tasks, board.tasks.length, width, height);
  }

  private renderPhaseList(width: number, height: number): string[] {
    return visibleWindow(this.phases(), this.phaseIndex, height).map(({ item: phase, index }) => {
      const marker = index === this.phaseIndex ? "▶ " : "  ";
      const current = phase.current ? " · current" : "";
      const text = truncateToWidth(
        `${marker}${index + 1}. ${phase.label} · ${phase.taskIds.length} task(s)${current}`,
        width
      );
      return index === this.phaseIndex ? this.theme.fg("accent", text) : text;
    });
  }

  private renderLaunchList(width: number, height: number): string[] {
    const task = this.selectedTask();
    if (!task) return [this.theme.fg("muted", "No task selected.")];
    const launches = taskLaunches(task);
    if (launches.length === 0) {
      return [this.theme.fg("muted", "No launches yet."), this.theme.fg("dim", "← tasks")];
    }
    return visibleWindow(launches, this.launchIndex, height).map(({ item: launch, index }) => {
      const marker = index === this.launchIndex ? "▶ " : "  ";
      const usage = launch.review?.usage ?? executorUsage(launch.attempt);
      const text = truncateToWidth(
        `${marker}${launch.label} · ${usage.turns}t · $${usage.cost.toFixed(4)}`,
        width
      );
      return index === this.launchIndex ? this.theme.fg("accent", text) : text;
    });
  }

  private renderSelectedPhase(width: number, height: number): string[] {
    const phase = this.phases()[this.phaseIndex];
    if (!phase) return [];
    const board = this.frame.board;
    const lines = [
      this.theme.bold(truncateToWidth(`Run › ${phase.label}`, width)),
      this.theme.fg(
        phase.current ? "accent" : "dim",
        truncateToWidth(phase.current ? "Current workflow phase" : "Durable evidence phase", width)
      ),
      truncateToWidth(
        `${phase.taskIds.length} task(s): ${phase.taskIds.join(", ") || "none"}`,
        width
      ),
    ];
    if (phase.id === "recovery" && board.activeDecision) {
      lines.push(
        this.theme.fg(
          "warning",
          truncateToWidth(
            `Decision: ${board.activeDecision.kind} · ${singleLine(board.activeDecision.evidence)}`,
            width
          )
        )
      );
    }
    if (phase.id === "recovery" && board.pausedDrive) {
      lines.push(
        truncateToWidth(
          `Paused scope: ${board.pausedDrive.taskIds?.join(", ") ?? "entire board"}`,
          width
        )
      );
    }
    lines.push(this.theme.fg("dim", "→ inspect tasks · ↑↓ choose phase"));
    return lines.slice(0, height);
  }

  private renderTaskList(
    tasks: Task[],
    boardTaskCount: number,
    width: number,
    height: number
  ): string[] {
    const theme = this.theme;
    if (tasks.length === 0) {
      if (boardTaskCount === 0) {
        const archive = this.actions.getLatestArchive?.();
        if (archive) {
          return [
            theme.fg("muted", `Board empty — last run archived ${relativeTime(archive.at)}.`),
            theme.fg("dim", "/maestro replay to restore · /maestro start <goal> to begin"),
          ].slice(0, height);
        }
        return [theme.fg("muted", "No tasks yet — /maestro start <goal>")].slice(0, height);
      }
      if (this.hideDone && this.filter === "all") {
        return [theme.fg("muted", "All tasks are done."), theme.fg("dim", "f show them again")];
      }
      const label = this.filter === "all" ? "current filters" : GROUP_LABELS[this.filter];
      return [theme.fg("muted", `No tasks in ${label}.`), theme.fg("dim", "g next group · f done")];
    }

    const lines: string[] = [];
    const window = taskListWindow(tasks.length, this.selected, height);
    if (window.showTop) {
      lines.push(theme.fg("dim", truncateToWidth(`↑ ${window.start} earlier tasks`, width)));
    }
    for (let i = window.start; i < window.end; i++) {
      const task = tasks[i];
      if (!task) continue;
      const isSelected = i === this.selected;
      const live = this.actions.isLive(task.id);
      const glyph = theme.fg(statusColor(task.status), STATUS_GLYPHS[task.status]);
      const marker = isSelected ? theme.fg("accent", "▶ ") : "  ";
      const title = truncateToWidth(`${task.id} ${task.title}`, width - 8);
      const line1 = `${marker}${glyph} ${isSelected ? theme.bold(title) : title}`;

      const liveRun = live ? this.frame.liveRuns.get(task.id) : undefined;
      const usage = liveRun ?? taskUsage(task);
      const activity = live
        ? ` · ${liveRun?.lastActivity ?? this.actions.liveActivity(task.id) ?? "…"}`
        : "";
      const group = GROUP_LABELS[taskGroup(this.frame.board, task)];
      let status =
        group === STATUS_LABELS[task.status] ? group : `${group} · ${STATUS_LABELS[task.status]}`;
      if (this.frame.staleTaskIds.has(task.id)) status += " (stale)";
      if (task.status === "cancelled" && task.supersededBy) {
        status += ` · superseded by ${task.supersededBy}`;
      }
      const reason = blockedReason(this.frame.board, task);
      if (reason) status += ` · ${reason}`;
      const usageDetail = liveRun
        ? `${liveRun.turns}t · $${usage.cost.toFixed(4)}`
        : `$${usage.cost.toFixed(4)}`;
      const detail = `${status} [${task.tier}] · ${usageDetail}${activity}`;
      const line2 = `     ${theme.fg("dim", truncateToWidth(detail, width - 5))}`;

      const remainingTaskTitles = window.end - i - 1;
      const reservedRows = remainingTaskTitles + (window.showBottom ? 1 : 0);
      if (lines.length < height - reservedRows) lines.push(line1);
      if (lines.length < height - reservedRows) lines.push(line2);
    }
    if (window.showBottom && lines.length < height) {
      lines.push(
        theme.fg("dim", truncateToWidth(`↓ ${tasks.length - window.end} more tasks`, width))
      );
    }
    return lines;
  }

  private renderTranscript(width: number, height: number): string[] {
    width = Math.max(1, width);
    const theme = this.theme;
    const task = this.selectedTask();
    if (!task) return [];

    if (this.detailView === "evidence") {
      const evidence = this.renderEvidence(task, width, height);
      return this.mode === "manual_status"
        ? [...evidence, ...this.renderManualStatusControls(width, height)].slice(0, height)
        : evidence;
    }
    if (this.detailView === "summary") {
      const history = this.actions.getStatusHistory?.();
      return [
        ...formatCostSummary(this.frame.board.tasks).split("\n"),
        "",
        "Recent status history",
        formatStatusHistory(history?.entries ?? [], history?.skipped ?? 0, 20),
      ]
        .flatMap((line) => wrapText(line, width))
        .slice(0, height);
    }

    const maxSummaryHeight = Math.min(11, Math.max(1, Math.ceil(height / 2)));
    const summary = this.renderSelectedTask(task, width).slice(0, maxSummaryHeight);
    const transcriptHeight = Math.max(0, height - summary.length);
    const tail = this.detailView === "transcript" ? this.tailFor(task) : undefined;
    tail?.poll();

    const wrapped: string[] = [];
    if (this.detailView === "timeline") {
      const timeline = formatRunTimeline(deriveRunTimeline(this.frame.board, task.id));
      for (const raw of timeline.split("\n")) {
        for (const line of wrapText(raw, width)) wrapped.push(theme.fg("toolOutput", line));
      }
    } else if (!tail) {
      wrapped.push(theme.fg("muted", "No attempt yet — task has not run."));
    } else if (tail.items.length === 0) {
      wrapped.push(theme.fg("muted", "Waiting for executor output…"));
    }

    if (this.detailView === "transcript") {
      wrapped.push(...styledTranscriptLines(theme, tail?.items ?? [], width));
    }

    const modeLines =
      this.mode === "manual_status"
        ? this.renderManualStatusControls(width, transcriptHeight)
        : this.renderSteerControls(width, transcriptHeight);
    const visible = Math.max(0, transcriptHeight - modeLines.length);
    if (this.scrollUp > 0) {
      if (this.transcriptLinesAtScroll !== undefined) {
        this.scrollUp += Math.max(0, wrapped.length - this.transcriptLinesAtScroll);
      }
      this.transcriptLinesAtScroll = wrapped.length;
    } else {
      this.transcriptLinesAtScroll = undefined;
    }
    const maxScroll = Math.max(0, wrapped.length - visible);
    if (this.scrollUp > maxScroll) this.scrollUp = maxScroll;
    const end = wrapped.length - this.scrollUp;
    const body = wrapped.slice(Math.max(0, end - visible), end);

    body.push(...modeLines);
    return [...summary, ...body].slice(0, height);
  }

  private renderSelectedTask(task: Task, width: number): string[] {
    const board = this.frame.board;
    const liveRun = this.frame.liveRuns.get(task.id);
    const usage = liveRun ?? taskUsage(task);
    const liveDetail = liveRun ? ` · ${liveRun.turns} turns · ${liveRun.lastActivity}` : "";
    const dependencies = task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none";
    const attempts = `${task.attempts.length} attempt${task.attempts.length === 1 ? "" : "s"}`;
    const group = GROUP_LABELS[taskGroup(board, task)];
    const heading = `${STATUS_GLYPHS[task.status]} ${task.id} · ${STATUS_LABELS[task.status]} · ${task.tier}`;
    const phase = this.phases().find((candidate) => candidate.current)?.label ?? "execution";
    const launch = this.navigationLevel === "launch" ? this.selectedLaunch() : undefined;
    const breadcrumb = launch
      ? `Run › ${phase} › ${task.id} › ${launch.label}`
      : `Run › ${phase} › ${task.id}`;
    const lines = [
      this.theme.fg("dim", truncateToWidth(breadcrumb, width)),
      this.theme.bold(truncateToWidth(heading, width)),
      this.theme.fg(
        "dim",
        truncateToWidth(
          `Group: ${group} · Dependencies: ${dependencies} · ${attempts} · $${usage.cost.toFixed(4)}${liveDetail}`,
          width
        )
      ),
    ];

    const blockers = task.dependsOn.flatMap((dependencyId) => {
      const dependency = findTask(board, dependencyId);
      if (dependency?.status === "approved") return [];
      const label = dependency?.id ?? dependencyId.trim();
      return [`${label} (${dependency ? STATUS_LABELS[dependency.status] : "missing"})`];
    });
    if (blockers.length > 0) {
      lines.push(
        this.theme.fg("warning", truncateToWidth(`Blocked by: ${blockers.join(", ")}`, width))
      );
    }

    const failure = latestFailure(task);
    if (failure) {
      lines.push(this.theme.fg("error", truncateToWidth(`Failure: ${failure}`, width)));
    }

    const reviewNotes = task.reviewNotes ?? task.attempts.at(-1)?.reviewNotes;
    if (reviewNotes) {
      lines.push(
        this.theme.fg(
          "warning",
          truncateToWidth(`Reviewer notes: ${singleLine(reviewNotes)}`, width)
        )
      );
    }

    const latest = task.attempts.at(-1);
    if (latest) {
      lines.push(this.theme.fg("dim", truncateToWidth(attemptDetails(latest), width)));
      if (latest.reviewModel || latest.reviewProvider || latest.reviewUsage) {
        const reviewUsage = latest.reviewUsage;
        const reviewCost = reviewUsage
          ? ` · ${reviewUsage.turns} turns · $${reviewUsage.cost.toFixed(4)}`
          : "";
        lines.push(
          this.theme.fg(
            "dim",
            truncateToWidth(
              `Reviewer: model ${latest.reviewModel ?? "unknown"} · provider ${latest.reviewProvider ?? "unknown"}${reviewCost}`,
              width
            )
          )
        );
      }
      if (latest.touchedFiles.length > 0) {
        lines.push(
          this.theme.fg(
            "dim",
            truncateToWidth(`Changed files: ${latest.touchedFiles.join(", ")}`, width)
          )
        );
      }
      lines.push(
        ...task.attempts
          .slice(-3)
          .map((attempt) =>
            this.theme.fg("dim", truncateToWidth(`History: ${attemptHistory(attempt)}`, width))
          )
      );
    }

    lines.push(truncateToWidth(`Next: ${this.nextAction(task)}`, width));
    lines.push(this.theme.fg("dim", "─".repeat(width)));
    return lines;
  }

  private renderEvidence(task: Task, width: number, height: number): string[] {
    const board = this.frame.board;
    const selectedLaunch = this.navigationLevel === "launch" ? this.selectedLaunch() : undefined;
    const attempt = selectedLaunch?.attempt ?? task.attempts.at(-1);
    const review = selectedLaunch?.review;
    const latestReview = selectedLaunch ? review : attempt?.reviewLaunches?.at(-1);
    const phase = this.phases().find((candidate) => candidate.current)?.label ?? "execution";

    const logFile = selectedLaunch
      ? selectedLaunch.kind === "review"
        ? latestReview?.logFile
        : attempt?.logFile
      : attempt?.logFile;
    let lastActivity: string | undefined;
    if (logFile) {
      let tail = this.tails.get(logFile);
      if (!tail) {
        tail = new TranscriptTail(logFile);
        this.tails.set(logFile, tail);
      }
      tail.poll();
      lastActivity = tail.items
        .slice(-3)
        .map((item) => singleLine(item.text))
        .filter(Boolean)
        .join(" | ");
    }

    const sections = projectEvidenceSections(task, selectedLaunch, {
      phaseLabel: phase,
      ...(lastActivity ? { lastActivity } : {}),
      ...(board.pausedDrive ? { pausedDrive: board.pausedDrive } : {}),
      ...(board.activeDecision ? { decision: board.activeDecision } : {}),
    });

    const roled: { kind: "banner" | "header" | "body"; text: string }[] = [
      {
        kind: "body",
        text: `Run › ${phase} › ${task.id}${selectedLaunch ? ` › ${selectedLaunch.label}` : ""}`,
      },
    ];
    const reason = latestFailure(task);
    if (reason && (task.status === "failed" || task.status === "changes_requested")) {
      roled.push({ kind: "banner", text: `Reason: ${reason}` });
    }
    for (const section of sections) {
      roled.push({ kind: "header", text: section.title });
      for (const line of section.lines) roled.push({ kind: "body", text: line });
    }

    const wrapped = roled.flatMap((entry) =>
      wrapText(entry.text, width).map((text) => ({ kind: entry.kind, text }))
    );
    const maxScroll = Math.max(0, wrapped.length - height);
    if (this.scrollUp > maxScroll) this.scrollUp = maxScroll;
    const end = wrapped.length - this.scrollUp;
    return wrapped.slice(Math.max(0, end - height), end).map((entry, index) => {
      if (index === 0) return this.theme.bold(entry.text);
      if (entry.kind === "banner") return this.theme.fg("error", entry.text);
      if (entry.kind === "header") return this.theme.fg("accent", entry.text);
      return this.theme.fg("toolOutput", entry.text);
    });
  }

  private nextAction(task: Task): string {
    if (this.actions.isLive(task.id)) return "Monitor output, steer if needed, or abort.";
    if (task.status === "ready_for_review")
      return "Review the result; open its session or approve it.";
    if (task.status === "changes_requested") return "Retry with the reviewer notes (r).";
    if (task.status === "approved") {
      const retry = this.actions.retryEligibility(task.id);
      return retry.message.includes("stale") || retry.message.includes("legacy")
        ? `${retry.message} Retry it or create a successor.`
        : "Complete — no action needed.";
    }
    if (task.status === "failed") return "Reopen the task to retry it.";
    if (task.status === "cancelled") return "Reopen the task if it should run.";
    const reason = blockedReason(this.frame.board, task);
    if (reason) return `Waiting for ${reason.slice("blocked by ".length)} to complete.`;
    return "Ready to run when the orchestrator dispatches it.";
  }

  private renderManualStatusControls(width: number, height: number): string[] {
    const pending = this.pendingManualStatus;
    if (!pending) return [];
    const task = findTask(this.frame.board, pending.taskId);
    if (!task || !isManualStatusEligible(task, this.actions.isLive(task.id))) {
      this.pendingManualStatus = undefined;
      this.mode = "browse";
      return [];
    }

    const lines = [this.theme.fg("accent", `Set ${task.id} status:`)];
    for (const [index, status] of pending.options.entries()) {
      const marker = index === pending.selected ? "▶ " : "  ";
      const text = truncateToWidth(`${marker}${STATUS_LABELS[status]}`, width);
      lines.push(index === pending.selected ? this.theme.fg("accent", text) : text);
    }
    lines.push(this.theme.fg("dim", "↑↓ select · enter apply · esc cancel"));
    return lines.slice(0, height);
  }

  private renderSteerControls(width: number, height: number): string[] {
    if (this.mode === "steer") {
      return [
        this.theme.fg("accent", "steer ▸ ") +
          (this.steerInput.render(Math.max(1, width - 8))[0] ?? ""),
        this.theme.fg("dim", "enter send · esc cancel"),
      ].slice(0, height);
    }
    if (this.mode === "follow_up") {
      return [
        this.theme.fg("accent", "follow-up ▸ ") +
          (this.followUpInput.render(Math.max(1, width - 12))[0] ?? ""),
        this.theme.fg("dim", "enter queue · esc cancel"),
      ].slice(0, height);
    }
    if (this.mode === "browse" && this.queuedNotice) {
      return [this.theme.fg("success", truncateToWidth(`✓ ${this.queuedNotice}`, width))].slice(
        0,
        height
      );
    }
    if (this.mode !== "steer_templates") return [];

    return steerTemplateLines(this.theme, this.steerOption, width, height);
  }

  private renderFooter(width: number): string {
    const theme = this.theme;
    const task = this.selectedTask();
    if (this.mode === "confirm_abort" && this.pendingConfirm) {
      return theme.fg(
        "error",
        ` Abort ${this.pendingConfirm.taskId}? Press y to confirm, any other key to cancel `
      );
    }
    if (this.mode === "confirm_accept" && this.pendingConfirm) {
      return theme.fg(
        "warning",
        ` Approve ${this.pendingConfirm.taskId} without review? Press y to confirm, any other key to cancel `
      );
    }
    if (this.navigationLevel === "phase") {
      const parts = [bindingLabel("↑↓"), bindingLabel("←→"), bindingLabel("esc")];
      return theme.fg("dim", truncateToWidth(` ${parts.join(" · ")} `, width));
    }
    const live = task ? this.actions.isLive(task.id) : false;
    const parts = [
      bindingLabel("?"),
      ...(this.frame.board.planPending ? ["plan gated · /maestro plan to review"] : []),
      bindingLabel("↑↓"),
      bindingLabel("esc"),
      bindingLabel("PgUp/PgDn"),
    ];
    if (live) parts.push(bindingLabel("s"), bindingLabel("F"), bindingLabel("x"));
    else if (task) {
      if (lastAttemptReport(task)) parts.push(bindingLabel("p"));
      if (task.attempts.at(-1)?.reviewReport) parts.push(bindingLabel("v"));
      if (this.actions.hasExecutorSession(task.id)) parts.push(bindingLabel("enter"));
      if (this.actions.hasReviewerSession(task.id)) parts.push(bindingLabel("O"));
      if (task.status === "ready_for_review") parts.push(bindingLabel("a"));
      if (isManualStatusEligible(task, false)) parts.push(bindingLabel("m"));
      if (this.actions.retryEligibility(task.id).eligible) parts.push(bindingLabel("r"));
    }
    const groupFilter = this.filter === "all" ? "all" : GROUP_LABELS[this.filter];
    parts.push(
      `${bindingLabel("g")} (${groupFilter})`,
      bindingLabel("t"),
      bindingLabel("e"),
      bindingLabel("f"),
      bindingLabel("←→")
    );
    return theme.fg("dim", truncateToWidth(` ${parts.join(" · ")} `, width));
  }
}

interface TaskListWindow {
  start: number;
  end: number;
  showTop: boolean;
  showBottom: boolean;
}

function taskListWindow(taskCount: number, selected: number, height: number): TaskListWindow {
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

function visibleWindow<T>(items: readonly T[], selected: number, height: number) {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  return items
    .slice(start, start + height)
    .map((item, offset) => ({ item, index: start + offset }));
}
