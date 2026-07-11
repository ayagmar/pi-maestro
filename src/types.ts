export type TaskStatus =
  | "todo"
  | "running"
  | "ready_for_review"
  | "changes_requested"
  | "approved"
  | "failed"
  | "cancelled";

export interface Usage {
  input: number;
  output: number;
  cost: number;
  turns: number;
}

export interface Attempt {
  index: number;
  /** Session file in pi's default session storage, reported by the executor via get_state. */
  sessionFile?: string;
  /** Legacy (pre-0.2): custom per-attempt session dir inside the project. */
  sessionDir?: string;
  logFile: string;
  model?: string;
  thinking: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  usage: Usage;
  finalReport?: string;
  /** Full report of the last review run against this attempt. */
  reviewReport?: string;
  /** Session file of the last review run, for post-hoc inspection. */
  reviewSessionFile?: string;
  touchedFiles: string[];
}

export interface Task {
  id: string;
  title: string;
  brief: string;
  tier: string;
  status: TaskStatus;
  dependsOn: string[];
  reviewNotes?: string;
  attempts: Attempt[];
  createdAt: number;
  updatedAt: number;
}

export interface Board {
  version: 1;
  revision?: number;
  nextTaskNumber: number;
  /** Goal from /maestro start; lets a fresh orchestrator take over via /maestro handoff. */
  goal?: string;
  /** Sessions that own this board (started/adopted the run). Other sessions in the same repo don't render its status. */
  ownerSessions?: string[];
  tasks: Task[];
}

export interface TierConfig {
  /** Model pattern like "openai/gpt-5-mini". Omit to inherit pi's default model. */
  model?: string;
  /** Thinking level: off, minimal, low, medium, high, xhigh. */
  thinking: string;
  /** Comma-separated tool allowlist passed to the executor. Omit for all tools. */
  tools?: string;
}

export interface MaestroConfig {
  maxParallel: number;
  /** Hard attempt cap per task; exceeded tasks need an explicit maestro-run or a brief rewrite. */
  maxAttempts: number;
  /** Abort an executor once its attempt cost (USD) exceeds this. 0 disables the cap. */
  maxCostPerTask: number;
  /** Named tiers. "review" is used for adversarial review runs. */
  tiers: Record<string, TierConfig>;
}
