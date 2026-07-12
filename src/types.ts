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

export type FailureKind =
  | "provider_failure"
  | "executor_failure"
  | "reviewer_rejection"
  | "reviewer_failure"
  | "user_abort"
  | "cost_cap";

export interface FailureReason {
  kind: FailureKind;
  message: string;
  retryable: boolean;
}

export interface ReviewLaunch {
  model?: string;
  provider?: string;
  sessionFile?: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  errorMessage?: string;
  failureReason?: FailureReason;
  usage: Usage;
  finalReport?: string;
}

export interface Attempt {
  index: number;
  /** Session file in pi's default session storage, reported by the executor via get_state. */
  sessionFile?: string;
  /** Legacy (pre-0.2): custom per-attempt session dir inside the project. */
  sessionDir?: string;
  logFile: string;
  model?: string;
  /** Provider parsed from the resolved model id, when available. */
  provider?: string;
  thinking: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  /** Provider or executor error that ended this attempt. */
  errorMessage?: string;
  /** Structured, redacted reason for the last failure or review rejection. */
  failureReason?: FailureReason;
  /** Whether this raw executor launch consumes maxAttempts. Defaults to true for legacy boards. */
  consumesAttempt?: boolean;
  /** @deprecated Legacy marker for a non-consuming provider launch. */
  providerFailure?: boolean;
  usage: Usage;
  finalReport?: string;
  /** Bounded git diff captured after this executor completed successfully. */
  diff?: string;
  /** Isolated checkout used by this executor and its reviewer. */
  worktreePath?: string;
  /** Git branch checked out in worktreePath. */
  branch?: string;
  /** Full report of the last review run against this attempt. */
  reviewReport?: string;
  /** Reviewer findings retained on this attempt after later retries. */
  reviewNotes?: string;
  /** Model and provider used by the reviewer. */
  reviewModel?: string;
  reviewProvider?: string;
  /** Every reviewer launch, including failed fallback models. */
  reviewLaunches?: ReviewLaunch[];
  /** Aggregate review usage, also included in the attempt's aggregate usage. */
  reviewUsage?: Usage;
  /** Session file of the last review run, for post-hoc inspection. */
  reviewSessionFile?: string;
  touchedFiles: string[];
}

export interface Task {
  id: string;
  title: string;
  brief: string;
  /** Conventional commit message used when auto-committing this task's approved work. */
  commitMessage?: string;
  tier: string;
  status: TaskStatus;
  dependsOn: string[];
  reviewNotes?: string;
  /** Consecutive genuine reviewer rejections; the autonomous drive escalates at the limit. */
  reviewRejections?: number;
  attempts: Attempt[];
  createdAt: number;
  updatedAt: number;
}

export type TaskGroup =
  | "blocked"
  | "ready"
  | "running"
  | "review-needed"
  | "approved"
  | "failed"
  | "cancelled";

export interface MissingDependency {
  taskId: string;
  dependencyId: string;
}

export interface PlanValidation {
  missingDependencies: MissingDependency[];
  /** Each cycle repeats its first task ID at the end, for example T1 → T2 → T1. */
  dependencyCycles: string[][];
  invalidTiers: Array<{ taskId: string; tier: string }>;
}

export interface PlanTaskEdits {
  title?: string;
  brief?: string;
  tier?: string;
  dependsOn?: string[];
  cancelled?: boolean;
}

export interface BoardUsageSummary {
  totalAttempts: number;
  totalCost: number;
  /** Average of non-zero attempt costs. */
  averageMeaningfulCost: number;
  models: string[];
  providers: string[];
}

export interface PausedDriveState {
  /** Selected task scope. Omitted when the whole board is driven. */
  taskIds?: string[];
  /** Session that started the drive. Only that session may control or resume it. */
  ownerSession?: string;
}

export interface Board {
  version: 1;
  revision?: number;
  nextTaskNumber: number;
  /** Goal from /maestro start; lets a fresh orchestrator take over via /maestro handoff. */
  goal?: string;
  /** Sessions that own this board (started/adopted the run). Other sessions in the same repo don't render its status. */
  ownerSessions?: string[];
  /** Planned tasks cannot start until the user approves them. */
  planPending?: boolean;
  /** A safely paused autonomous drive that can be resumed from fresh board state. */
  pausedDrive?: PausedDriveState;
  tasks: Task[];
}

export interface TierConfig {
  /** Model pattern like "openai/gpt-5-mini". Omit to inherit pi's default model. */
  model?: string;
  /** Ordered model patterns tried when the primary has a provider failure. */
  fallbacks?: string[];
  /** Thinking level: off, minimal, low, medium, high, xhigh. */
  thinking: string;
  /** Comma-separated tool allowlist passed to the executor. Omit for all tools. */
  tools?: string;
}

export interface MaestroConfig {
  maxParallel: number;
  /** Require explicit user approval after planning before executors can start. */
  planGate: boolean;
  /** Isolate tasks in per-task git worktrees when a batch dispatches in parallel. */
  useWorktrees: boolean;
  /** Hard attempt cap per task; exceeded tasks need an explicit maestro-run or a brief rewrite. */
  maxAttempts: number;
  /** Abort an executor once its attempt cost (USD) exceeds this. 0 disables the cap. */
  maxCostPerTask: number;
  /** Stop starting executor batches once total board cost (USD) exceeds this. 0 disables the cap. */
  maxRunCost: number;
  /** How long batch tools and maestro_status wait (seconds) for running executors before returning progress. 0 disables waiting. */
  statusWaitSeconds: number;
  /** Commit each task's work on approval (one conventional commit per task). */
  autoCommit: boolean;
  /** Named tiers. "review" is used for adversarial review runs. */
  tiers: Record<string, TierConfig>;
}
