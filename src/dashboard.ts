import { type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  blockedReason,
  findTask,
  groupTasks,
  type HumanRetryEligibility,
  taskGroup,
} from "./board.js";
import { boardUsage, STATUS_GLYPHS, STATUS_LABELS, taskUsage } from "./format.js";
import { projectRunPhases, projectStatus } from "./status.js";
import { deriveRunTimeline, formatRunTimeline } from "./timeline.js";
import { TranscriptTail } from "./transcript.js";
import {
  type Attempt,
  type Board,
  type MaestroConfig,
  type ReviewLaunch,
  type Task,
  type TaskGroup,
  type TaskStatus,
  type Usage,
} from "./types.js";

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
  steer(taskId: string, message: string): void;
  abort(taskId: string): void;
  setTaskStatus(taskId: string, status: TaskStatus): void;
  hasExecutorSession(taskId: string): boolean;
  hasReviewerSession(taskId: string): boolean;
  retryEligibility(taskId: string): HumanRetryEligibility;
  /** Close the dashboard and route an inspection action through the command helpers. */
  selectTaskAction(taskId: string, action: DashboardTaskAction): void;
  close(): void;
  requestRender(): void;
}

const REFRESH_MS = 500;
export const DEFAULT_DASHBOARD_BODY_HEIGHT = 22;
const MIN_DASHBOARD_BODY_HEIGHT = 2;

type Mode = "browse" | "steer_templates" | "steer" | "confirm_abort" | "confirm_accept";
type DashboardFilter = "all" | TaskGroup;
type NavigationLevel = "phase" | "task" | "launch";

export interface DashboardLaunch {
  key: string;
  kind: "execute" | "review";
  attempt: Attempt;
  review?: ReviewLaunch;
  label: string;
}

export function taskLaunches(task: Task): DashboardLaunch[] {
  return task.attempts.flatMap((attempt) => {
    const launches: DashboardLaunch[] = [
      {
        key: `${task.id}:execute:${attempt.index}`,
        kind: "execute",
        attempt,
        label: `execute #${attempt.index}`,
      },
    ];
    const legacyReview: ReviewLaunch = {
      id: `legacy-${attempt.index}`,
      role: "single",
      startedAt: attempt.endedAt ?? attempt.startedAt,
      usage: attempt.reviewUsage ?? { input: 0, output: 0, cost: 0, turns: 0 },
      ...(attempt.reviewModel ? { model: attempt.reviewModel } : {}),
      ...(attempt.reviewProvider ? { provider: attempt.reviewProvider } : {}),
      ...(attempt.reviewSessionFile ? { sessionFile: attempt.reviewSessionFile } : {}),
      ...(attempt.reviewReport ? { finalReport: attempt.reviewReport } : {}),
    };
    const reviews =
      attempt.reviewLaunches ??
      (attempt.reviewReport || attempt.reviewSessionFile || attempt.reviewModel
        ? [legacyReview]
        : []);
    for (const [index, review] of reviews.entries()) {
      launches.push({
        key: `${task.id}:review:${attempt.index}:${review.id ?? index + 1}`,
        kind: "review",
        attempt,
        review,
        label: `review #${review.reviewerIndex ?? index + 1} · ${review.role ?? "reviewer"}`,
      });
    }
    return launches;
  });
}

const GROUPS: readonly TaskGroup[] = [
  "blocked",
  "ready",
  "running",
  "review-needed",
  "approved",
  "failed",
  "cancelled",
];
const FILTERS: readonly DashboardFilter[] = ["all", ...GROUPS];

const GROUP_LABELS: Record<TaskGroup, string> = {
  blocked: "blocked",
  ready: "ready",
  running: "running",
  "review-needed": "review needed",
  approved: "approved",
  failed: "failed",
  cancelled: "cancelled",
};

const STEER_OPTIONS = [
  "Stop - wrong approach, report current state",
  "Run the project checks before finishing",
  "Stay strictly within the task brief scope",
  "Custom message...",
] as const;

export interface DashboardOptions {
  /** Number of rows shared by the task list and transcript panes. */
  bodyHeight?: number;
  /** Live terminal row count. */
  getRows?: () => number;
}

type DashboardFrame = {
  board: Board;
  config: MaestroConfig | undefined;
  grouped: ReturnType<typeof groupTasks>;
  phases: ReturnType<typeof projectRunPhases>;
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
  private selected = 0;
  private selectedTaskId: string | undefined;
  private navigationLevel: NavigationLevel = "task";
  private phaseIndex = 0;
  private phaseScoped = false;
  private launchIndex = 0;
  private selectedLaunchKey: string | undefined;
  private mode: Mode = "browse";
  private scrollUp = 0;
  private hideDone = false;
  private filter: DashboardFilter = "all";
  private detailView: "transcript" | "timeline" | "evidence" = "transcript";
  private steerOption = 0;
  private steerInput = new Input();
  private tails = new Map<string, TranscriptTail>();
  private timer: ReturnType<typeof setInterval>;
  private bodyHeight: number;
  private frame: DashboardFrame;
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
    this.steerInput.onSubmit = (value) => this.submitSteer(value);
    this.steerInput.onEscape = () => {
      this.mode = "browse";
    };
    this.timer = setInterval(() => actions.requestRender(), REFRESH_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {}

  private buildFrame(): DashboardFrame {
    const board = this.actions.getBoard();
    const config = this.actions.getConfig?.();
    const liveKinds = new Map<string, "execute" | "review">();
    for (const task of board.tasks) {
      const kind = this.actions.liveKind(task.id);
      if (kind) liveKinds.set(task.id, kind);
    }
    return {
      board,
      config,
      grouped: groupTasks(board),
      phases: projectRunPhases(board, liveKinds, config),
    };
  }

  private tasksBeforeDoneFilter(): Task[] {
    let tasks =
      this.filter === "all"
        ? GROUPS.flatMap((group) => this.frame.grouped[group])
        : this.frame.grouped[this.filter];
    if (this.phaseScoped) {
      const taskIds = new Set(this.phases()[this.phaseIndex]?.taskIds ?? []);
      tasks = tasks.filter((task) => taskIds.has(task.id));
    }
    return tasks;
  }

  /** Tasks currently shown, ordered by their workflow group. */
  private visibleTasks(): Task[] {
    const tasks = this.tasksBeforeDoneFilter();
    if (!this.hideDone) return tasks;
    return tasks.filter((task) => task.status !== "approved" && task.status !== "cancelled");
  }

  private selectedTask(): Task | undefined {
    if (this.navigationLevel === "phase") return undefined;
    const tasks = this.visibleTasks();
    const stableIndex = this.selectedTaskId
      ? tasks.findIndex((task) => task.id === this.selectedTaskId)
      : -1;
    if (stableIndex >= 0) this.selected = stableIndex;
    if (this.selected >= tasks.length) this.selected = Math.max(0, tasks.length - 1);
    const task = tasks[this.selected];
    this.selectedTaskId = task?.id;
    return task;
  }

  private phases() {
    return this.frame.phases;
  }

  private selectedLaunch(): DashboardLaunch | undefined {
    const task = this.selectedTask();
    if (!task) return undefined;
    const launches = taskLaunches(task);
    const stableIndex = this.selectedLaunchKey
      ? launches.findIndex((launch) => launch.key === this.selectedLaunchKey)
      : -1;
    if (stableIndex >= 0) this.launchIndex = stableIndex;
    if (this.launchIndex >= launches.length) this.launchIndex = Math.max(0, launches.length - 1);
    const launch = launches[this.launchIndex];
    this.selectedLaunchKey = launch?.key;
    return launch;
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
    if (task && value.trim()) this.actions.steer(task.id, value.trim());
  }

  handleInput(data: string): void {
    this.frame = this.buildFrame();
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

    if (this.mode === "confirm_abort") {
      const task = this.selectedTask();
      if ((data === "y" || data === "Y") && task) this.actions.abort(task.id);
      this.mode = "browse";
      this.actions.requestRender();
      return;
    }

    if (this.mode === "confirm_accept") {
      const task = this.selectedTask();
      if ((data === "y" || data === "Y") && task) this.actions.setTaskStatus(task.id, "approved");
      this.mode = "browse";
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
      const current = FILTERS.indexOf(this.filter);
      this.filter = FILTERS[(current + 1) % FILTERS.length] ?? "all";
      this.selected = 0;
      this.selectedTaskId = undefined;
      this.scrollUp = 0;
    } else if (data === "t") {
      this.detailView = this.detailView === "transcript" ? "timeline" : "transcript";
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
    } else if (data === "x" && task && this.actions.isLive(task.id)) {
      this.mode = "confirm_abort";
    } else if (
      data === "a" &&
      task?.status === "ready_for_review" &&
      !this.actions.isLive(task.id)
    ) {
      this.mode = "confirm_accept";
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
    this.frame = this.buildFrame();
    width = Math.max(1, Math.floor(width));
    const theme = this.theme;
    const board = this.frame.board;
    const visible = this.visibleTasks();
    if (this.selected >= visible.length) this.selected = Math.max(0, visible.length - 1);

    const narrow = width < 48;
    const listWidth = narrow ? 0 : Math.min(44, Math.max(24, Math.floor(width * 0.35)));
    const transcriptWidth = narrow ? width : Math.max(1, width - listWidth - 3);
    const rows = this.options.getRows?.();
    const bodyHeight =
      rows && rows > 0
        ? Math.max(MIN_DASHBOARD_BODY_HEIGHT, Math.floor(rows) - 3)
        : this.bodyHeight;

    const left = narrow ? [] : this.renderNavigation(visible, board, listWidth, bodyHeight);
    const right =
      this.navigationLevel === "phase"
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
        return [
          theme.fg("muted", "Board is empty."),
          theme.fg("dim", "Use /maestro start <goal>"),
        ].slice(0, height);
      }
      if (this.hideDone && this.filter === "all") {
        return [theme.fg("muted", "All tasks are done."), theme.fg("dim", "f show them again")];
      }
      const label = this.filter === "all" ? "current filters" : GROUP_LABELS[this.filter];
      return [theme.fg("muted", `No tasks in ${label}.`), theme.fg("dim", "g next group · f done")];
    }

    const lines: string[] = [];
    const start = Math.max(
      0,
      Math.min(this.selected - Math.floor(height / 4), tasks.length - height / 2)
    );
    for (let i = Math.floor(start); i < tasks.length && lines.length < height; i++) {
      const task = tasks[i];
      if (!task) continue;
      const isSelected = i === this.selected;
      const live = this.actions.isLive(task.id);
      const glyph = theme.fg(statusColor(task.status), STATUS_GLYPHS[task.status]);
      const marker = isSelected ? theme.fg("accent", "▶ ") : "  ";
      const title = truncateToWidth(`${task.id} ${task.title}`, width - 8);
      const line1 = `${marker}${glyph} ${isSelected ? theme.bold(title) : title}`;

      const usage = taskUsage(task);
      const activity = live ? ` · ${this.actions.liveActivity(task.id) ?? "…"}` : "";
      const group = GROUP_LABELS[taskGroup(this.frame.board, task)];
      const status =
        group === STATUS_LABELS[task.status] ? group : `${group} · ${STATUS_LABELS[task.status]}`;
      const detail = `${status} [${task.tier}] · $${usage.cost.toFixed(4)}${activity}`;
      const line2 = `     ${theme.fg("dim", truncateToWidth(detail, width - 5))}`;

      lines.push(line1);
      if (lines.length === height) break;
      lines.push(line2);
    }
    return lines;
  }

  private renderTranscript(width: number, height: number): string[] {
    width = Math.max(1, width);
    const theme = this.theme;
    const task = this.selectedTask();
    if (!task) return [];

    if (this.detailView === "evidence") return this.renderEvidence(task, width, height);

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

    for (const item of this.detailView === "transcript" ? (tail?.items ?? []) : []) {
      if (item.kind === "tool") {
        wrapped.push(
          theme.fg("muted", "→ ") +
            theme.fg("toolTitle", truncateToWidth(item.text, Math.max(1, width - 2)))
        );
      } else if (item.kind === "tool_error") {
        wrapped.push(theme.fg("error", `→ ${truncateToWidth(item.text, Math.max(1, width - 2))}`));
      } else if (item.kind === "status") {
        wrapped.push(theme.fg("dim", item.text));
      } else {
        for (const raw of item.text.split("\n")) {
          for (const line of wrapText(raw, width)) {
            wrapped.push(theme.fg("toolOutput", line));
          }
        }
      }
    }

    const steerLines = this.renderSteerControls(width, transcriptHeight);
    const visible = Math.max(0, transcriptHeight - steerLines.length);
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

    body.push(...steerLines);
    return [...summary, ...body].slice(0, height);
  }

  private renderSelectedTask(task: Task, width: number): string[] {
    const board = this.frame.board;
    const usage = taskUsage(task);
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
          `Group: ${group} · Dependencies: ${dependencies} · ${attempts} · $${usage.cost.toFixed(4)}`,
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
    const phase = this.phases().find((candidate) => candidate.current)?.label ?? "execution";
    const lines: string[] = [
      `Run › ${phase} › ${task.id}${selectedLaunch ? ` › ${selectedLaunch.label}` : ""}`,
      `Prompt source: ${singleLine(task.brief).slice(0, 500)}`,
    ];
    if (task.successCriteria?.length) {
      lines.push(
        `Success criteria: ${task.successCriteria.map(singleLine).join(" | ").slice(0, 800)}`
      );
    }
    if (attempt) {
      const executionUsage = executorUsage(attempt);
      lines.push(
        `Executor identity: model ${attempt.model ?? "unknown"} · provider ${attempt.provider ?? "unknown"}`,
        `Executor usage: ${executionUsage.turns} turns · $${executionUsage.cost.toFixed(4)} · ${executionUsage.input} input · ${executionUsage.output} output`
      );
      if (attempt.promptCharacters !== undefined || attempt.promptApproximateTokens !== undefined) {
        lines.push(
          `Executor prompt: ${attempt.promptCharacters ?? 0} chars · ~${attempt.promptApproximateTokens ?? 0} tokens${formatPromptSections(attempt.promptSections)}`
        );
      }
      if (attempt.finalReport)
        lines.push(`Final result: ${singleLine(attempt.finalReport).slice(0, 1_000)}`);
      if (attempt.touchedFiles.length > 0) {
        lines.push(`Changed files: ${attempt.touchedFiles.join(", ").slice(0, 800)}`);
      }
    }
    const latestReview = selectedLaunch ? review : attempt?.reviewLaunches?.at(-1);
    if (latestReview) {
      lines.push(
        `Reviewer: ${latestReview.role ?? "reviewer"} · ${latestReview.verdict ?? latestReview.failureReason?.kind ?? "pending"} · model ${latestReview.model ?? "unknown"} · provider ${latestReview.provider ?? "unknown"}`,
        `Review usage: ${latestReview.usage.turns} turns · $${latestReview.usage.cost.toFixed(4)} · ${latestReview.usage.input} input · ${latestReview.usage.output} output`
      );
      if (
        latestReview.promptCharacters !== undefined ||
        latestReview.promptApproximateTokens !== undefined
      ) {
        lines.push(
          `Review prompt: ${latestReview.promptCharacters ?? 0} chars · ~${latestReview.promptApproximateTokens ?? 0} tokens${formatPromptSections(latestReview.promptSections)}`
        );
      }
      if (latestReview.finalReport) {
        lines.push(`Review result: ${singleLine(latestReview.finalReport).slice(0, 1_000)}`);
      }
      if (latestReview.criterionEvidence?.length) {
        lines.push(
          `Criterion evidence: ${latestReview.criterionEvidence
            .map(
              (entry) =>
                `${entry.criterion} ${entry.passed ? "PASS" : "FAIL"} ${singleLine(entry.evidence)}`
            )
            .join(" | ")
            .slice(0, 1_000)}`
        );
      }
    } else if (attempt?.reviewUsage) {
      lines.push(
        `Legacy review: model ${attempt.reviewModel ?? "unknown"} · provider ${attempt.reviewProvider ?? "unknown"} · ${attempt.reviewUsage.turns} turns · $${attempt.reviewUsage.cost.toFixed(4)}`
      );
    }
    if (attempt?.reviewConvergence) {
      lines.push(
        `Convergence: ${attempt.reviewConvergence.policy} · ${attempt.reviewConvergence.status} · ${attempt.reviewConvergence.actualApprovals}/${attempt.reviewConvergence.requiredApprovals} approvals · ${singleLine(attempt.reviewConvergence.summary).slice(0, 500)}`
      );
    }
    if (task.findings?.length) {
      lines.push(
        `Findings: ${task.findings
          .map(
            (finding) => `${finding.status} ${finding.fingerprint}: ${singleLine(finding.message)}`
          )
          .join(" | ")
          .slice(0, 1_000)}`
      );
    }
    if (task.provenance?.candidateTree) {
      lines.push(`Candidate tree: ${task.provenance.candidateTree}`);
    }
    if (task.approvedProvenance) {
      lines.push(
        `Completion fingerprint: ${task.approvedProvenance.fingerprint.slice(0, 12)} · ${task.approvedProvenance.artifact.kind} ${task.approvedProvenance.artifact.identity.slice(0, 12)}`
      );
    } else if (task.status === "approved") {
      lines.push("Completion fingerprint: legacy proof unavailable · retry or create a successor");
    }
    if (task.provenance?.integratedTree) {
      lines.push(`Integrated tree: ${task.provenance.integratedTree}`);
    }
    const integratedCommit = task.provenance?.integratedCommit ?? task.integratedCommit;
    if (integratedCommit) lines.push(`Integration commit: ${integratedCommit}`);
    if (task.verificationProfile || task.verificationSummary || task.provenance?.verifiedAt) {
      lines.push(
        `Verification: ${task.provenance?.verifiedAt ? "passed" : "pending"} · profile ${task.provenance?.verificationProfile ?? task.verificationProfile ?? "none"} · ${singleLine(task.verificationSummary ?? "no summary")}`
      );
    }
    if (attempt) {
      lines.push(
        `Recovery refs: worktree ${attempt.worktreePath ?? "none"} · branch ${attempt.branch ?? "none"} · log ${attempt.logFile} · session ${attempt.sessionFile ?? "none"}`
      );
      if (attempt.failureReason) {
        lines.push(
          `Failure: ${attempt.failureReason.kind} · ${singleLine(attempt.failureReason.message)} · ${attempt.failureReason.retryable ? "retryable" : "not retryable"}`
        );
      }
    }
    if (task.dispatchClaim || task.dispatchNote) {
      lines.push(
        `Dispatch: ${task.dispatchClaim?.kind ?? "none"} ${task.dispatchClaim?.id ?? ""} · ${singleLine(task.dispatchNote ?? "no note")}`
      );
    }
    if (board.pausedDrive) {
      lines.push(
        `Paused drive: owner ${board.pausedDrive.ownerSession ?? "unknown"} · scope ${board.pausedDrive.taskIds?.join(", ") ?? "all"}`
      );
    }
    const decision = board.activeDecision;
    if (decision?.taskIds.includes(task.id)) {
      lines.push(
        `Decision: ${decision.id} · ${decision.kind} · owner ${decision.ownerSession ?? "unknown"} · ${singleLine(decision.evidence).slice(0, 500)}`
      );
    }

    const logFile = selectedLaunch
      ? selectedLaunch.kind === "review"
        ? latestReview?.logFile
        : attempt?.logFile
      : attempt?.logFile;
    if (logFile) {
      let tail = this.tails.get(logFile);
      if (!tail) {
        tail = new TranscriptTail(logFile);
        this.tails.set(logFile, tail);
      }
      tail.poll();
      const activity = tail.items
        .slice(-3)
        .map((item) => singleLine(item.text))
        .filter(Boolean)
        .join(" | ");
      if (activity) lines.push(`Recent activity: ${activity.slice(0, 800)}`);
    }

    const wrapped = lines.flatMap((line) => wrapText(line, width));
    const maxScroll = Math.max(0, wrapped.length - height);
    if (this.scrollUp > maxScroll) this.scrollUp = maxScroll;
    const end = wrapped.length - this.scrollUp;
    return wrapped
      .slice(Math.max(0, end - height), end)
      .map((line, index) =>
        index === 0 ? this.theme.bold(line) : this.theme.fg("toolOutput", line)
      );
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

  private renderSteerControls(width: number, height: number): string[] {
    if (this.mode === "steer") {
      return [
        this.theme.fg("accent", "steer ▸ ") +
          (this.steerInput.render(Math.max(1, width - 8))[0] ?? ""),
        this.theme.fg("dim", "enter send · esc cancel"),
      ].slice(0, height);
    }
    if (this.mode !== "steer_templates") return [];

    const optionRows = Math.min(STEER_OPTIONS.length, height);
    const firstOption = Math.min(
      Math.max(0, this.steerOption - optionRows + 1),
      STEER_OPTIONS.length - optionRows
    );
    const lines = STEER_OPTIONS.slice(firstOption, firstOption + optionRows).map(
      (option, offset) => {
        const index = firstOption + offset;
        const marker = index === this.steerOption ? "▶ " : "  ";
        const text = truncateToWidth(`${marker}${option}`, width);
        return index === this.steerOption ? this.theme.fg("accent", text) : text;
      }
    );
    if (height > STEER_OPTIONS.length) {
      lines.push(this.theme.fg("dim", "↑↓ select · enter choose · esc cancel"));
    }
    return lines;
  }

  private renderFooter(width: number): string {
    const theme = this.theme;
    const task = this.selectedTask();
    if (this.mode === "confirm_abort" && task) {
      return theme.fg("error", ` Abort ${task.id}? Press y to confirm, any other key to cancel `);
    }
    if (this.mode === "confirm_accept" && task) {
      return theme.fg(
        "warning",
        ` Approve ${task.id} without review? Press y to confirm, any other key to cancel `
      );
    }
    if (this.navigationLevel === "phase") {
      return theme.fg("dim", truncateToWidth(" ↑↓ phases · → tasks · esc close ", width));
    }
    const live = task ? this.actions.isLive(task.id) : false;
    const parts = [
      ...(this.frame.board.planPending ? ["plan gated · /maestro plan to review"] : []),
      this.navigationLevel === "launch" ? "↑↓ launches" : "↑↓ tasks",
      "esc close",
      "PgUp/PgDn scroll",
    ];
    if (live) parts.push("s steer", "x abort");
    else if (task) {
      if (lastAttemptReport(task)) parts.push("p report");
      if (task.attempts.at(-1)?.reviewReport) parts.push("v verdict");
      if (this.actions.hasExecutorSession(task.id)) parts.push("enter executor");
      if (this.actions.hasReviewerSession(task.id)) parts.push("O reviewer");
      if (task.status === "ready_for_review") parts.push("a approve");
      if (this.actions.retryEligibility(task.id).eligible) parts.push("r retry");
    }
    const groupFilter = this.filter === "all" ? "all" : GROUP_LABELS[this.filter];
    parts.push(
      `g group:${groupFilter}`,
      `t ${this.detailView === "transcript" ? "timeline" : "transcript"}`,
      this.detailView === "evidence" ? "e transcript" : "e evidence",
      this.hideDone ? "f show done" : "f hide done",
      this.navigationLevel === "launch" ? "← task" : "← phases · → launches"
    );
    return theme.fg("dim", truncateToWidth(` ${parts.join(" · ")} `, width));
  }
}

function visibleWindow<T>(items: readonly T[], selected: number, height: number) {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  return items
    .slice(start, start + height)
    .map((item, offset) => ({ item, index: start + offset }));
}

function lastAttemptReport(task: Task): string | undefined {
  return task.attempts.at(-1)?.finalReport;
}

function latestFailure(task: Task): string | undefined {
  const attempt = task.attempts.at(-1);
  const reason = attempt?.failureReason;
  if (reason && ["failed", "changes_requested", "ready_for_review"].includes(task.status)) {
    const retry = reason.retryable ? "retryable" : "not retryable";
    return `${reason.kind.replaceAll("_", " ")} · ${singleLine(reason.message)} · ${retry}`;
  }
  if (task.status === "changes_requested") return "reviewer rejection";
  if (task.status !== "failed") return undefined;
  if (attempt?.errorMessage) return singleLine(attempt.errorMessage);
  return "executor failed without a recorded reason";
}

function attemptDetails(attempt: Attempt): string {
  const model = attempt.model ?? "unknown model";
  const provider = attempt.provider ?? "unknown provider";
  return `Latest #${attempt.index}: model ${model} · provider ${provider} · ${attempt.usage.turns} turns · $${attempt.usage.cost.toFixed(4)}`;
}

function executorUsage(attempt: Attempt): Usage {
  const review = attempt.reviewUsage;
  if (!review) return attempt.usage;
  return {
    input: Math.max(0, attempt.usage.input - review.input),
    output: Math.max(0, attempt.usage.output - review.output),
    cost: Math.max(0, attempt.usage.cost - review.cost),
    turns: Math.max(0, attempt.usage.turns - review.turns),
  };
}

function formatPromptSections(
  sections: Array<{ name: string; characters: number; omitted: boolean }> | undefined
): string {
  if (!sections?.length) return "";
  return ` · ${sections
    .map((section) => `${section.name} ${section.characters}${section.omitted ? " omitted" : ""}`)
    .join(", ")}`;
}

function attemptHistory(attempt: Attempt): string {
  let outcome = "in progress";
  if (attempt.failureReason) outcome = attempt.failureReason.kind.replaceAll("_", " ");
  else if (attempt.reviewNotes) outcome = "changes requested";
  else if (attempt.reviewReport) outcome = "reviewed";
  else if (attempt.finalReport) outcome = "completed";
  else if (attempt.exitCode !== undefined) outcome = attempt.exitCode === 0 ? "finished" : "failed";
  const provider = attempt.provider ?? "?";
  const model = attempt.model ?? "?";
  const identity = model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
  return `#${attempt.index} ${outcome} · ${identity} · ${attempt.usage.turns}t · $${attempt.usage.cost.toFixed(4)}`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  return w >= width ? truncateToWidth(line, width) : line + " ".repeat(width - w);
}

export function wrapText(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) return [text];
  const lines: string[] = [];
  let characters = Array.from(text);
  while (characters.length > 0) {
    let usedWidth = 0;
    let end = 0;
    let whitespace = -1;
    while (end < characters.length) {
      const characterWidth = visibleWidth(characters[end] ?? "");
      if (usedWidth + characterWidth > width) break;
      usedWidth += characterWidth;
      if (/\s/.test(characters[end] ?? "")) whitespace = end;
      end += 1;
    }
    if (end === characters.length) {
      lines.push(characters.join(""));
      break;
    }
    const cut = whitespace > 0 ? whitespace : Math.max(1, end);
    lines.push(characters.slice(0, cut).join("").trimEnd());
    characters = characters.slice(cut);
    while (/\s/.test(characters[0] ?? "")) characters.shift();
  }
  return lines;
}
