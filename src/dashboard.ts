import { type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { STATUS_GLYPHS, STATUS_LABELS, boardUsage, taskUsage } from "./format.js";
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

type Mode = "browse" | "steer" | "confirm_abort";

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
  private steerInput = new Input();
  private tails = new Map<string, TranscriptTail>();
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private theme: Theme,
    private actions: DashboardActions
  ) {
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

  private selectedTask(): Task | undefined {
    return this.actions.getBoard().tasks[this.selected];
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

    const board = this.actions.getBoard();
    const task = this.selectedTask();

    if (matchesKey(data, "escape") || data === "q") {
      this.actions.close();
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.scrollUp = 0;
    } else if (matchesKey(data, "down")) {
      this.selected = Math.min(Math.max(0, board.tasks.length - 1), this.selected + 1);
      this.scrollUp = 0;
    } else if (matchesKey(data, "pageUp")) {
      this.scrollUp += 10;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollUp = Math.max(0, this.scrollUp - 10);
    } else if (data === "s" && task && this.actions.isLive(task.id)) {
      this.mode = "steer";
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

  render(width: number): string[] {
    const theme = this.theme;
    const board = this.actions.getBoard();
    if (this.selected >= board.tasks.length) this.selected = Math.max(0, board.tasks.length - 1);

    const listWidth = Math.min(44, Math.max(24, Math.floor(width * 0.35)));
    const transcriptWidth = width - listWidth - 3;
    const bodyHeight = 22;

    const left = this.renderTaskList(board, listWidth, bodyHeight);
    const right = this.renderTranscript(transcriptWidth, bodyHeight);

    const lines: string[] = [];
    const usage = boardUsage(board.tasks);
    const running = board.tasks.filter((t) => this.actions.isLive(t.id)).length;
    const title = ` ⚡ conductor dashboard · ${board.tasks.length} task(s) · ${running} running · $${usage.cost.toFixed(4)} `;
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

  private renderTaskList(board: Board, width: number, height: number): string[] {
    const theme = this.theme;
    if (board.tasks.length === 0) {
      return [theme.fg("muted", "Board is empty."), theme.fg("dim", "Use /conductor start <goal>")];
    }

    const lines: string[] = [];
    const start = Math.max(
      0,
      Math.min(this.selected - Math.floor(height / 4), board.tasks.length - height / 2)
    );
    for (let i = Math.floor(start); i < board.tasks.length && lines.length < height; i++) {
      const task = board.tasks[i];
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

      lines.push(line1, line2);
    }
    return lines;
  }

  private renderTranscript(width: number, height: number): string[] {
    const theme = this.theme;
    const task = this.selectedTask();
    if (!task) return [];
    const tail = this.tailFor(task);
    if (!tail) return [theme.fg("muted", "No attempt yet — task has not run.")];
    tail.poll();

    if (tail.items.length === 0) {
      return [theme.fg("muted", "Waiting for executor output…")];
    }

    const wrapped: string[] = [];
    for (const item of tail.items) {
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

    const reserved = this.mode === "steer" ? 2 : 0;
    const visible = height - reserved;
    const maxScroll = Math.max(0, wrapped.length - visible);
    if (this.scrollUp > maxScroll) this.scrollUp = maxScroll;
    const end = wrapped.length - this.scrollUp;
    const body = wrapped.slice(Math.max(0, end - visible), end);

    if (this.mode === "steer") {
      body.push(theme.fg("accent", "steer ▸ ") + (this.steerInput.render(width - 8)[0] ?? ""));
      body.push(theme.fg("dim", "enter send · esc cancel"));
    }
    return body;
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
      parts.push("a approve", "r reopen");
    }
    parts.push("esc close");
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
