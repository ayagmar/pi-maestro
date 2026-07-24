import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { type UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  buildSessionContext,
  getMarkdownTheme,
  type SessionEntry,
  SessionManager,
  type SessionMessageEntry,
  sessionEntryToContextMessages,
  type Theme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  bindingLabel,
  DEFAULT_DASHBOARD_BODY_HEIGHT,
  REFRESH_MS,
  STEER_OPTIONS,
  steerTemplateLines,
} from "./dashboard-controls.js";
import { type TranscriptItem, TranscriptTail } from "./transcript.js";

function wrapText(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, width);
}

/** Shared transcript projection used by the dashboard and agent-session viewer. */
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
  sessionFile?: string;
  model?: string;
  provider?: string;
  turns: number;
  cost: number;
  lastActivity: string;
  live?: boolean;
}

export interface LivePaneOptions {
  getLaunches(): readonly LivePaneLaunch[];
  requestRender(): void;
  onEscape(): void;
  onCycleVisibility(): void;
  onSteer?(launch: LivePaneLaunch, message: string): void;
  onFollowUp?(launch: LivePaneLaunch, message: string): void;
  canOpenSession?(launch: LivePaneLaunch): boolean;
  onOpenSession?(launch: LivePaneLaunch): void;
  height?: number;
  getHeight?: () => number;
  tui?: TUI;
  cwd?: string;
}

interface SessionFileStat {
  size: number;
  device: number;
  inode: number;
}

type SessionTranscript = {
  sessionFile: string;
  fileSize: number;
  device: number;
  inode: number;
  previousTail: Buffer;
  decoder: StringDecoder;
  lineBuffer: string;
  entries: SessionEntry[];
  entriesById: Map<string, SessionEntry>;
  leafId: string | null;
  container: Container | undefined;
  pendingTools: Map<string, ToolExecutionComponent>;
  cachedWidth: number | undefined;
  cachedLines: string[] | undefined;
};

type LivePaneStatus = "thinking" | "streaming" | "tool" | "done";
type LivePaneMode = "browse" | "steer_templates" | "steer" | "follow_up";

const OSC133_PROMPT_MARKERS = ["\x1b]133;A\x07", "\x1b]133;B\x07", "\x1b]133;C\x07"] as const;

function stripPromptMarkers(lines: string[]): string[] {
  return lines.map((line) => {
    for (const marker of OSC133_PROMPT_MARKERS) line = line.replaceAll(marker, "");
    return line;
  });
}

const SESSION_TAIL_BYTES = 4_096;

function readSessionBytes(file: string, offset: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const bytes = Buffer.alloc(length);
  const descriptor = openSync(file, "r");
  try {
    const read = readSync(descriptor, bytes, 0, length, offset);
    return bytes.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

function readSessionTail(file: string, size: number): Buffer {
  const length = Math.min(size, SESSION_TAIL_BYTES);
  return readSessionBytes(file, size - length, length);
}

const LIVE_PANE_STATUS: Record<
  LivePaneStatus,
  { glyph: string; color: "warning" | "success" | "accent" }
> = {
  thinking: { glyph: "◐", color: "warning" },
  streaming: { glyph: "●", color: "success" },
  tool: { glyph: "◑", color: "accent" },
  done: { glyph: "✓", color: "success" },
};

/** Bounded Pi-style browser for live and recorded executor/reviewer sessions. */
export class LivePaneComponent {
  private _focused = false;
  private selectedKey: string | undefined;
  private readonly launchOrder: string[] = [];
  private previousLaunches = new Map<string, LivePaneLaunch>();
  private readonly tails = new Map<string, TranscriptTail>();
  private readonly sessionTranscripts = new Map<string, SessionTranscript>();
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
      this.syncInputFocus();
    };
    this.followUpInput.onSubmit = (value) => this.submitMessage("follow_up", value);
    this.followUpInput.onEscape = () => {
      this.mode = "browse";
      this.syncInputFocus();
    };
    this.timer = setInterval(() => options.requestRender(), REFRESH_MS);
    this.timer.unref();
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
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {
    for (const transcript of this.sessionTranscripts.values()) {
      transcript.container?.invalidate();
      transcript.cachedWidth = undefined;
      transcript.cachedLines = undefined;
    }
  }

  handleInput(data: string): void {
    try {
      this.routeInput(data);
    } finally {
      this.syncInputFocus();
    }
  }

  private routeInput(data: string): void {
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
    const selected = launches.find((launch) => launch.key === this.selectedKey);
    if (
      matchesKey(data, Key.enter) &&
      selected?.live === false &&
      selected.sessionFile &&
      this.options.onOpenSession &&
      (this.options.canOpenSession?.(selected) ?? true)
    ) {
      this.options.onOpenSession(selected);
      return;
    }
    if (
      data === "s" &&
      this.options.onSteer &&
      launches.some((launch) => launch.key === this.selectedKey && launch.live !== false)
    ) {
      this.steerOption = 0;
      this.mode = "steer_templates";
      this.options.requestRender();
      return;
    }
    if (
      data === "F" &&
      this.options.onFollowUp &&
      launches.some((launch) => launch.key === this.selectedKey && launch.live !== false)
    ) {
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
    const framed = safeWidth >= 4 && height >= 3;
    const contentWidth = framed ? safeWidth - 2 : safeWidth;
    const contentHeight = framed ? height - 2 : height;
    const launches = this.syncLaunches();
    this.syncInputFocus();
    const selected = launches.find((launch) => launch.key === this.selectedKey);
    if (!selected) {
      const settled = this.renderSettled(contentWidth, contentHeight);
      return framed ? this.frameSession(settled, safeWidth, height) : settled;
    }

    const tail = this.tailFor(selected);
    tail.poll();
    const transcript =
      this.renderSessionTranscript(selected, contentWidth) ??
      styledTranscriptLines(this.theme, tail.items, contentWidth);
    if (transcript.length === 0) {
      transcript.push(
        this.theme.fg("muted", truncateToWidth("Waiting for agent output…", contentWidth))
      );
    }

    const header = this.renderHeader(selected, tail.items, contentWidth);
    const footerRows = contentHeight >= 3 ? 1 : 0;
    const stripRows = launches.length > 1 && contentHeight >= 4 ? 1 : 0;
    const noticeRows = this.settledNotice && contentHeight >= 5 ? 1 : 0;
    const fixedRows = 1 + footerRows + stripRows + noticeRows;
    const actionLines = this.renderActionControls(
      contentWidth,
      Math.max(0, contentHeight - fixedRows)
    );
    const bodyHeight = Math.max(0, contentHeight - fixedRows - actionLines.length);
    const maxScroll = Math.max(0, transcript.length - bodyHeight);
    const requestedOffset = this.followMode ? Number.MAX_SAFE_INTEGER : this.scrollOffset;
    this.renderedScrollOffset = Math.min(requestedOffset, maxScroll);
    const body = transcript.slice(
      this.renderedScrollOffset,
      this.renderedScrollOffset + bodyHeight
    );

    const lines = [
      header,
      ...(stripRows ? [this.renderLaunchStrip(launches, contentWidth)] : []),
      ...(noticeRows
        ? [this.theme.fg("success", truncateToWidth(this.settledNotice ?? "", contentWidth))]
        : []),
      ...body,
      ...actionLines,
      ...(footerRows
        ? [
            this.renderFooter(
              transcript.length,
              bodyHeight,
              this.renderedScrollOffset,
              contentWidth,
              selected
            ),
          ]
        : []),
    ];
    const content = lines
      .slice(0, contentHeight)
      .map((line) => truncateToWidth(line, contentWidth));
    return framed ? this.frameSession(content, safeWidth, height) : content;
  }

  private frameSession(lines: string[], width: number, height: number): string[] {
    const innerWidth = width - 2;
    const title = truncateToWidth(" Maestro agent sessions ", innerWidth);
    const top =
      this.theme.fg("border", "╭") +
      this.theme.fg("accent", title) +
      this.theme.fg("border", `${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}╮`);
    const framed = lines.slice(0, height - 2).map((line) => {
      const content = truncateToWidth(line, innerWidth);
      return (
        this.theme.fg("border", "│") +
        content +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(content))) +
        this.theme.fg("border", "│")
      );
    });
    while (framed.length < height - 2) {
      framed.push(
        this.theme.fg("border", "│") + " ".repeat(innerWidth) + this.theme.fg("border", "│")
      );
    }
    return [top, ...framed, this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`)];
  }

  private renderSessionTranscript(launch: LivePaneLaunch, width: number): string[] | undefined {
    const sessionFile = launch.sessionFile;
    const tui = this.options.tui;
    const cwd = this.options.cwd;
    if (!sessionFile || !tui || !cwd) return undefined;

    let transcript = this.sessionTranscripts.get(launch.key);
    if (!transcript || transcript.sessionFile !== sessionFile) {
      transcript = this.emptySessionTranscript(sessionFile);
      this.sessionTranscripts.set(launch.key, transcript);
    }

    let file: SessionFileStat;
    try {
      const stats = statSync(sessionFile);
      file = { size: Number(stats.size), device: Number(stats.dev), inode: Number(stats.ino) };
    } catch {
      this.resetSessionTranscript(transcript);
      return undefined;
    }

    const replaced =
      transcript.fileSize >= 0 &&
      (file.device !== transcript.device ||
        file.inode !== transcript.inode ||
        file.size < transcript.fileSize ||
        !this.sessionTailMatches(transcript));
    if (transcript.fileSize < 0 || replaced) {
      if (!this.rebuildSessionTranscript(transcript, tui, cwd, file)) return undefined;
    } else if (file.size > transcript.fileSize) {
      if (!this.appendSessionTranscript(transcript, tui, cwd, file)) return undefined;
    }

    if (!transcript.container) return undefined;
    if (transcript.cachedLines && transcript.cachedWidth === width) {
      return transcript.cachedLines;
    }

    transcript.cachedLines = stripPromptMarkers(transcript.container.render(width));
    transcript.cachedWidth = width;
    return transcript.cachedLines;
  }

  private emptySessionTranscript(sessionFile: string): SessionTranscript {
    return {
      sessionFile,
      fileSize: -1,
      device: -1,
      inode: -1,
      previousTail: Buffer.alloc(0),
      decoder: new StringDecoder("utf8"),
      lineBuffer: "",
      entries: [],
      entriesById: new Map(),
      leafId: null,
      container: undefined,
      pendingTools: new Map(),
      cachedWidth: undefined,
      cachedLines: undefined,
    };
  }

  private resetSessionTranscript(transcript: SessionTranscript): void {
    transcript.fileSize = -1;
    transcript.device = -1;
    transcript.inode = -1;
    transcript.previousTail = Buffer.alloc(0);
    transcript.decoder = new StringDecoder("utf8");
    transcript.lineBuffer = "";
    transcript.entries = [];
    transcript.entriesById = new Map();
    transcript.leafId = null;
    transcript.container = undefined;
    transcript.pendingTools = new Map();
    transcript.cachedWidth = undefined;
    transcript.cachedLines = undefined;
  }

  private sessionTailMatches(transcript: SessionTranscript): boolean {
    if (transcript.previousTail.length === 0) return true;
    try {
      const offset = transcript.fileSize - transcript.previousTail.length;
      const current = readSessionBytes(
        transcript.sessionFile,
        offset,
        transcript.previousTail.length
      );
      return current.equals(transcript.previousTail);
    } catch {
      return false;
    }
  }

  private rebuildSessionTranscript(
    transcript: SessionTranscript,
    tui: TUI,
    cwd: string,
    file: SessionFileStat
  ): boolean {
    try {
      const session = SessionManager.open(transcript.sessionFile);
      transcript.entries = [...session.getEntries()];
      transcript.entriesById = new Map(transcript.entries.map((entry) => [entry.id, entry]));
      transcript.leafId = session.getLeafId();
      const rendered = this.buildSessionTranscript(
        session.buildSessionContext().messages,
        tui,
        cwd
      );
      transcript.container = rendered.container;
      transcript.pendingTools = rendered.pendingTools;
      transcript.fileSize = file.size;
      transcript.device = file.device;
      transcript.inode = file.inode;
      transcript.previousTail = readSessionTail(transcript.sessionFile, file.size);
      transcript.decoder = new StringDecoder("utf8");
      transcript.lineBuffer = "";
      transcript.cachedWidth = undefined;
      transcript.cachedLines = undefined;
      return true;
    } catch {
      this.resetSessionTranscript(transcript);
      return false;
    }
  }

  private appendSessionTranscript(
    transcript: SessionTranscript,
    tui: TUI,
    cwd: string,
    file: SessionFileStat
  ): boolean {
    try {
      const bytes = readSessionBytes(
        transcript.sessionFile,
        transcript.fileSize,
        file.size - transcript.fileSize
      );
      transcript.lineBuffer += transcript.decoder.write(bytes);
      const lines = transcript.lineBuffer.split("\n");
      transcript.lineBuffer = lines.pop() ?? "";
      const entries: SessionEntry[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as SessionEntry;
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.id !== "string" ||
          (entry.parentId !== null && typeof entry.parentId !== "string")
        ) {
          throw new Error("invalid appended session entry");
        }
        entries.push(entry);
      }

      let rebuildProjection = false;
      for (const entry of entries) {
        if (entry.parentId !== transcript.leafId) rebuildProjection = true;
        if (entry.type === "compaction" || entry.type === "branch_summary") {
          rebuildProjection = true;
        }
        transcript.entries.push(entry);
        transcript.entriesById.set(entry.id, entry);
        transcript.leafId = entry.id;
      }

      if (rebuildProjection) {
        const context = buildSessionContext(
          transcript.entries,
          transcript.leafId,
          transcript.entriesById
        );
        const rendered = this.buildSessionTranscript(context.messages, tui, cwd);
        transcript.container = rendered.container;
        transcript.pendingTools = rendered.pendingTools;
      } else if (transcript.container) {
        for (const entry of entries) {
          for (const message of sessionEntryToContextMessages(entry)) {
            this.appendSessionMessage(
              transcript.container,
              transcript.pendingTools,
              message,
              tui,
              cwd
            );
          }
        }
      }

      transcript.fileSize = file.size;
      transcript.device = file.device;
      transcript.inode = file.inode;
      transcript.previousTail = readSessionTail(transcript.sessionFile, file.size);
      transcript.cachedWidth = undefined;
      transcript.cachedLines = undefined;
      return true;
    } catch {
      return this.rebuildSessionTranscript(transcript, tui, cwd, file);
    }
  }

  private buildSessionTranscript(
    messages: SessionMessageEntry["message"][],
    tui: TUI,
    cwd: string
  ): { container: Container; pendingTools: Map<string, ToolExecutionComponent> } {
    const container = new Container();
    const pendingTools = new Map<string, ToolExecutionComponent>();
    for (const message of messages) {
      this.appendSessionMessage(container, pendingTools, message, tui, cwd);
    }
    return { container, pendingTools };
  }

  private appendSessionMessage(
    container: Container,
    pendingTools: Map<string, ToolExecutionComponent>,
    message: SessionMessageEntry["message"],
    tui: TUI,
    cwd: string
  ): void {
    if (message.role === "user") {
      const text = this.userMessageText(message);
      if (text) container.addChild(new UserMessageComponent(text, getMarkdownTheme()));
      return;
    }
    if (message.role === "assistant") {
      container.addChild(new AssistantMessageComponent(message, true, getMarkdownTheme()));
      for (const content of message.content) {
        if (content.type !== "toolCall") continue;
        const component = new ToolExecutionComponent(
          content.name,
          content.id,
          content.arguments,
          {},
          undefined,
          tui,
          cwd
        );
        container.addChild(component);
        if (message.stopReason === "aborted" || message.stopReason === "error") {
          component.updateResult({
            content: [
              {
                type: "text",
                text:
                  message.errorMessage ??
                  (message.stopReason === "aborted" ? "Operation aborted" : "Error"),
              },
            ],
            isError: true,
          });
        } else {
          pendingTools.set(content.id, component);
        }
      }
      return;
    }
    if (message.role !== "toolResult") return;
    const component = pendingTools.get(message.toolCallId);
    if (!component) return;
    component.updateResult(message);
    pendingTools.delete(message.toolCallId);
  }

  private userMessageText(message: UserMessage): string {
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
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
    const title = `${launch.taskId} · ${launch.title} [${identity}]`;
    const status = this.launchStatus(launch, items);
    const details = LIVE_PANE_STATUS[status];
    const statusText = `${details.glyph} ${status}`;
    const availableTitle = Math.max(1, width - visibleWidth(statusText) - 1);
    return truncateToWidth(
      `${this.theme.fg("accent", truncateToWidth(title, availableTitle))} ${this.theme.fg(details.color, statusText)}`,
      width
    );
  }

  private launchStatus(launch: LivePaneLaunch, items: readonly TranscriptItem[]): LivePaneStatus {
    if (launch.live === false) return "done";
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
    const capacity = Math.max(1, Math.floor(width / 18));
    const start = Math.min(
      Math.max(0, selectedIndex - Math.floor(capacity / 2)),
      Math.max(0, launches.length - capacity)
    );
    const visible = launches.slice(start, start + capacity).map((launch) => {
      const selected = launch.key === this.selectedKey;
      const marker = selected ? "▶" : "·";
      const label = `${marker} ${launch.taskId} ${launch.kind === "execute" ? "run" : "review"}`;
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
    width: number,
    selected: LivePaneLaunch
  ): string {
    const first = transcriptLines === 0 ? 0 : offset + 1;
    const last = Math.min(transcriptLines, offset + visibleLines);
    const position = `${first}-${last}/${transcriptLines}`;
    const follow = this.followMode
      ? this.theme.fg("success", "● follow")
      : this.theme.fg("dim", "○ paused");
    const actions = selected.live !== false ? ` · ${bindingLabel("s")} · ${bindingLabel("F")}` : "";
    const open =
      selected.live === false && selected.sessionFile
        ? this.options.onOpenSession
          ? (this.options.canOpenSession?.(selected) ?? true)
            ? " · enter open in Pi"
            : " · open after drive settles"
          : " · /maestro agents to open in Pi"
        : "";
    const hints = `←/→ session · j/k scroll · g/G top/end${actions}${open} · esc close`;
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
    const appeared: LivePaneLaunch[] = [];
    for (const launch of launches) {
      if (this.launchOrder.includes(launch.key)) continue;
      this.launchOrder.push(launch.key);
      appeared.push(launch);
    }
    if (!this.selectedKey) {
      this.selectedKey =
        launches.find((launch) => launch.live !== false)?.key ?? launches.at(-1)?.key;
      if (this.selectedKey) this.settledNotice = undefined;
    }

    // While following, a newly launched agent is the interesting one. Without
    // this the pane stays pinned to a settled launch and looks frozen for the
    // whole next executor/reviewer run.
    const selectedIsLive = launches.some(
      (launch) => launch.key === this.selectedKey && launch.live !== false
    );
    if (this.followMode && this.mode === "browse" && !selectedIsLive) {
      const newLive = appeared.find((launch) => launch.live !== false);
      if (newLive && newLive.key !== this.selectedKey) {
        this.selectedKey = newLive.key;
        this.scrollOffset = Number.MAX_SAFE_INTEGER;
        this.settledNotice = `▸ following ${newLive.taskId} · ${newLive.kind === "review" ? "review" : "execute"}`;
        this.queuedNotice = undefined;
      }
    }

    const previousSelected = this.selectedKey
      ? this.previousLaunches.get(this.selectedKey)
      : undefined;
    const currentSelected = launches.find((launch) => launch.key === this.selectedKey);
    const nextLive = launches.find((launch) => launch.live && launch.key !== this.selectedKey);
    if (previousSelected?.live && currentSelected?.live === false && nextLive) {
      this.selectedKey = nextLive.key;
      this.settledNotice = `✓ ${previousSelected.taskId} settled · following ${nextLive.taskId}`;
      this.followMode = true;
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.queuedNotice = undefined;
      this.mode = "browse";
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
