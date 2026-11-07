import {
  arr,
  bool,
  compile,
  int,
  lit,
  map,
  num,
  obj,
  oneOf,
  opt,
  type Properties,
  type Schema,
  str,
  union,
  unknown,
  type Validator,
} from "@earendil-works/pi-schema";
import {
  MAX_DECISION_EVIDENCE_CHARS,
  MAX_DRIVE_TASK_IDS,
  MAX_DRIVE_WAIT_REASON_CHARS,
  THINKING_LEVELS,
} from "./constants.js";

/**
 * Every persisted format, described once. Types in types.ts derive from these
 * schemas. Only shapes live here: rules that compare fields, walk the task
 * graph, or depend on configuration stay with the code that owns them.
 *
 * Boards and plan exports come from other builds, so their objects are open:
 * fields this build does not know are ignored. Config files, recipes and
 * discovery output are authored input, so their unknown fields are errors,
 * except inside tier and verification profile entries, which have always
 * tolerated them.
 */

/** `num()` alone accepts Infinity, which JSON.parse produces from `1e999`, and NaN. */
const finite = num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });

const formats: Record<string, (value: string) => boolean> = {
  "non-blank": (value) => value.trim() !== "",
};

/**
 * A string of at most `maximum` UTF-16 code units, the unit of `String.length`
 * that producers truncate to. `maxLength` counts code points, so it would let
 * text full of emoji reach twice the bound.
 */
function text(maximum: number, options: { minLength?: number } = {}) {
  const format = `at-most-${maximum}-characters`;
  formats[format] = (value) => value.length <= maximum;
  return str({ ...options, format });
}

function nonBlank(maximum: number) {
  const format = `non-blank-at-most-${maximum}-characters`;
  formats[format] = (value) => value.trim() !== "" && value.length <= maximum;
  return str({ format });
}

function between(minimum: number, maximum: number) {
  return num({ minimum, maximum });
}

function wholeBetween(minimum: number, maximum: number) {
  return int({ minimum, maximum });
}

/** An object that ignores fields it does not name. */
function record<const P extends Properties>(properties: P) {
  return obj(properties, { open: true });
}

/** A record whose keys are constrained too, which `map()` has no option for. */
function keyed<T>(
  value: Schema<T>,
  keywords: { propertyNames: Schema<string>; maxProperties?: number }
): Schema<Record<string, T>> {
  return { ...map(value), ...keywords } as Schema<Record<string, T>>;
}

/**
 * Typed but deliberately not validated. The load path has never checked this
 * field, so a board holding any value in it has to keep loading; readers treat
 * it as untrusted.
 */
function unchecked<T>(): Schema<T> {
  return unknown() as Schema<T>;
}

const digest = str({ pattern: "^[a-f0-9]{64}$" });
const gitObjectId = str({ pattern: "^[a-f0-9]{40}$|^[a-f0-9]{64}$" });
const driveTaskIds = arr(str(), { maxItems: MAX_DRIVE_TASK_IDS });

export const taskStatusSchema = oneOf([
  "todo",
  "running",
  "ready_for_review",
  "changes_requested",
  "approved",
  "failed",
  "cancelled",
]);

export const reviewPolicySchema = oneOf(["single", "confirm", "find-and-refute"]);

export const usageSchema = record({
  input: finite,
  output: finite,
  cost: finite,
  turns: finite,
});

export const failureKindSchema = oneOf([
  "provider_failure",
  "stalled",
  "executor_failure",
  "reviewer_rejection",
  "reviewer_failure",
  "user_abort",
  "cost_cap",
]);

export const failureReasonSchema = record({
  kind: failureKindSchema,
  message: str(),
  retryable: bool(),
});

const promptSectionsSchema = arr(record({ name: str(), characters: finite, omitted: bool() }));

export const reviewLaunchSchema = record({
  id: opt(str()),
  reviewerIndex: opt(int({ minimum: 1 })),
  role: opt(oneOf(["single", "confirmer", "finder", "refuter"])),
  verdict: opt(oneOf(["approve", "request_changes"])),
  /**
   * Which side of the review cost ladder this launch actually ran on:
   * "economy" is the cheap first pass (reviewCheapModel), "premium" the review
   * tier — including a cheap first pass that fell back to a review-tier model
   * after its own provider failed.
   */
  costTier: opt(oneOf(["economy", "premium"])),
  /** Why this launch ran on the review tier instead of the cheap first pass. */
  escalationReason: opt(str()),
  criterionEvidence: opt(
    arr(record({ criterion: int({ minimum: 1 }), passed: bool(), evidence: text(500) }))
  ),
  /** Git tree of the candidate this reviewer judged. */
  candidateTree: opt(unchecked<string>()),
  /** Task fingerprint (contract, execution, verification, dependencies) this reviewer judged. */
  taskFingerprint: opt(unchecked<string>()),
  model: opt(str()),
  provider: opt(str()),
  sessionFile: opt(str()),
  /** Executor event log for this reviewer launch, when retained. */
  logFile: opt(str()),
  startedAt: finite,
  endedAt: opt(finite),
  exitCode: opt(finite),
  errorMessage: opt(str()),
  failureReason: opt(failureReasonSchema),
  usage: usageSchema,
  finalReport: opt(str()),
  promptCharacters: opt(finite),
  promptApproximateTokens: opt(finite),
  promptSections: opt(promptSectionsSchema),
});

export const reviewConvergenceSchema = record({
  policy: reviewPolicySchema,
  status: oneOf(["approved", "changes_requested", "disagreement", "operational_failure"]),
  requiredApprovals: int(),
  actualApprovals: int(),
  reviewerCount: int(),
  summary: text(2_000),
  decidedAt: finite,
  /** What settled it, when it was not the reviewers' judgment: pre-review gates (fingerprint, artifact, verification). */
  cause: opt(unchecked<"gate">()),
});

const componentHashesSchema = record({
  contract: digest,
  execution: digest,
  verification: digest,
  dependencies: digest,
});

export const attemptSchema = record({
  index: finite,
  /** Nested Pi session file reported by the executor via get_state. */
  sessionFile: opt(str()),
  /** Pi session directory for this raw launch; also supports legacy per-attempt directories. */
  sessionDir: opt(str()),
  logFile: str(),
  model: opt(str()),
  /** Provider parsed from the resolved model id, when available. */
  provider: opt(str()),
  /** This attempt continued the rejected predecessor's session instead of starting fresh. */
  resumed: opt(unchecked<boolean>()),
  /** Opt-in detached RPC transport metadata used for PID-safe startup recovery. */
  detached: opt(bool()),
  pid: opt(int()),
  processStartId: opt(str()),
  /** Unique per raw detached launch; its terminal record must carry the same id. */
  transportId: opt(str()),
  controlFile: opt(str()),
  exitFile: opt(str()),
  stderrFile: opt(str()),
  thinking: str(),
  startedAt: finite,
  endedAt: opt(finite),
  exitCode: opt(finite),
  /** Provider or executor error that ended this attempt. */
  errorMessage: opt(str()),
  /** Structured, redacted reason for the last failure or review rejection. */
  failureReason: opt(failureReasonSchema),
  /** Configured task/dependency fingerprint captured when execution was claimed. */
  executionFingerprint: opt(digest),
  /** Per-component fingerprint hashes captured alongside executionFingerprint, used to name which contract component went stale. */
  executionComponentHashes: opt(componentHashesSchema),
  /** Whether this raw executor launch consumes maxAttempts. Defaults to true for legacy boards. */
  consumesAttempt: opt(bool()),
  /** @deprecated Legacy marker for a non-consuming provider launch. */
  providerFailure: opt(bool()),
  usage: usageSchema,
  finalReport: opt(str()),
  /** Compact deterministic accounting for the executor prompt. */
  promptCharacters: opt(finite),
  promptApproximateTokens: opt(finite),
  promptSections: opt(promptSectionsSchema),
  /** Bounded git diff captured after this executor completed successfully. */
  diff: opt(str()),
  /** Isolated checkout used by this executor and its reviewer. */
  worktreePath: opt(str()),
  /** Git branch checked out in worktreePath. */
  branch: opt(str()),
  /** Full report of the last review run against this attempt. */
  reviewReport: opt(str()),
  /** Reviewer findings retained on this attempt after later retries. */
  reviewNotes: opt(str()),
  /** Model and provider used by the reviewer. */
  reviewModel: opt(str()),
  reviewProvider: opt(str()),
  /** Every reviewer launch, including failed fallback models. */
  reviewLaunches: opt(arr(reviewLaunchSchema)),
  reviewConvergence: opt(reviewConvergenceSchema),
  /** Superseded convergence decisions retained across explicit human review retries. */
  reviewConvergenceHistory: opt(arr(reviewConvergenceSchema)),
  /** Aggregate review usage, also included in the attempt's aggregate usage. */
  reviewUsage: opt(usageSchema),
  /** Session file of the last review run, for post-hoc inspection. */
  reviewSessionFile: opt(str()),
  touchedFiles: arr(str()),
});

export const dispatchClaimSchema = record({
  id: str(),
  kind: oneOf(["execute", "review"]),
  claimedAt: finite,
  /** Deadline after which crash recovery may atomically reclaim the dispatch. */
  expiresAt: opt(finite),
  /** Owning pi process; another session never reclaims a claim whose owner is still alive. */
  ownerPid: opt(unchecked<number>()),
  /** Kernel start identity of `ownerPid`, so a recycled PID does not keep the claim alive. */
  ownerStart: opt(unchecked<string>()),
});

export const reviewFindingSchema = record({
  fingerprint: str(),
  message: str(),
  status: oneOf(["open", "verified"]),
  firstAttempt: finite,
  lastAttempt: finite,
});

export const artifactProvenanceSchema = record({
  candidateTree: str(),
  capturedAt: finite,
  reviewedAt: opt(finite),
  integratedCommit: opt(str()),
  integratedTree: opt(str()),
  verifiedAt: opt(finite),
  verificationProfile: opt(str()),
});

const provenanceTaskId = text(64, { minLength: 1 });

export const approvedProvenanceSchema = record({
  /**
   * Record format. Kept at 1 on purpose: validators in Maestro builds that
   * are still running in other pi sessions reject any other value and
   * quarantine the whole board (a real board was quarantined 34 seconds
   * after an upgrade this way). Shape changes go in `executionShape`, which
   * old validators ignore as an unknown key.
   */
  version: lit(1),
  /**
   * How the `execution` component was hashed. Absent: the tier's
   * model/thinking/tools were included (legacy). 2: only the tier name,
   * review policy, and confirm count — which model produced or reviewed the
   * artifact is provenance, not identity.
   */
  executionShape: opt(lit(2)),
  fingerprint: digest,
  componentHashes: componentHashesSchema,
  artifact: union([
    record({ kind: lit("git-tree"), identity: gitObjectId }),
    record({ kind: lit("report"), identity: digest }),
  ]),
  dependencyIdentities: arr(
    union([
      record({ taskId: provenanceTaskId, kind: lit("git-tree"), identity: gitObjectId }),
      record({ taskId: provenanceTaskId, kind: lit("report"), identity: digest }),
    ]),
    { maxItems: 512 }
  ),
  approvedAt: finite,
});

export const taskSchema = record({
  id: str(),
  title: str(),
  brief: str(),
  /** Explicit no-file investigation marker; absent means implementation work. */
  kind: opt(lit("investigation")),
  /** Conventional commit message used when auto-committing this task's approved work. */
  commitMessage: opt(str()),
  /** Orchestrator hint injected into review prompts: what to verify and where to focus. */
  reviewGuidance: opt(str()),
  /** Successor task that replaced this task. */
  supersededBy: opt(str()),
  /** Predecessor task that this task replaced. */
  supersedes: opt(str()),
  tier: str(),
  status: taskStatusSchema,
  dependsOn: arr(str()),
  /** Declared repository-relative write scope. Optional only for legacy boards. */
  writePaths: opt(arr(str())),
  /** Explicit bounded outcomes required for newly planned executable tasks. */
  successCriteria: opt(arr(str())),
  /** Trusted configured verification profile selected for this task. */
  verificationProfile: opt(str()),
  reviewPolicy: opt(reviewPolicySchema),
  /** Read-only task that may propose ordinary tasks within these repository scopes. */
  discovery: opt(record({ allowedWritePaths: arr(str(), { minItems: 1, maxItems: 64 }) })),
  findings: opt(arr(reviewFindingSchema)),
  reviewNotes: opt(str()),
  /** Provenance for acceptance; automated approval is recorded only after integration. */
  approvalKind: opt(oneOf(["reviewed", "manual"])),
  /** Legacy bounded-diff hash. Loadable for migration, but never authoritative. */
  reviewedPatchHash: opt(str()),
  integratedCommit: opt(str()),
  verificationSummary: opt(str()),
  provenance: opt(artifactProvenanceSchema),
  /** Versioned proof used to decide whether an approved completion is still reusable. */
  approvedProvenance: opt(approvedProvenanceSchema),
  /** Consecutive genuine reviewer rejections. */
  reviewRejections: opt(finite),
  /**
   * Consecutive rejections that repeated a finding from an earlier attempt.
   * The autonomous drive escalates on these rather than on rejection count,
   * so a task raising only new findings is allowed to keep converging.
   */
  reviewStagnantRejections: opt(finite),
  /** Exclusive persisted ownership of an executor or reviewer dispatch. */
  dispatchClaim: opt(dispatchClaimSchema),
  /** Bounded diagnostic recorded when dispatch recovery skips unsafe state. */
  dispatchNote: opt(str()),
  attempts: arr(attemptSchema),
  createdAt: finite,
  updatedAt: finite,
});

export const pausedDriveReasonSchema = oneOf(["paused", "provider_blocked", "escalation_required"]);

export const pausedDriveSchema = record({
  /** Selected task scope. Omitted when the whole board is driven. */
  taskIds: opt(driveTaskIds),
  /** Session that started the drive. */
  ownerSession: opt(str()),
  /**
   * Why the drive stopped. Only a deliberate `paused` keeps the owner-session
   * guard: the operator who paused decides when to continue. Mechanical stops
   * (provider outage, escalation already settled) carry self-contained
   * evidence and any session may resume them — the owning session is often
   * closed by the time quota returns.
   */
  reason: opt(pausedDriveReasonSchema),
});

export const driveDecisionSchema = record({
  id: str(),
  ownerSession: opt(str()),
  kind: str(),
  taskIds: driveTaskIds,
  // Room for truncateCharacters' "… (N more characters)" marker.
  evidence: text(MAX_DECISION_EVIDENCE_CHARS + 64),
  allowedInterventions: arr(oneOf(["handoff", "abort", "steer"])),
  /**
   * The orchestrator has corrected the board and the only remaining step is
   * a human-only control (workflow scale confirmation via /maestro drive).
   * While set, reminder nudges stay quiet: nagging the orchestrator about a
   * step it cannot take made a real supervisor "resolve" the decision with a
   * handoff just to silence the reminders.
   */
  awaitingHuman: opt(
    record({ kind: lit("scale_confirmation"), since: finite, signature: opt(str()) })
  ),
  createdAt: finite,
  deliveredAt: opt(finite),
  deliveryClaim: opt(record({ id: str(), claimedAt: finite })),
  resolution: opt(
    record({ intervention: oneOf(["handoff", "abort", "steer", "resume"]), resolvedAt: finite })
  ),
});

export const driveWaitSchema = record({
  /** Epoch milliseconds when the drive resumes launching. */
  until: finite,
  /** Why it sleeps, e.g. "openai-codex 5h window exhausted". */
  reason: text(MAX_DRIVE_WAIT_REASON_CHARS),
  /** Tasks whose launches are deferred by this wait. */
  taskIds: driveTaskIds,
});

export const activeDriveSchema = record({
  id: str(),
  /** Session that started the drive. Only that session may receive its terminal notification. */
  ownerSession: opt(str()),
  /** Selected task scope. Omitted when the whole board is driven. */
  taskIds: opt(driveTaskIds),
  startedAt: finite,
  /**
   * Present while the drive deliberately sleeps (provider quota, transient
   * retry). With no live executor and a failed task on the board, every
   * projection otherwise reads "blocked · recovery" for hours while the
   * drive is in fact healthy and merely waiting — an operator watching a
   * real board could not tell the two apart.
   */
  waiting: opt(driveWaitSchema),
});

export const boardSchema = record({
  version: lit(1),
  revision: opt(finite),
  nextTaskNumber: finite,
  /** Goal from /maestro start; lets a fresh orchestrator take over via /maestro handoff. */
  goal: opt(str()),
  /** Sessions that own this board (started/adopted the run). Other sessions in the same repo don't render its status. */
  ownerSessions: opt(arr(str())),
  /** Planned tasks cannot start until the user approves them. */
  planPending: opt(bool()),
  scaleApproval: opt(record({ signature: str(), confirmedAt: finite })),
  /** A safely paused autonomous drive that can be resumed from fresh board state. */
  pausedDrive: opt(pausedDriveSchema),
  /** Current bounded drive completion or decision awaiting owner handling. */
  activeDecision: opt(driveDecisionSchema),
  /** Durable ownership record for a drive that has claimed it started. */
  activeDrive: opt(activeDriveSchema),
  tasks: arr(taskSchema),
});

export const tierConfigSchema = record({
  /** Model pattern like "openai/gpt-5-mini". Omit to inherit pi's default model. */
  model: opt(str()),
  /** Ordered model patterns tried when the primary has a provider failure. */
  fallbacks: opt(arr(str())),
  /** Thinking level: off, minimal, low, medium, high, xhigh, max. Passed through to pi as text. */
  thinking: oneOf(THINKING_LEVELS) as Schema<string>,
  /** Comma-separated tool allowlist passed to the executor. Omit for all tools. */
  tools: opt(str()),
  /** Per-tier override for seconds without executor events before watchdog steering. */
  watchdogIdleSeconds: opt(between(0, 86_400)),
  /** Per-tier override for turns without meaningful progress before watchdog steering. */
  watchdogWarningTurns: opt(between(0, 10_000)),
  /** Per-tier override for additional no-progress turns before termination. */
  watchdogTerminationTurns: opt(between(0, 10_000)),
});

export const verificationProfileSchema = record({
  command: text(1_000, { minLength: 1 }),
  timeoutSeconds: num({ exclusiveMinimum: 0, maximum: 3_600 }),
});

export const reviewEscalationPolicySchema = oneOf(["off", "doubt", "risk", "always"]);

/** A config file: every field optional, unknown fields rejected. */
export const configFileSchema = obj({
  maxParallel: opt(wholeBetween(1, 64)),
  /** Require explicit user approval after planning before executors can start. */
  planGate: opt(bool()),
  /** Automatically open the passive live-session pane when agents launch. */
  livePanes: opt(bool()),
  /** Isolate tasks in per-task git worktrees when a batch dispatches in parallel. */
  useWorktrees: opt(bool()),
  /** Run executor RPC processes in an opt-in detached transport that survives supervisor exit. */
  detachedExecutors: opt(bool()),
  /** Hard attempt cap per task; exceeded tasks need an explicit maestro-run or a brief rewrite. */
  maxAttempts: opt(wholeBetween(1, 100)),
  maxPlanTasks: opt(wholeBetween(1, 512)),
  maxDiscoveryGeneratedTasks: opt(wholeBetween(1, 128)),
  maxTotalLaunchesPerRun: opt(wholeBetween(1, 4_096)),
  /**
   * Scheduling rounds (loop passes that launched something) one drive may
   * run before it stops with `round_limit`. A clean sequential task costs one
   * round; every rejection retry, quota-interrupted launch, or reviewer
   * re-run costs another, so an unattended overnight drive on a real board
   * could exhaust the old fixed 20 with work still runnable.
   */
  maxRoundsPerRun: opt(wholeBetween(1, 1_000)),
  confirmationPlanTasks: opt(wholeBetween(1, 512)),
  confirmationTotalLaunches: opt(wholeBetween(1, 4_096)),
  /** Review policy new tasks inherit when a plan does not state one. */
  reviewPolicy: opt(reviewPolicySchema),
  /** Independent approvals required by the confirm review policy. */
  reviewRequiredApprovals: opt(wholeBetween(2, 8)),
  /** Raw reviewer process cap, including provider fallbacks. */
  maxReviewerLaunches: opt(wholeBetween(1, 16)),
  /** Abort an executor once its attempt cost (USD) exceeds this. 0 disables the cap. */
  maxCostPerTask: opt(between(0, 1_000_000)),
  /** Abort one reviewer launch once its cost (USD) exceeds this. 0 inherits maxCostPerTask. */
  maxCostPerReview: opt(between(0, 1_000_000)),
  /**
   * Cheap first-pass reviewer model for the review cost ladder. Unset keeps
   * every reviewer on the review tier model.
   */
  reviewCheapModel: opt(str({ format: "non-blank" })),
  /** What escalates a reviewer from reviewCheapModel to the review tier model. */
  reviewEscalation: opt(reviewEscalationPolicySchema),
  /** Stop starting executor batches once active (non-cancelled) board cost (USD) exceeds this. 0 disables the cap. */
  maxRunCost: opt(between(0, 1_000_000)),
  /** Consecutive genuine reviewer rejections before a task escalates instead of retrying. */
  reviewRejectionLimit: opt(wholeBetween(1, 10)),
  /**
   * Context strategy for review-rejection retries. "resume" continues the
   * rejected attempt's own session (the model keeps everything it already
   * read, and providers bill the history at cached rates); "fresh" starts
   * every attempt with a clean context. Provider fallbacks, human retries,
   * and discovery tasks always start fresh.
   */
  retryContext: opt(oneOf(["resume", "fresh"])),
  /** How long the human status command waits (seconds) for running executors before returning progress. 0 disables waiting. */
  statusWaitSeconds: opt(between(0, 240)),
  /** Minutes a delivered decision may sit unresolved with no board activity before the owner session is re-nudged. 0 disables. */
  decisionNudgeMinutes: opt(between(0, 240)),
  /** Event detail mirrored to per-run JSONL logs. */
  logEvents: opt(oneOf(["compact", "full"])),
  /** Maximum bytes mirrored per run. 0 disables the limit. */
  maxLogBytesPerRun: opt(between(0, 1_000_000_000)),
  /**
   * Minutes a drive may wait for a provider whose quota or usage window is
   * exhausted before it stops with `provider_blocked`. Providers that publish
   * a reset clock (Codex) are waited for exactly; others are probed with
   * 2/4/8/15-minute backoff. 0 stops at the first quota failure. The default
   * covers a full 5-hour subscription window; a weekly limit stops the drive
   * with its reset time.
   */
  providerQuotaWaitMinutes: opt(between(0, 1_440)),
  /** Seconds without any executor event before watchdog steering. */
  watchdogIdleSeconds: opt(between(0, 86_400)),
  /** Turns without meaningful progress before one automatic steer. */
  watchdogWarningTurns: opt(between(0, 10_000)),
  /** Additional no-progress turns after steering before the attempt is stalled. */
  watchdogTerminationTurns: opt(between(0, 10_000)),
  /** Context usage ratio that queues a safe supervisor handoff; 0 disables it. */
  handoffContextRatio: opt(between(0, 1)),
  /** Clear completed tasks from the live board after every selected task is approved. */
  cleanupCompletedTasks: opt(bool()),
  /** Commit each task's work on approval (one conventional commit per task). */
  autoCommit: opt(bool()),
  /** Push the main branch after each approved integration (remote backup of landed work). */
  pushOnIntegration: opt(bool()),
  /** Trusted user/project commands; model task text is never executed. */
  verificationProfiles: opt(
    keyed(verificationProfileSchema, { propertyNames: nonBlank(64), maxProperties: 32 })
  ),
  defaultVerificationProfile: opt(str()),
  /** Named tiers. "review" is used for adversarial review runs. */
  tiers: opt(keyed(tierConfigSchema, { propertyNames: str({ format: "non-blank" }) })),
});

export const recipeInputValueSchema = union([str(), finite, bool()]);

export const recipeInputSchema = obj({
  description: opt(nonBlank(300)),
  required: opt(bool()),
  default: opt(recipeInputValueSchema),
});

/** Scope of a discovery task in authored files, where unknown fields are errors. */
const authoredDiscoverySchema = obj({ allowedWritePaths: arr(str(), { minItems: 1 }) });

export const recipeTaskSchema = obj({
  id: nonBlank(500),
  title: nonBlank(500),
  brief: nonBlank(20_000),
  kind: opt(lit("investigation")),
  tier: nonBlank(500),
  dependsOn: arr(str()),
  writePaths: arr(str()),
  successCriteria: arr(str()),
  verificationProfile: opt(nonBlank(64)),
  commitMessage: opt(nonBlank(500)),
  discovery: opt(authoredDiscoverySchema),
  reviewPolicy: opt(reviewPolicySchema),
});

export const RECIPE_INPUT_NAME = "^[A-Za-z][A-Za-z0-9_-]{0,63}$";
export const RECIPE_NAME = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

export const workflowRecipeSchema = obj({
  kind: lit("pi-maestro-recipe"),
  version: lit(1),
  name: str({ pattern: RECIPE_NAME }),
  description: opt(nonBlank(500)),
  inputs: opt(
    keyed(recipeInputSchema, {
      propertyNames: str({ pattern: RECIPE_INPUT_NAME }),
      maxProperties: 32,
    })
  ),
  tasks: arr(recipeTaskSchema, { minItems: 1, maxItems: 100 }),
});

/** Plan exports are open: an export from another build may carry fields this one ignores. */
export const exportedPlanTaskSchema = record({
  id: str(),
  title: str(),
  brief: str(),
  kind: opt(lit("investigation")),
  tier: str(),
  dependsOn: arr(str()),
  writePaths: arr(str()),
  successCriteria: arr(str()),
  verificationProfile: opt(str()),
  reviewPolicy: opt(reviewPolicySchema),
  commitMessage: opt(str()),
  reviewGuidance: opt(str()),
  cancelled: opt(bool()),
  discovery: opt(authoredDiscoverySchema),
});

export const exportedPlanSchema = record({
  kind: lit("pi-maestro-plan"),
  version: lit(1),
  tasks: arr(exportedPlanTaskSchema),
});

export const discoveryItemSchema = obj({
  key: str({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }),
  title: nonBlank(500),
  brief: nonBlank(20_000),
  tier: nonBlank(500),
  writePaths: arr(str()),
  successCriteria: arr(str()),
  dependsOn: arr(str()),
  verificationProfile: opt(nonBlank(64)),
  reviewPolicy: opt(reviewPolicySchema),
  commitMessage: opt(nonBlank(500)),
});

export const discoveryOutputSchema = obj({
  kind: lit("pi-maestro-discovery"),
  version: lit(1),
  items: arr(discoveryItemSchema, { minItems: 1 }),
});

function validator<T>(schema: Schema<T>): Validator<T> {
  return compile(schema, { formats });
}

export const boardValidator = validator(boardSchema);
export const configFileValidator = validator(configFileSchema);
export const workflowRecipeValidator = validator(workflowRecipeSchema);
export const recipeTaskValidator = validator(recipeTaskSchema);
export const recipeInputValueValidator = validator(recipeInputValueSchema);
export const exportedPlanValidator = validator(exportedPlanSchema);
export const discoveryOutputValidator = validator(discoveryOutputSchema);

/** The problems with an invalid value, each located by JSON Pointer. */
export function describeInvalid(validator: Validator<unknown>, value: unknown): string {
  const errors = validator.errors(value);
  const shown = errors
    .slice(0, 3)
    .map(({ path, message }) => `${path === "" ? "document" : path}: ${message}`);
  const hidden = errors.length - shown.length;
  return `${shown.join("; ")}${hidden > 0 ? ` (and ${hidden} more)` : ""}`;
}
