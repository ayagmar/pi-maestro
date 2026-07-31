import { updateTask } from "./board.js";
import { taskUsage, truncateText } from "./format.js";
import { redactFailureMessage } from "./runner.js";
import { type MaestroConfig, type Task } from "./types.js";
import {
  consumesMaxAttempt,
  type DriveStopReason,
  lastReport,
  REVIEW_REJECTION_LIMIT,
  type TaskSnapshot,
  TIER_LADDER,
} from "./workflow-policy.js";

/**
 * A dependency that can never reach `approved` blocks its dependents forever.
 * Reporting only "no dispatch was attempted" leaves the user to trace the
 * chain by hand, so name the unreachable root and say it is permanent.
 */
function deadDependencies(tasks: Task[], task: Task): string[] {
  const byId = new Map(tasks.map((candidate) => [candidate.id.toUpperCase(), candidate]));
  const dead: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    const key = id.trim().toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    const dependency = byId.get(key);
    if (!dependency) return;
    if (dependency.status === "cancelled" || dependency.status === "failed") {
      dead.push(`${dependency.id} (${dependency.status})`);
      return;
    }
    if (dependency.status !== "approved") for (const next of dependency.dependsOn) visit(next);
  };
  for (const id of task.dependsOn) visit(id);
  return dead;
}

export function noProgressReason(tasks: Task[], dispatchResults: TaskSnapshot[]): DriveStopReason {
  const notes = new Map(
    dispatchResults.map((result) => [
      result.id,
      result.note ?? "dispatch declined without a reason",
    ])
  );
  const pending = tasks.filter((task) => !["approved", "cancelled"].includes(task.status));
  const stuck = new Map(
    pending
      .map((task) => [task.id, deadDependencies(tasks, task)] as const)
      .filter(([, d]) => d.length > 0)
  );
  const details = pending.map((task) => {
    // A task cut off by a cap did not fail on its merits, and the note the
    // scheduler leaves ("no dispatch was attempted") hides why it is stuck.
    const terminal = task.attempts.at(-1)?.failureReason;
    if (terminal && terminal.retryable === false) {
      return `${task.id} (${task.status}): ${terminal.message}`;
    }
    const dead = stuck.get(task.id);
    if (dead) {
      return `${task.id} (${task.status}): permanently blocked by ${dead.join(", ")}; no dependency can reach approved`;
    }
    return `${task.id} (${task.status}): ${notes.get(task.id) ?? "no dispatch was attempted"}`;
  });
  const remedy =
    stuck.size > 0
      ? `\n\n${stuck.size} task(s) cannot run until their cancelled or failed dependencies are resolved. Retry the blocking task, replace it with a successor via supersedesTaskId, or — when the cancellation was accidental (an aborted drive) — reactivate it with maestro_update { taskId, cancelled: false } and drive again.`
      : "";
  return {
    code: "no_progress",
    message: `Drive stopped because no executor or reviewer launched and no selected task changed status.\n${details.join("\n")}${remedy}`,
    taskIds: pending.map((task) => task.id),
  };
}

export function terminalReviewConvergence(
  task: Task
): "disagreement" | "operational_failure" | undefined {
  if (task.status !== "ready_for_review") return undefined;
  const status = task.attempts.at(-1)?.reviewConvergence?.status;
  if (status === "disagreement" || status === "operational_failure") return status;
  return undefined;
}

/**
 * A first review that fails this many *distinct* success criteria is a strong
 * signal the task bundles several independent pieces of work. Retrying the
 * whole omnibus re-bills the full attempt and review for every defect at
 * once; splitting is almost always cheaper than a second full cycle.
 */
export const OMNIBUS_ESCALATION_CRITERIA = 4;

function distinctOpenCriterionFindings(task: Task): number {
  return new Set(
    (task.findings ?? [])
      .filter((finding) => finding.status === "open" && /^criterion-\d+$/.test(finding.fingerprint))
      .map((finding) => finding.fingerprint)
  ).size;
}

/** A genuine rejection spanning many independent criteria: split, don't retry. */
export function omnibusRejection(task: Task): boolean {
  if (task.status !== "changes_requested") return false;
  if ((task.reviewRejections ?? 0) < 1) return false;
  return distinctOpenCriterionFindings(task) >= OMNIBUS_ESCALATION_CRITERIA;
}

/**
 * Escalate on stagnation, not on rejection count alone. Reaching the rejection
 * limit while every rejection raised only *new* findings means the task is
 * still converging, so it keeps its remaining attempts. Repeating a finding a
 * previous attempt was already told to fix is the stuck case that needs human
 * judgment. Legacy boards without a recorded stagnation count keep the old
 * rejection-only behavior. A single rejection that fails many independent
 * criteria escalates immediately: it is a task-shape problem, and a brief or
 * tier edit (which resets the counters) is the recovery for both cases.
 */
export function escalatedTask(task: Task, rejectionLimit = REVIEW_REJECTION_LIMIT): boolean {
  if (task.status !== "changes_requested") return false;
  if (omnibusRejection(task)) return true;
  if ((task.reviewRejections ?? 0) < rejectionLimit) return false;
  if (task.reviewStagnantRejections === undefined) return true;
  return task.reviewStagnantRejections > 0;
}

export function escalationReason(tasks: Task[], config: MaestroConfig): DriveStopReason {
  const rejectionLimit = config.reviewRejectionLimit ?? REVIEW_REJECTION_LIMIT;
  const details = tasks.map((task) => {
    const notes = task.reviewNotes ?? task.attempts.at(-1)?.reviewNotes;
    const evidence = notes
      ? redactFailureMessage(truncateText(notes, 12))
      : "no reviewer notes recorded";
    const repeated = (task.findings ?? [])
      .filter((finding) => finding.status === "open" && finding.firstAttempt < finding.lastAttempt)
      .map((finding) => finding.fingerprint);
    const stagnation =
      repeated.length > 0 ? `\n  repeated across attempts: ${repeated.join(", ")}` : "";
    const omnibusCriteria = distinctOpenCriterionFindings(task);
    const omnibus = omnibusRejection(task)
      ? `\n  one review failed ${omnibusCriteria} distinct criteria — this task bundles independent work; split it instead of retrying the whole`
      : "";
    // Executor-side evidence. Without what the executor changed and claimed,
    // the orchestrator re-reads the repository to reconstruct it at full
    // context cost before it can replan.
    const usage = taskUsage(task);
    const spent = `\n  spent: $${usage.cost.toFixed(4)} across ${task.attempts.length} attempt(s)`;
    const touchedFiles = task.attempts.at(-1)?.touchedFiles ?? [];
    const touched =
      touchedFiles.length > 0
        ? `\n  last attempt touched: ${touchedFiles.slice(0, 15).join(", ")}${touchedFiles.length > 15 ? `, +${touchedFiles.length - 15} more` : ""}`
        : "";
    const report = lastReport(task);
    const reportTail = report
      ? `\n  executor report (bounded):\n  ${redactFailureMessage(truncateText(report, 10)).split("\n").join("\n  ")}`
      : "";
    const rung = TIER_LADDER.indexOf(task.tier as (typeof TIER_LADDER)[number]);
    const nextTier =
      rung >= 0 ? TIER_LADDER.slice(rung + 1).find((name) => config.tiers[name]) : undefined;
    const action = omnibusRejection(task)
      ? "split it with maestro_plan (one task per independent defect, supersedesTaskId on one of them)"
      : nextTier
        ? `raise the tier to "${nextTier}" with maestro_update`
        : "rewrite, split, or cancel the brief with maestro_update and apply orchestrator judgment";
    return `${task.id} [tier ${task.tier}]: ${evidence}${stagnation}${omnibus}${spent}${touched}${reportTail}\n  → ${action}`;
  });
  return {
    code: "escalation_required",
    message: `Reviewer rejections stopped autonomous retries (stagnant after ${rejectionLimit} rejection(s), or one rejection spanning ${OMNIBUS_ESCALATION_CRITERIA}+ criteria); orchestrator intervention required.\n${details.join("\n")}\nAfter a brief/tier edit (which resets the counters), use /maestro resume. After superseding or splitting, start maestro_drive for the successor scope — a paused drive scope is rewired to the successor automatically.`,
    taskIds: tasks.map((task) => task.id),
  };
}

export type ProviderFailureClass = "transient" | "persistent";

const PROVIDER_FAILURE_PATTERNS: Record<ProviderFailureClass, readonly RegExp[]> = {
  persistent: [
    /\b(?:auth(?:entication|orization)?|unauthenticated|unauthorized)\b/i,
    /\b(?:invalid|missing|expired|revoked)\s+(?:api[ -]?)?key\b/i,
    /\b(?:quota|billing|payment|credit|usage limit)\b/i,
    /\bmodel(?:[-_ ]not[-_ ]found|\s+does not exist|\s+unavailable for)\b/i,
    /\b(?:permission|forbidden)\b/i,
    /\b(?:401|403)\b/,
  ],
  transient: [
    /\b(?:timeout|timed out|etimedout)\b/i,
    /\b(?:econnreset|econnrefused|connection resets?|connection refused|network error)\b/i,
    /\b(?:http\s*)?429\b/i,
    /\b(?:http\s*)?5\d\d\b/i,
    /\b(?:overloaded|rate limit|service unavailable|temporarily unavailable)\b/i,
  ],
};

export function classifyProviderFailure(message: string | undefined): ProviderFailureClass {
  const evidence = message ?? "";
  for (const pattern of PROVIDER_FAILURE_PATTERNS.persistent) {
    if (pattern.test(evidence)) return "persistent";
  }
  for (const pattern of PROVIDER_FAILURE_PATTERNS.transient) {
    if (pattern.test(evidence)) return "transient";
  }
  return "persistent";
}

export function providerFailureMessage(task: Task): string | undefined {
  const attempt = task.attempts.at(-1);
  return attempt?.reviewLaunches?.at(-1)?.failureReason?.message ?? attempt?.failureReason?.message;
}

export function scheduleTransientProviderRetry(
  cwd: string,
  tasks: Task[],
  retriedTaskIds: Set<string>
): boolean {
  if (
    tasks.some((task) => classifyProviderFailure(providerFailureMessage(task)) === "persistent")
  ) {
    return false;
  }

  const retryable = tasks.filter((task) => !retriedTaskIds.has(task.id));
  if (retryable.length === 0) return false;
  for (const task of retryable) {
    retriedTaskIds.add(task.id);
    if (task.status !== "ready_for_review") continue;
    updateTask(cwd, task.id, (fresh) => {
      const attempt = fresh.attempts.at(-1);
      if (attempt?.reviewConvergence?.status === "operational_failure") {
        delete attempt.reviewConvergence;
      }
    });
  }
  return true;
}

export function providerBlockedTask(task: Task): boolean {
  const latest = task.attempts.at(-1);
  if (!latest) return false;
  if (task.status === "failed") return !consumesMaxAttempt(latest);
  if (task.status !== "ready_for_review") return false;
  // A pre-review gate settlement (stale execution fingerprint, artifact or
  // verification failure) is the current truth about this attempt. Matching
  // on an older provider-failed launch here misdiagnosed a config-change
  // gate as "no available provider" and sent a real user hunting for an
  // auth problem that did not exist.
  if (latest.reviewConvergence?.cause === "gate") return false;
  return latest.reviewLaunches?.at(-1)?.failureReason?.kind === "provider_failure";
}

export function providerBlockedReason(
  tasks: Task[],
  transientProviderRetries: ReadonlySet<string>
): DriveStopReason {
  const details = tasks.map((task) => {
    const attempt = task.attempts.at(-1);
    const reviewFailure = attempt?.reviewLaunches?.at(-1);
    const model = reviewFailure?.model ?? attempt?.model ?? "configured model";
    const provider = reviewFailure?.provider ?? attempt?.provider;
    const identity = provider ? `${model} (${provider})` : model;
    const message = reviewFailure?.failureReason?.message ?? attempt?.failureReason?.message;
    const failureClass = classifyProviderFailure(message);
    const retry =
      failureClass === "transient" && transientProviderRetries.has(task.id)
        ? "; auto-retried once and failed again"
        : "";
    return `${task.id} [${failureClass}${retry}]: ${identity}${message ? ` — ${redactFailureMessage(message)}` : ""}`;
  });
  return {
    code: "provider_blocked",
    message: `Provider access blocked; autonomous retries stopped. ${details.join("; ")}\nPersistent failures require provider configuration; transient failures reach this decision only after one automatic retry. Check provider quota/authentication or configure another fallback in /maestro config, then use /maestro resume (or explicitly retry the task).`,
    taskIds: tasks.map((task) => task.id),
  };
}
