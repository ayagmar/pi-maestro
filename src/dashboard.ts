import { type Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { completionFreshness } from "./artifact-policy.js";
import {
  blockedReason,
  findTask,
  groupTasks,
  type HumanRetryEligibility,
  taskGroup,
} from "./board.js";
import {
  boardUsage,
  formatCostSummary,
  formatStatusHistory,
  STATUS_GLYPHS,
  STATUS_LABELS,
  taskUsage,
} from "./format.js";
import { projectRunPhases, projectStatus } from "./status.js";
import { deriveRunTimeline, formatRunTimeline } from "./timeline.js";
import { TranscriptTail, type TranscriptItem } from "./transcript.js";
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

const REFRESH_MS = 500;
export const DEFAULT_DASHBOARD_BODY_HEIGHT = 22;
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
type DashboardFilter = "all" | TaskGroup;
type NavigationLevel = "phase" | "task" | "launch";
type DetailView = "transcript" | "timeline" | "summary" | "evidence";

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

const STEER_OPTIONS = [
  "Stop - wrong approach, report current state",
  "Run the project checks before finishing",
  "Stay strictly within the task brief scope",
  "Custom message...",
] as const;

function steerTemplateLines(
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

/** Shared transcript projection used by the dashboard and ambient live pane. */
export function styledTranscriptLines(
  theme: Theme,
  items: readonly TranscriptItem[],
  width: number
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [];

  for (const item of items) {
    if (item.kind === "tool") {
      lines.push(
        theme.fg("muted", "→ ") +
          theme.fg("toolTitle", truncateToWidth(item.text, Math.max(1, safeWidth - 2)))
      );
      continue;
    }
    if (item.kind === "tool_error") {
      lines.push(theme.fg("error", truncateToWidth(`→ ${item.text}`, safeWidth)));
      continue;
    }
    if (item.kind === "status") {
      lines.push(theme.fg("dim", truncateToWidth(item.text, safeWidth)));
      continue;
    }
    for (const raw of item.text.split("\n")) {
      for (const line of wrapText(raw, safeWidth)) {
        lines.push(theme.fg("toolOutput", line));
      }
    }
  }

  return lines.map((line) => truncateToWidth(line, safeWidth));
}

export interface LivePaneLaunch {
  /** Stable identity for one executor or reviewer process launch. */
  key: string;
  taskId: string;
  title: string;
  kind: "execute" | "review";
  logFile: string;
  model?: string;
  provider?: string;
  turns: number;
  cost: number;
  lastActivity: string;
}

export interface LivePaneOptions {
  getLaunches(): readonly LivePaneLaunch[];
  requestRender(): void;
  onEscape(): void;
  onCycleVisibility(): void;
  onSteer?(launch: LivePaneLaunch, message: string): void;
  onFollowUp?(launch: LivePaneLaunch, message: string): void;
  height?: number;
  getHeight?: () => number;
}

type LivePaneStatus = "thinking" | "streaming" | "tool" | "done";
type LivePaneMode = "browse" | "steer_templates" | "steer" | "follow_up";

const LIVE_PANE_STATUS: Record<
  LivePaneStatus,
  { glyph: string; color: "warning" | "success" | "accent" }
> = {
  thinking: { glyph: "◐", color: "warning" },
  streaming: { glyph: "●", color: "success" },
  tool: { glyph: "◑", color: "accent" },
  done: { glyph: "✓", color: "success" },
};

/** Ambient, bounded transcript follower for active executor and reviewer launches. */
export class LivePaneComponent {
  private _focused = false;
  private selectedKey: string | undefined;
  private readonly launchOrder: string[] = [];
  private previousLaunches = new Map<string, LivePaneLaunch>();
  private readonly tails = new Map<string, TranscriptTail>();
  private scrollOffset = Number.MAX_SAFE_INTEGER;
  private renderedScrollOffset = 0;
  private followMode = true;
  private settledNotice: string | undefined;
  private queuedNotice: string | undefined;
  private mode: LivePaneMode = "browse";
  private steerOption = 0;
  private readonly steerInput = new Input();
  private readonly followUpInput = new Input();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly theme: Theme,
    private readonly options: LivePaneOptions
  ) {
    this.steerInput.onSubmit = (value) => this.submitMessage("steer", value);
    this.steerInput.onEscape = () => {
      this.mode = "browse";
    };
    this.followUpInput.onSubmit = (value) => this.submitMessage("follow_up", value);
    this.followUpInput.onEscape = () => {
      this.mode = "browse";
    };
    this.timer = setInterval(() => options.requestRender(), REFRESH_MS);
    this.timer.unref();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.steerInput.focused = value;
    this.followUpInput.focused = value;
  }

  dispose(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (!this.focused) return;
    if (matchesKey(data, Key.ctrlAlt("w"))) {
      this.options.onCycleVisibility();
      return;
    }
    if (this.mode === "steer_templates") {
      this.handleSteerTemplateInput(data);
      this.options.requestRender();
      return;
    }
    if (this.mode === "steer") {
      this.steerInput.handleInput(data);
      this.options.requestRender();
      return;
    }
    if (this.mode === "follow_up") {
      this.followUpInput.handleInput(data);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.options.onEscape();
      return;
    }

    const launches = this.syncLaunches();
    if (data === "s" && this.options.onSteer) {
      this.steerOption = 0;
      this.mode = "steer_templates";
      this.options.requestRender();
      return;
    }
    if (data === "F" && this.options.onFollowUp) {
      this.mode = "follow_up";
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.selectOffset(launches, -1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.selectOffset(launches, 1);
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.followMode = false;
      this.scrollOffset = Math.max(0, this.renderedScrollOffset - 1);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.scrollOffset = this.renderedScrollOffset + 1;
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.followMode = false;
      this.scrollOffset = Math.max(0, this.renderedScrollOffset - 10);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = this.renderedScrollOffset + 10;
      this.options.requestRender();
      return;
    }
    if (data === "g") {
      this.followMode = false;
      this.scrollOffset = 0;
      this.options.requestRender();
      return;
    }
    if (data === "G" || matchesKey(data, Key.shift("g"))) {
      this.followMode = true;
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.options.requestRender();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const height = Math.max(
      1,
      Math.floor(this.options.getHeight?.() ?? this.options.height ?? DEFAULT_DASHBOARD_BODY_HEIGHT)
    );
    const launches = this.syncLaunches();
    const selected = launches.find((launch) => launch.key === this.selectedKey);
    if (!selected) return this.renderSettled(safeWidth, height);

    const tail = this.tailFor(selected);
    tail.poll();
    const transcript = styledTranscriptLines(this.theme, tail.items, safeWidth);
    if (transcript.length === 0) {
      transcript.push(
        this.theme.fg("muted", truncateToWidth("Waiting for agent output…", safeWidth))
      );
    }

    const header = this.renderHeader(selected, tail.items, safeWidth);
    const footerRows = height >= 3 ? 1 : 0;
    const stripRows = launches.length > 1 && height >= 4 ? 1 : 0;
    const noticeRows = this.settledNotice && height >= 5 ? 1 : 0;
    const fixedRows = 1 + footerRows + stripRows + noticeRows;
    const actionLines = this.renderActionControls(safeWidth, Math.max(0, height - fixedRows));
    const bodyHeight = Math.max(0, height - fixedRows - actionLines.length);
    const maxScroll = Math.max(0, transcript.length - bodyHeight);
    const requestedOffset = this.followMode ? Number.MAX_SAFE_INTEGER : this.scrollOffset;
    this.renderedScrollOffset = Math.min(requestedOffset, maxScroll);
    const body = transcript.slice(
      this.renderedScrollOffset,
      this.renderedScrollOffset + bodyHeight
    );

    const lines = [
      header,
      ...(stripRows ? [this.renderLaunchStrip(launches, safeWidth)] : []),
      ...(noticeRows
        ? [this.theme.fg("success", truncateToWidth(this.settledNotice ?? "", safeWidth))]
        : []),
      ...body,
      ...actionLines,
      ...(footerRows
        ? [this.renderFooter(transcript.length, bodyHeight, this.renderedScrollOffset, safeWidth)]
        : []),
    ];
    return lines.slice(0, height).map((line) => truncateToWidth(line, safeWidth));
  }

  private tailFor(launch: LivePaneLaunch): TranscriptTail {
    const existing = this.tails.get(launch.key);
    if (existing?.file === launch.logFile) return existing;
    const tail = new TranscriptTail(launch.logFile);
    this.tails.set(launch.key, tail);
    return tail;
  }

  private renderHeader(
    launch: LivePaneLaunch,
    items: readonly TranscriptItem[],
    width: number
  ): string {
    const identity = launch.model ?? launch.provider ?? "model unknown";
    const title =
      launch.kind === "review"
        ? `${launch.taskId} · review · [${identity}]`
        : `${launch.taskId} · ${launch.title} [${identity}]`;
    const status = this.launchStatus(items);
    const details = LIVE_PANE_STATUS[status];
    const statusText = `${details.glyph} ${status}`;
    const availableTitle = Math.max(1, width - visibleWidth(statusText) - 1);
    return truncateToWidth(
      `${this.theme.fg("accent", truncateToWidth(title, availableTitle))} ${this.theme.fg(details.color, statusText)}`,
      width
    );
  }

  private launchStatus(items: readonly TranscriptItem[]): LivePaneStatus {
    const latest = items.at(-1);
    if (!latest) return "thinking";
    if (latest.kind === "status") return "done";
    if (latest.kind === "tool" || latest.kind === "tool_error") return "tool";
    return "streaming";
  }

  private renderLaunchStrip(launches: readonly LivePaneLaunch[], width: number): string {
    const selectedIndex = Math.max(
      0,
      launches.findIndex((launch) => launch.key === this.selectedKey)
    );
    const capacity = Math.max(1, Math.floor(width / 14));
    const start = Math.min(
      Math.max(0, selectedIndex - Math.floor(capacity / 2)),
      Math.max(0, launches.length - capacity)
    );
    const visible = launches.slice(start, start + capacity).map((launch) => {
      const selected = launch.key === this.selectedKey;
      const marker = selected ? "▶" : "·";
      const label = `${marker} ${launch.taskId}`;
      return selected ? this.theme.fg("accent", label) : this.theme.fg("dim", label);
    });
    const earlier = start > 0 ? `←${start} ` : "";
    const later =
      start + visible.length < launches.length
        ? ` +${launches.length - start - visible.length}→`
        : "";
    return truncateToWidth(
      `${this.theme.fg("dim", earlier)}${visible.join(this.theme.fg("dim", " │ "))}${this.theme.fg("dim", later)}`,
      width
    );
  }

  private renderFooter(
    transcriptLines: number,
    visibleLines: number,
    offset: number,
    width: number
  ): string {
    const first = transcriptLines === 0 ? 0 : offset + 1;
    const last = Math.min(transcriptLines, offset + visibleLines);
    const position = `${first}-${last}/${transcriptLines}`;
    const follow = this.followMode
      ? this.theme.fg("success", "● follow")
      : this.theme.fg("dim", "○ paused");
    const actions = `${bindingLabel("s")} · ${bindingLabel("F")}`;
    const hints = `←/→ agent · j/k scroll · g/G top/end · ${actions} · esc editor · ctrl+alt+w hide`;
    return this.theme.fg("dim", truncateToWidth(`${position} ${follow} · ${hints}`, width));
  }

  private renderActionControls(width: number, height: number): string[] {
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

  private handleSteerTemplateInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "browse";
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.steerOption = Math.max(0, this.steerOption - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.steerOption = Math.min(STEER_OPTIONS.length - 1, this.steerOption + 1);
      return;
    }
    if (!matchesKey(data, Key.enter)) return;

    const message = STEER_OPTIONS[this.steerOption];
    if (!message) return;
    if (message === "Custom message...") {
      this.mode = "steer";
      return;
    }
    this.submitMessage("steer", message);
  }

  private submitMessage(kind: "steer" | "follow_up", value: string): void {
    const launches = this.syncLaunches();
    const selected = launches.find((launch) => launch.key === this.selectedKey);
    this.mode = "browse";
    this.steerInput.setValue("");
    this.followUpInput.setValue("");
    if (!selected || !value.trim()) return;

    if (kind === "steer") this.options.onSteer?.(selected, value.trim());
    else this.options.onFollowUp?.(selected, value.trim());
    this.queuedNotice = `Queued ${kind === "steer" ? "steer" : "follow-up"} for ${selected.taskId}`;
  }

  private renderSettled(width: number, height: number): string[] {
    const lines = [this.theme.fg("success", truncateToWidth("✓ Agents settled", width))];
    if (this.settledNotice && height > 1) {
      lines.push(this.theme.fg("dim", truncateToWidth(this.settledNotice, width)));
    }
    if (height > lines.length) {
      lines.push(this.theme.fg("dim", truncateToWidth("esc editor", width)));
    }
    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }

  private selectOffset(launches: readonly LivePaneLaunch[], offset: -1 | 1): void {
    if (launches.length < 2) return;
    const selected = launches.findIndex((launch) => launch.key === this.selectedKey);
    const next = (Math.max(0, selected) + offset + launches.length) % launches.length;
    const launch = launches[next];
    if (!launch || launch.key === this.selectedKey) return;
    this.selectedKey = launch.key;
    this.followMode = true;
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.settledNotice = undefined;
    this.queuedNotice = undefined;
    this.mode = "browse";
    this.options.requestRender();
  }

  private syncLaunches(): readonly LivePaneLaunch[] {
    const launches = this.options.getLaunches();
    for (const launch of launches) {
      if (!this.launchOrder.includes(launch.key)) this.launchOrder.push(launch.key);
    }
    if (!this.selectedKey) {
      this.selectedKey = launches[0]?.key;
      if (this.selectedKey) this.settledNotice = undefined;
    }

    if (this.selectedKey && !launches.some((launch) => launch.key === this.selectedKey)) {
      const settled = this.previousLaunches.get(this.selectedKey);
      const settledIndex = this.launchOrder.indexOf(this.selectedKey);
      const liveKeys = new Set(launches.map((launch) => launch.key));
      const following = [
        ...this.launchOrder.slice(settledIndex + 1),
        ...this.launchOrder.slice(0, Math.max(0, settledIndex)),
      ].find((key) => liveKeys.has(key));
      this.selectedKey = following ?? launches[0]?.key;
      const next = launches.find((launch) => launch.key === this.selectedKey);
      this.settledNotice = settled
        ? `✓ ${settled.taskId} settled${next ? ` · following ${next.taskId}` : ""}`
        : undefined;
      this.followMode = true;
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.queuedNotice = undefined;
      this.mode = "browse";
    }

    this.previousLaunches = new Map(launches.map((launch) => [launch.key, launch]));
    return launches;
  }
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
    this.steerInput.onSubmit = (value) => this.submitSteer(value);
    this.steerInput.onEscape = () => {
      this.mode = "browse";
    };
    this.followUpInput.onSubmit = (value) => this.submitFollowUp(value);
    this.followUpInput.onEscape = () => {
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
      const current = FILTERS.indexOf(this.filter);
      this.filter = FILTERS[(current + 1) % FILTERS.length] ?? "all";
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

export interface EvidenceSection {
  title: string;
  lines: string[];
}

export interface EvidenceExtras {
  phaseLabel: string;
  lastActivity?: string;
  pausedDrive?: Board["pausedDrive"];
  decision?: Board["activeDecision"];
}

const EVIDENCE_SECTION_LINE_BUDGET = 12;

/**
 * Pure projection from a task's persisted evidence (plus caller-supplied live/board extras)
 * into fixed, ordered, budgeted sections for the evidence view. Never invents data — a section
 * with nothing to show is omitted entirely.
 */
export function projectEvidenceSections(
  task: Task,
  selectedLaunch: DashboardLaunch | undefined,
  extras: EvidenceExtras
): EvidenceSection[] {
  const attempt = selectedLaunch?.attempt ?? task.attempts.at(-1);
  const latestReview = selectedLaunch ? selectedLaunch.review : attempt?.reviewLaunches?.at(-1);

  const contract: string[] = [`Prompt source: ${singleLine(task.brief).slice(0, 500)}`];
  if (task.supersedes) contract.push(`Lineage: supersedes ${task.supersedes}`);
  if (task.successCriteria?.length) {
    contract.push(
      `Success criteria: ${task.successCriteria.map(singleLine).join(" | ").slice(0, 800)}`
    );
  }

  const review: string[] = [];
  if (latestReview) {
    review.push(
      `Reviewer: ${latestReview.role ?? "reviewer"} · ${latestReview.verdict ?? latestReview.failureReason?.kind ?? "pending"} · model ${latestReview.model ?? "unknown"} · provider ${latestReview.provider ?? "unknown"}`,
      `Review usage: ${latestReview.usage.turns} turns · $${latestReview.usage.cost.toFixed(4)} · ${latestReview.usage.input} input · ${latestReview.usage.output} output`
    );
    if (latestReview.finalReport) {
      review.push(`Review result: ${singleLine(latestReview.finalReport).slice(0, 1_000)}`);
    }
    for (const entry of latestReview.criterionEvidence ?? []) {
      review.push(
        `Criterion evidence: ${entry.criterion} ${entry.passed ? "PASS" : "FAIL"} ${singleLine(entry.evidence).slice(0, 500)}`
      );
    }
  } else if (attempt?.reviewUsage) {
    review.push(
      `Legacy review: model ${attempt.reviewModel ?? "unknown"} · provider ${attempt.reviewProvider ?? "unknown"} · ${attempt.reviewUsage.turns} turns · $${attempt.reviewUsage.cost.toFixed(4)}`
    );
  }
  if (attempt?.reviewConvergence) {
    review.push(
      `Convergence: ${attempt.reviewConvergence.policy} · ${attempt.reviewConvergence.status} · ${attempt.reviewConvergence.actualApprovals}/${attempt.reviewConvergence.requiredApprovals} approvals · ${singleLine(attempt.reviewConvergence.summary).slice(0, 500)}`
    );
  }
  for (const finding of task.findings ?? []) {
    review.push(
      `Finding: ${finding.status} ${finding.fingerprint}: ${singleLine(finding.message).slice(0, 500)}`
    );
  }

  const execution: string[] = [];
  if (attempt) {
    const executionUsage = executorUsage(attempt);
    execution.push(
      `Executor identity: model ${attempt.model ?? "unknown"} · provider ${attempt.provider ?? "unknown"}`,
      `Executor usage: ${executionUsage.turns} turns · $${executionUsage.cost.toFixed(4)} · ${executionUsage.input} input · ${executionUsage.output} output`
    );
    if (attempt.finalReport) {
      execution.push(`Final result: ${singleLine(attempt.finalReport).slice(0, 1_000)}`);
    }
  }
  if (extras.pausedDrive) {
    execution.push(
      `Paused drive: owner ${extras.pausedDrive.ownerSession ?? "unknown"} · scope ${extras.pausedDrive.taskIds?.join(", ") ?? "all"}`
    );
  }
  if (extras.decision?.taskIds.includes(task.id)) {
    execution.push(
      `Decision: ${extras.decision.id} · ${extras.decision.kind} · owner ${extras.decision.ownerSession ?? "unknown"} · ${singleLine(extras.decision.evidence).slice(0, 500)}`
    );
  }
  if (extras.lastActivity) execution.push(`Recent activity: ${extras.lastActivity.slice(0, 800)}`);

  const artifact: string[] = [];
  if (task.provenance?.candidateTree)
    artifact.push(`Candidate tree: ${task.provenance.candidateTree}`);
  if (task.approvedProvenance) {
    artifact.push(
      `Completion fingerprint: ${task.approvedProvenance.fingerprint.slice(0, 12)} · ${task.approvedProvenance.artifact.kind} ${task.approvedProvenance.artifact.identity.slice(0, 12)}`
    );
  } else if (task.status === "approved") {
    artifact.push("Completion fingerprint: legacy proof unavailable · retry or create a successor");
  }
  if (task.provenance?.integratedTree)
    artifact.push(`Integrated tree: ${task.provenance.integratedTree}`);
  const integratedCommit = task.provenance?.integratedCommit ?? task.integratedCommit;
  if (integratedCommit) artifact.push(`Integration commit: ${integratedCommit}`);
  if (task.verificationProfile || task.verificationSummary || task.provenance?.verifiedAt) {
    artifact.push(
      `Verification: ${task.provenance?.verifiedAt ? "passed" : "pending"} · profile ${task.provenance?.verificationProfile ?? task.verificationProfile ?? "none"} · ${singleLine(task.verificationSummary ?? "no summary")}`
    );
  }

  const recovery: string[] = [];
  if (attempt) {
    recovery.push(
      `Recovery refs: worktree ${attempt.worktreePath ?? "none"} · branch ${attempt.branch ?? "none"} · log ${attempt.logFile} · session ${attempt.sessionFile ?? "none"}`
    );
    if (attempt.failureReason) {
      recovery.push(
        `Failure: ${attempt.failureReason.kind} · ${singleLine(attempt.failureReason.message)} · ${attempt.failureReason.retryable ? "retryable" : "not retryable"}`
      );
    }
  }
  if (task.dispatchClaim || task.dispatchNote) {
    recovery.push(
      `Dispatch: ${task.dispatchClaim?.kind ?? "none"} ${task.dispatchClaim?.id ?? ""} · ${singleLine(task.dispatchNote ?? "no note")}`
    );
  }

  const accounting: string[] = [];
  if (
    attempt &&
    (attempt.promptCharacters !== undefined || attempt.promptApproximateTokens !== undefined)
  ) {
    accounting.push(
      `Executor prompt: ${attempt.promptCharacters ?? 0} chars · ~${attempt.promptApproximateTokens ?? 0} tokens${formatPromptSections(attempt.promptSections)}`
    );
  }
  if (attempt && attempt.touchedFiles.length > 0) {
    accounting.push(`Changed files: ${attempt.touchedFiles.join(", ").slice(0, 800)}`);
  }
  if (
    latestReview &&
    (latestReview.promptCharacters !== undefined ||
      latestReview.promptApproximateTokens !== undefined)
  ) {
    accounting.push(
      `Review prompt: ${latestReview.promptCharacters ?? 0} chars · ~${latestReview.promptApproximateTokens ?? 0} tokens${formatPromptSections(latestReview.promptSections)}`
    );
  }

  return [
    { title: "Contract", lines: contract },
    { title: "Review", lines: review },
    { title: "Execution", lines: execution },
    { title: "Artifact & verification", lines: artifact },
    { title: "Recovery", lines: recovery },
    { title: "Accounting", lines: accounting },
  ]
    .filter((section) => section.lines.length > 0)
    .map(applyEvidenceSectionBudget);
}

function applyEvidenceSectionBudget(section: EvidenceSection): EvidenceSection {
  if (section.lines.length <= EVIDENCE_SECTION_LINE_BUDGET) return section;
  const hidden = section.lines.length - EVIDENCE_SECTION_LINE_BUDGET;
  return {
    title: section.title,
    lines: [
      ...section.lines.slice(0, EVIDENCE_SECTION_LINE_BUDGET),
      `… (+${hidden} more — open session for full detail)`,
    ],
  };
}

function bindingLabel(key: (typeof DASHBOARD_BINDINGS)[number]["key"]): string {
  const binding = DASHBOARD_BINDINGS.find((candidate) => candidate.key === key);
  return binding ? `${binding.key} ${binding.description}` : key;
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

function relativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "recently";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  return w >= width ? truncateToWidth(line, width) : line + " ".repeat(width - w);
}

export function wrapText(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, width);
}
