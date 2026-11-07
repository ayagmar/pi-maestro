import { type Static } from "@earendil-works/pi-schema";
import {
  type activeDriveSchema,
  type approvedProvenanceSchema,
  type artifactProvenanceSchema,
  type attemptSchema,
  type boardSchema,
  type configFileSchema,
  type dispatchClaimSchema,
  type driveDecisionSchema,
  type driveWaitSchema,
  type failureKindSchema,
  type failureReasonSchema,
  type pausedDriveReasonSchema,
  type pausedDriveSchema,
  type recipeInputSchema,
  type recipeInputValueSchema,
  type recipeTaskSchema,
  type reviewConvergenceSchema,
  type reviewEscalationPolicySchema,
  type reviewFindingSchema,
  type reviewLaunchSchema,
  type reviewPolicySchema,
  type taskSchema,
  type taskStatusSchema,
  type tierConfigSchema,
  type usageSchema,
  type verificationProfileSchema,
  type workflowRecipeSchema,
} from "./schemas.js";

/** Persisted shapes derive from schemas.ts, so a type and its validator cannot drift. */
export type TaskStatus = Static<typeof taskStatusSchema>;
export type Usage = Static<typeof usageSchema>;
export type FailureKind = Static<typeof failureKindSchema>;
export type FailureReason = Static<typeof failureReasonSchema>;
export type ReviewLaunch = Static<typeof reviewLaunchSchema>;
export type ReviewConvergence = Static<typeof reviewConvergenceSchema>;
export type Attempt = Static<typeof attemptSchema>;
export type DispatchClaim = Static<typeof dispatchClaimSchema>;
export type ReviewFinding = Static<typeof reviewFindingSchema>;
export type ArtifactProvenance = Static<typeof artifactProvenanceSchema>;
export type ApprovedProvenance = Static<typeof approvedProvenanceSchema>;
export type Task = Static<typeof taskSchema>;
export type PausedDriveReason = Static<typeof pausedDriveReasonSchema>;
export type PausedDriveState = Static<typeof pausedDriveSchema>;
export type DriveDecision = Static<typeof driveDecisionSchema>;
export type DriveWait = Static<typeof driveWaitSchema>;
export type ActiveDriveState = Static<typeof activeDriveSchema>;
export type Board = Static<typeof boardSchema>;
export type TierConfig = Static<typeof tierConfigSchema>;
export type VerificationProfile = Static<typeof verificationProfileSchema>;
export type RecipeInputValue = Static<typeof recipeInputValueSchema>;
export type RecipeInput = Static<typeof recipeInputSchema>;
export type RecipeTask = Static<typeof recipeTaskSchema>;
export type ReviewPolicy = Static<typeof reviewPolicySchema>;
export type WorkflowRecipe = Static<typeof workflowRecipeSchema>;

export type TaskKind = "implementation" | "investigation";

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
  /** Ids that exist on the board, so a rejection can name what was actually available. */
  knownTaskIds?: string[];
  /** Each cycle repeats its first task ID at the end, for example T1 → T2 → T1. */
  dependencyCycles: string[][];
  invalidTiers: Array<{ taskId: string; tier: string }>;
  writePathOverlaps?: Array<{
    leftTaskId: string;
    rightTaskId: string;
    path: string;
    /** The other claimant's matching path when it differs (globs overlap unequal paths). */
    counterpartPath?: string;
    /** Claimant statuses, so the message can suggest superseding stopped work. */
    leftStatus?: TaskStatus;
    rightStatus?: TaskStatus;
  }>;
  /** Total overlaps found when the retained examples are capped. */
  writePathOverlapCount?: number;
  contractErrors?: Array<{ taskId: string; message: string }>;
}

export interface PlanTaskEdits {
  title?: string;
  brief?: string;
  kind?: TaskKind;
  tier?: string;
  dependsOn?: string[];
  writePaths?: string[];
  commitMessage?: string;
  reviewGuidance?: string;
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

export type RecipeScope = "user" | "project";

/**
 * When the review cost ladder leaves the cheap first-pass model behind.
 *
 * - "off": every reviewer runs on the review tier (the pre-ladder behaviour).
 * - "doubt": escalate only when a cheap verdict is unusable or not an approval.
 * - "risk": the default; "doubt" plus any change under a money or
 *   migration/schema path, where a cheap clean approval is worth the least.
 * - "always": the first reviewer of an attempt is cheap, every later one is
 *   premium (a paid panel after the cheap gate agrees).
 */
export type ReviewEscalationPolicy = Static<typeof reviewEscalationPolicySchema>;

export interface ResolvedRecipe {
  recipe: WorkflowRecipe;
  scope: RecipeScope;
  file: string;
}

type ConfigFile = Static<typeof configFileSchema>;

/** A resolved config: a config file whose core settings always have a value. */
export type MaestroConfig = ConfigFile &
  Required<
    Pick<
      ConfigFile,
      | "maxParallel"
      | "planGate"
      | "livePanes"
      | "useWorktrees"
      | "maxAttempts"
      | "maxPlanTasks"
      | "maxDiscoveryGeneratedTasks"
      | "maxTotalLaunchesPerRun"
      | "confirmationPlanTasks"
      | "confirmationTotalLaunches"
      | "reviewPolicy"
      | "reviewRequiredApprovals"
      | "maxReviewerLaunches"
      | "maxCostPerTask"
      | "maxRunCost"
      | "statusWaitSeconds"
      | "autoCommit"
      | "tiers"
    >
  >;
