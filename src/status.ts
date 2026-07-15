import { completionFreshness } from "./artifact-policy.js";
import { blockedReason, isTaskSettled, taskGroup } from "./board.js";
import { boardUsage } from "./format.js";
import { type Board, type MaestroConfig } from "./types.js";

export const RUN_PHASES = [
  "discovery",
  "plan_approval",
  "execution",
  "review",
  "integration",
  "verification",
  "recovery",
  "complete",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface PhaseProjection {
  id: RunPhase;
  label: string;
  taskIds: string[];
  current: boolean;
}

export type LiveTaskKinds = ReadonlyMap<string, "execute" | "review">;

const PHASE_LABELS: Record<RunPhase, string> = {
  discovery: "discovery",
  plan_approval: "plan approval",
  execution: "execution",
  review: "review",
  integration: "integration",
  verification: "verification",
  recovery: "recovery",
  complete: "complete",
};

export function projectRunPhases(
  board: Board,
  liveKinds: ReadonlyMap<string, "execute" | "review"> = new Map(),
  config?: MaestroConfig
): PhaseProjection[] {
  const activeDecision = board.activeDecision?.resolution ? undefined : board.activeDecision;
  const staleApprovedIds = new Set(
    config
      ? board.tasks
          .filter(
            (task) =>
              task.status === "approved" &&
              completionFreshness(board, task, config).state !== "fresh"
          )
          .map((task) => task.id)
      : []
  );
  const hasUnresolvedRecovery =
    Boolean(board.pausedDrive) ||
    Boolean(activeDecision) ||
    staleApprovedIds.size > 0 ||
    board.tasks.some(
      (task) =>
        task.status === "failed" ||
        task.status === "changes_requested" ||
        task.dispatchNote !== undefined ||
        task.findings?.some((finding) => finding.status === "open") ||
        task.attempts.some((attempt) =>
          ["disagreement", "operational_failure"].includes(attempt.reviewConvergence?.status ?? "")
        )
    );
  const liveReview = board.tasks.some(
    (task) => liveKinds.get(task.id) === "review" || task.dispatchClaim?.kind === "review"
  );
  const liveDiscovery = board.tasks.some(
    (task) =>
      task.discovery &&
      (liveKinds.get(task.id) === "execute" ||
        task.dispatchClaim?.kind === "execute" ||
        task.status === "running")
  );
  const liveExecute = board.tasks.some(
    (task) =>
      !task.discovery &&
      (liveKinds.get(task.id) === "execute" ||
        task.dispatchClaim?.kind === "execute" ||
        task.status === "running")
  );
  const discoveryActive = board.tasks.some(
    (task) => task.discovery && task.status !== "approved" && task.status !== "cancelled"
  );
  const allComplete =
    board.tasks.length > 0 &&
    board.tasks.every((task) => isTaskSettled(task) && !staleApprovedIds.has(task.id));
  const reviewPending = board.tasks.some((task) => task.status === "ready_for_review");
  const integrationPending = board.tasks.some(
    (task) => task.provenance?.candidateTree && !task.provenance.integratedCommit
  );
  const verificationPending = board.tasks.some(
    (task) =>
      task.provenance?.integratedCommit &&
      task.verificationProfile !== undefined &&
      task.provenance.verifiedAt === undefined
  );

  let current: RunPhase = "execution";
  if (board.planPending) current = "plan_approval";
  else if (allComplete) current = "complete";
  else if (hasUnresolvedRecovery) current = "recovery";
  else if (liveReview) current = "review";
  else if (liveDiscovery) current = "discovery";
  else if (liveExecute) current = "execution";
  else if (reviewPending) current = "review";
  else if (discoveryActive) current = "discovery";
  else if (verificationPending) current = "verification";
  else if (integrationPending) current = "integration";

  const decisionTaskIds = new Set(activeDecision?.taskIds ?? []);
  const pausedTaskIds = board.pausedDrive?.taskIds ? new Set(board.pausedDrive.taskIds) : undefined;

  const taskIdsByPhase: Record<RunPhase, string[]> = {
    discovery: board.tasks.filter((task) => task.discovery).map((task) => task.id),
    plan_approval: board.planPending ? board.tasks.map((task) => task.id) : [],
    execution: board.tasks
      .filter(
        (task) =>
          task.attempts.length > 0 ||
          ["todo", "running", "failed", "changes_requested"].includes(task.status)
      )
      .map((task) => task.id),
    review: board.tasks
      .filter(
        (task) =>
          task.status === "ready_for_review" ||
          task.attempts.some(
            (attempt) =>
              attempt.reviewLaunches !== undefined ||
              attempt.reviewReport !== undefined ||
              attempt.reviewSessionFile !== undefined
          )
      )
      .map((task) => task.id),
    integration: board.tasks
      .filter(
        (task) =>
          task.provenance?.candidateTree !== undefined ||
          task.provenance?.integratedCommit !== undefined ||
          task.integratedCommit !== undefined
      )
      .map((task) => task.id),
    verification: board.tasks
      .filter(
        (task) =>
          task.verificationProfile !== undefined ||
          task.verificationSummary !== undefined ||
          task.provenance?.verifiedAt !== undefined
      )
      .map((task) => task.id),
    recovery: board.tasks
      .filter(
        (task) =>
          ["failed", "changes_requested", "cancelled"].includes(task.status) ||
          task.dispatchNote !== undefined ||
          task.findings?.some((finding) => finding.status === "open") ||
          task.attempts.some(
            (attempt) =>
              attempt.failureReason !== undefined ||
              attempt.worktreePath !== undefined ||
              attempt.branch !== undefined ||
              ["disagreement", "operational_failure"].includes(
                attempt.reviewConvergence?.status ?? ""
              )
          ) ||
          decisionTaskIds.has(task.id) ||
          staleApprovedIds.has(task.id) ||
          (board.pausedDrive !== undefined &&
            (pausedTaskIds === undefined || pausedTaskIds.has(task.id)))
      )
      .map((task) => task.id),
    complete: board.tasks
      .filter((task) => isTaskSettled(task) && !staleApprovedIds.has(task.id))
      .map((task) => task.id),
  };

  return RUN_PHASES.map((id) => ({
    id,
    label: PHASE_LABELS[id],
    taskIds: taskIdsByPhase[id],
    current: id === current,
  }));
}

export interface StatusProjection {
  code: "empty" | "plan_pending" | "running" | "decision" | "blocked" | "ready" | "complete";
  phase: string;
  ownerSession?: string;
  runnable: number;
  reviewable: number;
  blocked: number;
  running: number;
  approved: number;
  cancelled: number;
  total: number;
  cost: number;
  recovery?: string;
}

export function projectStatus(
  board: Board,
  liveTaskIds: Iterable<string> | undefined = undefined,
  config?: MaestroConfig,
  liveKinds?: LiveTaskKinds
): StatusProjection {
  const liveIds = liveTaskIds ? [...liveTaskIds] : [];
  const live = new Set(liveIds);
  // An explicit liveness projection comes from the owning runtime. Persisted
  // `running` is recovery evidence, not proof that a process is still alive.
  const running = board.tasks.filter((task) =>
    liveTaskIds !== undefined ? live.has(task.id) : task.status === "running"
  ).length;
  const runnable = board.tasks.filter((task) => taskGroup(board, task) === "ready").length;
  const reviewable = board.tasks.filter((task) => task.status === "ready_for_review").length;
  const staleApproved = new Set(
    config
      ? board.tasks
          .filter(
            (task) =>
              task.status === "approved" &&
              completionFreshness(board, task, config).state !== "fresh"
          )
          .map((task) => task.id)
      : []
  );
  const blocked = board.tasks.filter(
    (task) =>
      task.status !== "cancelled" &&
      (blockedReason(board, task) !== undefined || staleApproved.has(task.id))
  ).length;
  const approved = board.tasks.filter(
    (task) => task.status === "approved" && !staleApproved.has(task.id)
  ).length;
  const cancelled = board.tasks.filter((task) => task.status === "cancelled").length;
  const base = {
    runnable,
    reviewable,
    blocked,
    running,
    approved,
    cancelled,
    total: board.tasks.length,
    cost: boardUsage(board.tasks).cost,
  };
  const phase = projectRunPhases(
    board,
    liveKinds ?? new Map(liveIds.map((taskId) => [taskId, "execute"] as const)),
    config
  ).find((candidate) => candidate.current)?.label;
  if (board.tasks.length === 0) return { code: "empty", phase: "empty", ...base };
  if (board.planPending) return { code: "plan_pending", phase: phase ?? "plan approval", ...base };
  if (running > 0) return { code: "running", phase: phase ?? "execution", ...base };
  if (board.activeDecision && !board.activeDecision.resolution) {
    return {
      code: "decision",
      phase: phase ?? "recovery",
      ...(board.activeDecision.ownerSession
        ? { ownerSession: board.activeDecision.ownerSession }
        : {}),
      recovery: board.activeDecision.allowedInterventions.join(" or ") || "inspect",
      ...base,
    };
  }
  if (approved + cancelled === board.tasks.length && staleApproved.size === 0) {
    return { code: "complete", phase: "complete", ...base };
  }
  if (runnable > 0 || reviewable > 0)
    return { code: "ready", phase: phase ?? "execution", ...base };
  return { code: "blocked", phase: phase ?? "recovery", recovery: "inspect blockers", ...base };
}

export function formatStatusProjection(status: StatusProjection): string {
  const owner = status.ownerSession ? ` · owner ${status.ownerSession}` : "";
  const recovery = status.recovery ? ` · recovery: ${status.recovery}` : "";
  return `${status.code} · ${status.phase} · ${status.approved} approved · ${status.cancelled} cancelled · ${status.running} running · ${status.runnable} runnable · ${status.reviewable} reviewable · ${status.blocked} blocked · $${status.cost.toFixed(4)}${owner}${recovery}`;
}
