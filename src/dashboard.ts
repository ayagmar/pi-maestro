import { type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { boardUsage, STATUS_GLYPHS, STATUS_LABELS, taskUsage } from "./format.js";
import { TranscriptTail } from "./transcript.js";
import { type Board, type Task, type TaskStatus } from "./types.js";

export interface DashboardActions {
  getBoard(): Board;
  isLive(taskId: string): boolean;
  liveActivity(taskId: string): string | undefined;
  steer(taskId: string, message: string): void;
  abort(taskId: string): void;
  setTaskStatus(taskId: string, status: TaskStatus): void;
  /** Close the dashboard and switch the TUI into the task's session. */
  openSession(taskId: string): void;
  close(): void;
  requestRender(): void;
}

const REFRESH_MS = 500;
export const DEFAULT_DASHBOARD_BODY_HEIGHT = 22;
const MIN_DASHBOARD_BODY_HEIGHT = 2;

type Mode = "browse" | "steer_templates" | "steer" | "confirm_abort";

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

  /** Tasks currently shown: hideDone filters out settled work (approved/cancelled). */
  private visibleTasks(): Task[] {
    const tasks = this.actions.getBoard().tasks;
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
    } else if (matchesKey(data, "pageUp")) {
      this.scrollUp += 10;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollUp = Math.max(0, this.scrollUp - 10);
    } else if (data === "s" && task && this.actions.isLive(task.id)) {
      this.steerOption = 0;
      this.mode = "steer_templates";
    } else if (data === "x" && task && this.actions.isLive(task.id)) {
      this.mode = "confirm_abort";
    } else if (data === "a" && task && !this.actions.isLive(task.id)) {
      this.actions.setTaskStatus(task.id, "approved");
    } else if (data === "r" && task && !this.actions.isLive(task.id)) {
      this.actions.setTaskStatus(task.id, "todo");
    } else if ((matchesKey(data, "return") || data === "o") && task) {
      this.actions.openSession(task.id);
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

    const left = this.renderTaskList(visible, listWidth, bodyHeight);
    const right = this.renderTranscript(transcriptWidth, bodyHeight);

    const lines: string[] = [];
    const usage = boardUsage(board.tasks);
    const running = board.tasks.filter((t) => this.actions.isLive(t.id)).length;
    const hiddenCount = board.tasks.length - visible.length;
    const filterPart = this.hideDone ? ` · hiding ${hiddenCount} done` : "";
    const title = ` ⚡ maestro dashboard · ${board.tasks.length} task(s) · ${running} running · $${usage.cost.toFixed(4)}${filterPart} `;
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

  private renderTaskList(tasks: Task[], width: number, height: number): string[] {
    const theme = this.theme;
    if (tasks.length === 0) {
      if (this.hideDone) {
        return [theme.fg("muted", "All tasks are done."), theme.fg("dim", "f show them again")];
      }
      return [
        theme.fg("muted", "Board is empty."),
        theme.fg("dim", "Use /maestro start <goal>"),
      ].slice(0, height);
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
      const detail = `${STATUS_LABELS[task.status]} [${task.tier}] · $${usage.cost.toFixed(4)}${activity}`;
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

    const steerLines = this.renderSteerControls(width, height);
    const visible = Math.max(0, height - steerLines.length);
    const maxScroll = Math.max(0, wrapped.length - visible);
    if (this.scrollUp > maxScroll) this.scrollUp = maxScroll;
    const end = wrapped.length - this.scrollUp;
    const body = wrapped.slice(Math.max(0, end - visible), end);

    body.push(...steerLines);
    return body.slice(0, height);
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
      if (task.attempts.length > 0) parts.push("enter open session");
      if (task.status !== "approved") parts.push("a approve");
      if (task.status !== "todo") parts.push("r reopen");
    }
    parts.push(this.hideDone ? "f show done" : "f hide done", "esc close");
    return theme.fg("dim", truncateToWidth(` ${parts.join(" · ")} `, width));
  }
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
