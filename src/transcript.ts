import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export interface TranscriptItem {
  kind: "text" | "tool" | "tool_error" | "status";
  text: string;
}

const MAX_ITEMS = 400;
const PREVIEW_LENGTH = 80;

export function toolPreview(
  name: string,
  args: Record<string, unknown> | null | undefined
): string {
  const clip = (text: string) =>
    text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;

  if (!args) return name;
  if (name === "bash" && typeof args.command === "string") {
    return `$ ${clip(args.command.replace(/\n/g, " "))}`;
  }
  const path = args.path ?? args.file_path;
  if (typeof path === "string") return `${name} ${clip(path)}`;
  return `${name} ${clip(JSON.stringify(args))}`;
}

interface LogEvent {
  type: string;
  toolName?: string;
  args?: Record<string, unknown> | null;
  isError?: boolean;
  message?: {
    role?: string;
    content?: { type: string; text?: string }[];
  };
}

/** Parse one JSONL event into transcript items. Exported for tests. */
export function parseLogLine(line: string): TranscriptItem[] {
  if (!line.trim()) return [];
  let event: LogEvent;
  try {
    event = JSON.parse(line) as LogEvent;
  } catch {
    return [];
  }

  if (event.type === "tool_execution_start" && event.toolName) {
    return [{ kind: "tool", text: toolPreview(event.toolName, event.args) }];
  }
  if (event.type === "tool_execution_end" && event.isError && event.toolName) {
    return [{ kind: "tool_error", text: `${event.toolName} failed` }];
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const items: TranscriptItem[] = [];
    for (const part of event.message.content ?? []) {
      if (part.type === "text" && part.text?.trim()) {
        items.push({ kind: "text", text: part.text.trim() });
      }
    }
    return items;
  }
  if (event.type === "agent_end") {
    return [{ kind: "status", text: "— agent finished —" }];
  }
  return [];
}

/**
 * Incrementally tails an executor JSONL event log and keeps a rolling
 * window of display items. poll() only reads bytes appended since the
 * last call, so refreshing at 2Hz stays cheap even for large logs.
 */
export class TranscriptTail {
  readonly items: TranscriptItem[] = [];
  private offset = 0;
  private buffer = "";

  constructor(readonly file: string) {}

  poll(): void {
    if (!existsSync(this.file)) return;
    const size = statSync(this.file).size;
    if (size < this.offset) {
      // File was truncated (rerun reusing the log path): start over.
      this.offset = 0;
      this.buffer = "";
      this.items.length = 0;
    }
    if (size <= this.offset) return;

    const fd = openSync(this.file, "r");
    try {
      const chunk = Buffer.alloc(size - this.offset);
      readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset = size;
      this.buffer += chunk.toString("utf-8");
    } finally {
      closeSync(fd);
    }

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.items.push(...parseLogLine(line));
    }
    if (this.items.length > MAX_ITEMS) {
      this.items.splice(0, this.items.length - MAX_ITEMS);
    }
  }
}
