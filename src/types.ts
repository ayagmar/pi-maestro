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
  | "stalled"
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
  id?: string;
  reviewerIndex?: number;
  role?: "single" | "confirmer" | "finder" | "refuter";
  verdict?: "approve" | "request_changes";
  criterionEvidence?: Array<{ criterion: number; passed: boolean; evidence: string }>;
  model?: string;
  provider?: string;
  sessionFile?: string;
  /** Executor event log for this reviewer launch, when retained. */
  logFile?: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  errorMessage?: string;
  failureReason?: FailureReason;
  usage: Usage;
  finalReport?: string;
  promptCharacters?: number;
  promptApproximateTokens?: number;
  promptSections?: Array<{ name: string; characters: number; omitted: boolean }>;
}

export interface ReviewConvergence {
  policy: ReviewPolicy;
  status: "approved" | "changes_requested" | "disagreement" | "operational_failure";
  requiredApprovals: number;
  actualApprovals: number;
  reviewerCount: number;
  summary: string;
  decidedAt: number;
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
  /** Configured task/dependency fingerprint captured when execution was claimed. */
  executionFingerprint?: string;
  /** Whether this raw executor launch consumes maxAttempts. Defaults to true for legacy boards. */
  consumesAttempt?: boolean;
  /** @deprecated Legacy marker for a non-consuming provider launch. */
  providerFailure?: boolean;
  usage: Usage;
  finalReport?: string;
  /** Compact deterministic accounting for the executor prompt. */
  promptCharacters?: number;
  promptApproximateTokens?: number;
  promptSections?: Array<{ name: string; characters: number; omitted: boolean }>;
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
  reviewConvergence?: ReviewConvergence;
  /** Superseded convergence decisions retained across explicit human review retries. */
  reviewConvergenceHistory?: ReviewConvergence[];
  /** Aggregate review usage, also included in the attempt's aggregate usage. */
  reviewUsage?: Usage;
  /** Session file of the last review run, for post-hoc inspection. */
  reviewSessionFile?: string;
  touchedFiles: string[];
}

export interface DispatchClaim {
  id: string;
  kind: "execute" | "review";
  claimedAt: number;
  /** Deadline after which crash recovery may atomically reclaim the dispatch. */
  expiresAt?: number;
}

export interface ReviewFinding {
  fingerprint: string;
  message: string;
  status: "open" | "verified";
  firstAttempt: number;
  lastAttempt: number;
}

export interface ArtifactProvenance {
  candidateTree: string;
  capturedAt: number;
  reviewedAt?: number;
  integratedCommit?: string;
  integratedTree?: string;
  verifiedAt?: number;
  verificationProfile?: string;
}

export interface ApprovedProvenance {
  version: 1;
  fingerprint: string;
  componentHashes: {
    contract: string;
    execution: string;
    verification: string;
    dependencies: string;
  };
  artifact: { kind: "git-tree" | "report"; identity: string };
  dependencyIdentities: Array<{
    taskId: string;
    kind: "git-tree" | "report";
    identity: string;
  }>;
  approvedAt: number;
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
  /** Declared repository-relative write scope. Optional only for legacy boards. */
  writePaths?: string[];
  /** Explicit bounded outcomes required for newly planned executable tasks. */
  successCriteria?: string[];
  /** Trusted configured verification profile selected for this task. */
  verificationProfile?: string;
  reviewPolicy?: ReviewPolicy;
  /** Read-only task that may propose ordinary tasks within these repository scopes. */
  discovery?: {
    allowedWritePaths: string[];
  };
  findings?: ReviewFinding[];
  reviewNotes?: string;
  /** Provenance for acceptance; automated approval is recorded only after integration. */
  approvalKind?: "reviewed" | "manual";
  /** Legacy bounded-diff hash. Loadable for migration, but never authoritative. */
  reviewedPatchHash?: string;
  integratedCommit?: string;
  verificationSummary?: string;
  provenance?: ArtifactProvenance;
  /** Versioned proof used to decide whether an approved completion is still reusable. */
  approvedProvenance?: ApprovedProvenance;
  /** Consecutive genuine reviewer rejections; the autonomous drive escalates at the limit. */
  reviewRejections?: number;
  /** Exclusive persisted ownership of an executor or reviewer dispatch. */
  dispatchClaim?: DispatchClaim;
  /** Bounded diagnostic recorded when dispatch recovery skips unsafe state. */
  dispatchNote?: string;
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
  writePathOverlaps?: Array<{ leftTaskId: string; rightTaskId: string; path: string }>;
  contractErrors?: Array<{ taskId: string; message: string }>;
}

export interface PlanTaskEdits {
  title?: string;
  brief?: string;
  tier?: string;
  dependsOn?: string[];
  writePaths?: string[];
  successCriteria?: string[];
  verificationProfile?: string;
  reviewPolicy?: ReviewPolicy;
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

export interface DriveDecision {
  id: string;
  ownerSession?: string;
  kind: string;
  taskIds: string[];
  evidence: string;
  allowedInterventions: Array<"handoff" | "abort" | "steer">;
  createdAt: number;
  deliveredAt?: number;
  deliveryClaim?: {
    id: string;
    claimedAt: number;
  };
  resolution?: { intervention: "handoff" | "abort" | "steer" | "resume"; resolvedAt: number };
}

export interface ActiveDriveState {
  id: string;
  /** Session that started the drive. Only that session may receive its terminal notification. */
  ownerSession?: string;
  /** Selected task scope. Omitted when the whole board is driven. */
  taskIds?: string[];
  startedAt: number;
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
  scaleApproval?: { signature: string; confirmedAt: number };
  /** A safely paused autonomous drive that can be resumed from fresh board state. */
  pausedDrive?: PausedDriveState;
  /** Current bounded drive completion or decision awaiting owner handling. */
  activeDecision?: DriveDecision;
  /** Durable ownership record for a drive that has claimed it started. */
  activeDrive?: ActiveDriveState;
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

export interface VerificationProfile {
  command: string;
  timeoutSeconds: number;
}

export type RecipeScope = "user" | "project";

export type RecipeInputValue = string | number | boolean;

export interface RecipeInput {
  description?: string;
  required?: boolean;
  default?: RecipeInputValue;
}

export interface RecipeTask {
  id: string;
  title: string;
  brief: string;
  tier: string;
  dependsOn: string[];
  writePaths: string[];
  successCriteria: string[];
  verificationProfile?: string;
  commitMessage?: string;
  discovery?: {
    allowedWritePaths: string[];
  };
  reviewPolicy?: ReviewPolicy;
}

export type ReviewPolicy = "single" | "confirm" | "find-and-refute";

export interface WorkflowRecipe {
  kind: "pi-maestro-recipe";
  version: 1;
  name: string;
  description?: string;
  inputs?: Record<string, RecipeInput>;
  tasks: RecipeTask[];
}

export interface ResolvedRecipe {
  recipe: WorkflowRecipe;
  scope: RecipeScope;
  file: string;
}

export interface MaestroConfig {
  maxParallel: number;
  /** Require explicit user approval after planning before executors can start. */
  planGate: boolean;
  /** Isolate tasks in per-task git worktrees when a batch dispatches in parallel. */
  useWorktrees: boolean;
  /** Hard attempt cap per task; exceeded tasks need an explicit maestro-run or a brief rewrite. */
  maxAttempts: number;
  maxPlanTasks: number;
  maxDiscoveryGeneratedTasks: number;
  maxTotalLaunchesPerRun: number;
  confirmationPlanTasks: number;
  confirmationTotalLaunches: number;
  /** Independent approvals required by the confirm review policy. */
  reviewRequiredApprovals: number;
  /** Raw reviewer process cap, including provider fallbacks. */
  maxReviewerLaunches: number;
  /** Abort an executor once its attempt cost (USD) exceeds this. 0 disables the cap. */
  maxCostPerTask: number;
  /** Stop starting executor batches once total board cost (USD) exceeds this. 0 disables the cap. */
  maxRunCost: number;
  /** How long the human status command waits (seconds) for running executors before returning progress. 0 disables waiting. */
  statusWaitSeconds: number;
  /** Event detail mirrored to per-run JSONL logs. */
  logEvents?: "compact" | "full";
  /** Maximum bytes mirrored per run. 0 disables the limit. */
  maxLogBytesPerRun?: number;
  /** Seconds without any executor event before watchdog steering. */
  watchdogIdleSeconds?: number;
  /** Turns without meaningful progress before one automatic steer. */
  watchdogWarningTurns?: number;
  /** Additional no-progress turns after steering before the attempt is stalled. */
  watchdogTerminationTurns?: number;
  /** Context usage ratio that queues a safe supervisor handoff; 0 disables it. */
  handoffContextRatio?: number;
  /** Clear completed tasks from the live board after every selected task is approved. */
  cleanupCompletedTasks?: boolean;
  /** Commit each task's work on approval (one conventional commit per task). */
  autoCommit: boolean;
  /** Trusted user/project commands; model task text is never executed. */
  verificationProfiles?: Record<string, VerificationProfile>;
  defaultVerificationProfile?: string;
  /** Named tiers. "review" is used for adversarial review runs. */
  tiers: Record<string, TierConfig>;
}
