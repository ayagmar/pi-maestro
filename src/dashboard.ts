import { type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { blockedReason, groupTasks, taskGroup } from "./board.js";
import { boardUsage, STATUS_GLYPHS, STATUS_LABELS, taskUsage } from "./format.js";
import { TranscriptTail } from "./transcript.js";
import { type Attempt, type Board, type Task, type TaskGroup, type TaskStatus } from "./types.js";

export type DashboardTaskAction = "view_report" | "view_review" | "open_executor" | "open_reviewer";

export interface DashboardActions {
  getBoard(): Board;
  isLive(taskId: string): boolean;
  liveActivity(taskId: string): string | undefined;
  steer(taskId: string, message: string): void;
  abort(taskId: string): void;
  setTaskStatus(taskId: string, status: TaskStatus): void;
  hasExecutorSession(taskId: string): boolean;
  hasReviewerSession(taskId: string): boolean;
  /** Close the dashboard and route an inspection action through the command helpers. */
  selectTaskAction(taskId: string, action: DashboardTaskAction): void;
  close(): void;
  requestRender(): void;
}

const REFRESH_MS = 500;
export const DEFAULT_DASHBOARD_BODY_HEIGHT = 22;
const MIN_DASHBOARD_BODY_HEIGHT = 2;

type Mode = "browse" | "steer_templates" | "steer" | "confirm_abort";
type DashboardFilter = "all" | TaskGroup;

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
}

function statusColor(status: TaskStatus): "success" | "error" | "warning" | "accent" | "muted" {
  if (status === "approved") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "running" || status === "changes_requested") return "warning";
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
  private mode: Mode = "browse";
  private scrollUp = 0;
  private hideDone = false;
  private filter: DashboardFilter = "all";
  private steerOption = 0;
  private steerInput = new Input();
  private tails = new Map<string, TranscriptTail>();
  private timer: ReturnType<typeof setInterval>;
  private bodyHeight: number;

  constructor(
    private theme: Theme,
    private actions: DashboardActions,
    options: DashboardOptions = {}
  ) {
    this.bodyHeight = Math.max(
      MIN_DASHBOARD_BODY_HEIGHT,
      Math.floor(options.bodyHeight ?? DEFAULT_DASHBOARD_BODY_HEIGHT)
    );
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

  /** Tasks currently shown, ordered by their workflow group. */
  private visibleTasks(): Task[] {
    const board = this.actions.getBoard();
    const grouped = groupTasks(board);
    const tasks =
      this.filter === "all" ? GROUPS.flatMap((group) => grouped[group]) : grouped[this.filter];
    if (!this.hideDone) return tasks;
    return tasks.filter((task) => task.status !== "approved" && task.status !== "cancelled");
  }

  private selectedTask(): Task | undefined {
    return this.visibleTasks()[this.selected];
  }

  private tailFor(task: Task): TranscriptTail | undefined {
    const attempt = task.attempts.at(-1);
    if (!attempt) return undefined;
    let tail = this.tails.get(attempt.logFile);
    if (!tail) {
      tail = new TranscriptTail(attempt.logFile);
      this.tails.set(attempt.logFile, tail);
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

    const visible = this.visibleTasks();
    const task = this.selectedTask();

    if (matchesKey(data, "escape") || data === "q") {
      this.actions.close();
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.scrollUp = 0;
    } else if (matchesKey(data, "down")) {
      this.selected = Math.min(Math.max(0, visible.length - 1), this.selected + 1);
      this.scrollUp = 0;
    } else if (data === "f") {
      this.hideDone = !this.hideDone;
      this.selected = 0;
      this.scrollUp = 0;
    } else if (data === "g") {
      const current = FILTERS.indexOf(this.filter);
      this.filter = FILTERS[(current + 1) % FILTERS.length] ?? "all";
      this.selected = 0;
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
      this.actions.setTaskStatus(task.id, "approved");
    } else if (
      data === "r" &&
      task &&
      (task.status === "approved" ||
        task.status === "changes_requested" ||
        task.status === "failed" ||
        task.status === "cancelled") &&
      !this.actions.isLive(task.id)
    ) {
      this.actions.setTaskStatus(task.id, "todo");
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
    const theme = this.theme;
    const board = this.actions.getBoard();
    const visible = this.visibleTasks();
    if (this.selected >= visible.length) this.selected = Math.max(0, visible.length - 1);

    const listWidth = Math.min(44, Math.max(24, Math.floor(width * 0.35)));
    const transcriptWidth = width - listWidth - 3;
    const bodyHeight = this.bodyHeight;

    const left = this.renderTaskList(visible, board.tasks.length, listWidth, bodyHeight);
    const right = this.renderTranscript(transcriptWidth, bodyHeight);

    const lines: string[] = [];
    const usage = boardUsage(board.tasks);
    const running = board.tasks.filter((t) => this.actions.isLive(t.id)).length;
    const hiddenCount = board.tasks.length - visible.length;
    const doneFilterPart = this.hideDone ? ` · hiding ${hiddenCount} done` : "";
    const statusFilterPart = this.filter === "all" ? "" : ` · filter: ${GROUP_LABELS[this.filter]}`;
    const completed =
      board.tasks.length > 0 &&
      board.tasks.every((task) => task.status === "approved" || task.status === "cancelled")
        ? " · board complete"
        : "";
    const title = ` ⚡ maestro dashboard · ${board.tasks.length} task(s) · ${running} running · $${usage.cost.toFixed(4)}${completed}${statusFilterPart}${doneFilterPart} `;
    lines.push(theme.fg("accent", truncateToWidth(title + "─".repeat(width), width)));

    for (let i = 0; i < bodyHeight; i++) {
      const l = left[i] ?? " ".repeat(listWidth);
      const r = right[i] ?? "";
      lines.push(`${padToWidth(l, listWidth)} ${theme.fg("dim", "│")} ${r}`);
    }

    lines.push(theme.fg("dim", "─".repeat(width)));
    lines.push(this.renderFooter(width));
    return lines.map((line) => truncateToWidth(line, width));
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
      const group = GROUP_LABELS[taskGroup(this.actions.getBoard(), task)];
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
    const theme = this.theme;
    const task = this.selectedTask();
    if (!task) return [];

    const maxSummaryHeight = Math.min(11, Math.max(1, Math.ceil(height / 2)));
    const summary = this.renderSelectedTask(task, width).slice(0, maxSummaryHeight);
    const transcriptHeight = Math.max(0, height - summary.length);
    const tail = this.tailFor(task);
    tail?.poll();

    const wrapped: string[] = [];
    if (!tail) {
      wrapped.push(theme.fg("muted", "No attempt yet — task has not run."));
    } else if (tail.items.length === 0) {
      wrapped.push(theme.fg("muted", "Waiting for executor output…"));
    }

    for (const item of tail?.items ?? []) {
      if (item.kind === "tool") {
        wrapped.push(
          theme.fg("muted", "→ ") + theme.fg("toolTitle", truncateToWidth(item.text, width - 2))
        );
      } else if (item.kind === "tool_error") {
        wrapped.push(theme.fg("error", `→ ${truncateToWidth(item.text, width - 2)}`));
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
    const maxScroll = Math.max(0, wrapped.length - visible);
    if (this.scrollUp > maxScroll) this.scrollUp = maxScroll;
    const end = wrapped.length - this.scrollUp;
    const body = wrapped.slice(Math.max(0, end - visible), end);

    body.push(...steerLines);
    return [...summary, ...body].slice(0, height);
  }

  private renderSelectedTask(task: Task, width: number): string[] {
    const board = this.actions.getBoard();
    const usage = taskUsage(task);
    const dependencies = task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none";
    const attempts = `${task.attempts.length} attempt${task.attempts.length === 1 ? "" : "s"}`;
    const group = GROUP_LABELS[taskGroup(board, task)];
    const heading = `${STATUS_GLYPHS[task.status]} ${task.id} · ${STATUS_LABELS[task.status]} · ${task.tier}`;
    const lines = [
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
      const dependency = board.tasks.find((candidate) => candidate.id === dependencyId);
      if (dependency?.status === "approved") return [];
      return [`${dependencyId} (${dependency ? STATUS_LABELS[dependency.status] : "missing"})`];
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

  private nextAction(task: Task): string {
    if (this.actions.isLive(task.id)) return "Monitor output, steer if needed, or abort.";
    if (task.status === "ready_for_review")
      return "Review the result; open its session or approve it.";
    if (task.status === "changes_requested") return "Retry with the reviewer notes (r).";
    if (task.status === "approved") return "Complete — no action needed.";
    if (task.status === "failed") return "Reopen the task to retry it.";
    if (task.status === "cancelled") return "Reopen the task if it should run.";
    const reason = blockedReason(this.actions.getBoard(), task);
    if (reason) return `Waiting for ${reason.slice("blocked by ".length)} to complete.`;
    return "Ready to run when the orchestrator dispatches it.";
  }

  private renderSteerControls(width: number, height: number): string[] {
    if (this.mode === "steer") {
      return [
        this.theme.fg("accent", "steer ▸ ") + (this.steerInput.render(width - 8)[0] ?? ""),
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
    const live = task ? this.actions.isLive(task.id) : false;
    const parts = ["↑↓ tasks", "PgUp/PgDn scroll"];
    if (live) parts.push("s steer", "x abort");
    else if (task) {
      if (lastAttemptReport(task)) parts.push("p report");
      if (task.attempts.at(-1)?.reviewReport) parts.push("v verdict");
      if (this.actions.hasExecutorSession(task.id)) parts.push("enter executor");
      if (this.actions.hasReviewerSession(task.id)) parts.push("O reviewer");
      if (task.status === "ready_for_review") parts.push("a approve");
      if (task.status === "failed" || task.status === "changes_requested") parts.push("r retry");
      else if (task.status === "approved" || task.status === "cancelled") parts.push("r reopen");
    }
    const groupFilter = this.filter === "all" ? "all" : GROUP_LABELS[this.filter];
    parts.push(
      `g group:${groupFilter}`,
      this.hideDone ? "f show done" : "f hide done",
      "esc close"
    );
    return theme.fg("dim", truncateToWidth(` ${parts.join(" · ")} `, width));
  }
}

function lastAttemptReport(task: Task): string | undefined {
  return task.attempts.at(-1)?.finalReport;
}

function latestFailure(task: Task): string | undefined {
  const attempt = task.attempts.at(-1);
  if (task.status === "changes_requested") return "reviewer rejection";
  if (task.status !== "failed") return undefined;
  const reason = attempt?.failureReason;
  if (reason) {
    const retry = reason.retryable ? "retryable" : "not retryable";
    return `${reason.kind.replaceAll("_", " ")} · ${singleLine(reason.message)} · ${retry}`;
  }
  if (attempt?.errorMessage) return singleLine(attempt.errorMessage);
  return "executor failed without a recorded reason";
}

function attemptDetails(attempt: Attempt): string {
  const model = attempt.model ?? "unknown model";
  const provider = attempt.provider ?? "unknown provider";
  return `Latest #${attempt.index}: model ${model} · provider ${provider} · ${attempt.usage.turns} turns · $${attempt.usage.cost.toFixed(4)}`;
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

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    lines.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  if (rest) lines.push(rest);
  return lines;
}
