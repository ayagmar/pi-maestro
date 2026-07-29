import { modelIdentity } from "./cost-forecast-policy.js";
import { type Board, type FailureKind, type Task } from "./types.js";

const FAILURE_KINDS: FailureKind[] = [
  "provider_failure",
  "stalled",
  "executor_failure",
  "reviewer_rejection",
  "reviewer_failure",
  "user_abort",
  "cost_cap",
];

export interface ModelTierInsight {
  model: string;
  tier: string;
  attempts: number;
  firstReviews: number;
  firstReviewApprovals: number;
  approvedTasks: number;
  approvedTaskCost: number;
  failures: Partial<Record<FailureKind, number>>;
  reviewerVerdicts: number;
  reviewerRejections: number;
  /** Rejection retries that continued the predecessor's session. */
  resumedRetries: number;
  resumedRetryExecutorCost: number;
  /** Rejection retries that started with a fresh context. */
  freshRetries: number;
  freshRetryExecutorCost: number;
}

export interface ModelInsights {
  groups: ModelTierInsight[];
  attempts: number;
}

interface MutableInsight extends ModelTierInsight {
  approvedTaskKeys: Set<string>;
}

export function deriveModelInsights(boards: readonly Board[]): ModelInsights {
  const groups = new Map<string, MutableInsight>();
  const seenAttempts = new Set<string>();
  const seenApprovedTasks = new Set<string>();

  for (const board of boards) {
    for (const task of board.tasks) {
      const taskIdentity = taskKey(task);
      for (const attempt of task.attempts) {
        const model = modelIdentity(attempt.provider, attempt.model) ?? "(unknown)";
        const identity = attemptKey(taskIdentity, attempt);
        if (seenAttempts.has(identity)) continue;
        seenAttempts.add(identity);
        const group = ensureGroup(groups, task.tier, model);
        group.attempts += 1;
        // Retry economics: how much a second attempt costs when it resumes
        // the rejected session versus re-deriving everything fresh. Reviewer
        // spend is folded into attempt usage, so subtract it to compare the
        // executor side alone.
        if (attempt.index > 1) {
          const reviewSpend = (attempt.reviewLaunches ?? []).reduce(
            (sum, launch) => sum + launch.usage.cost,
            0
          );
          const executorSpend = Math.max(0, attempt.usage.cost - reviewSpend);
          if (attempt.resumed) {
            group.resumedRetries += 1;
            group.resumedRetryExecutorCost += executorSpend;
          } else {
            group.freshRetries += 1;
            group.freshRetryExecutorCost += executorSpend;
          }
        }
        if (attempt.failureReason) {
          const kind = attempt.failureReason.kind;
          group.failures[kind] = (group.failures[kind] ?? 0) + 1;
        }
        const firstReview = attempt.reviewLaunches?.[0];
        if (firstReview) {
          group.firstReviews += 1;
          if (firstReview.verdict === "approve") group.firstReviewApprovals += 1;
        }
        for (const launch of attempt.reviewLaunches ?? []) {
          if (!launch.verdict) continue;
          group.reviewerVerdicts += 1;
          if (launch.verdict === "request_changes") group.reviewerRejections += 1;
        }
      }

      if (task.status !== "approved" || seenApprovedTasks.has(taskIdentity)) continue;
      seenApprovedTasks.add(taskIdentity);
      const finalAttempt = task.attempts.at(-1);
      if (!finalAttempt) continue;
      const finalModel = modelIdentity(finalAttempt.provider, finalAttempt.model) ?? "(unknown)";
      const group = ensureGroup(groups, task.tier, finalModel);
      group.approvedTaskKeys.add(taskIdentity);
      group.approvedTasks = group.approvedTaskKeys.size;
      group.approvedTaskCost += task.attempts.reduce((sum, attempt) => sum + attempt.usage.cost, 0);
    }
  }

  const ordered = [...groups.values()]
    .sort(
      (left, right) => left.tier.localeCompare(right.tier) || left.model.localeCompare(right.model)
    )
    .map(({ approvedTaskKeys: _approvedTaskKeys, ...group }) => group);
  return { groups: ordered, attempts: ordered.reduce((sum, group) => sum + group.attempts, 0) };
}

export function formatModelInsights(
  insights: ModelInsights,
  archiveCount: number,
  maxCharacters = 6_000
): string {
  const header = `Maestro insights · current board + ${archiveCount} archive(s) · ${insights.attempts} attempt(s)`;
  if (insights.groups.length === 0) {
    return `${header}\nNo recorded model attempts in current or archived boards.`;
  }

  const sections = insights.groups.map((group) => {
    const firstReviewRate = rate(group.firstReviewApprovals, group.firstReviews);
    const rejectionRate = rate(group.reviewerRejections, group.reviewerVerdicts);
    const averageApprovedCost =
      group.approvedTasks > 0
        ? `$${(group.approvedTaskCost / group.approvedTasks).toFixed(4)} (${group.approvedTasks} task${group.approvedTasks === 1 ? "" : "s"})`
        : "n/a (0 tasks)";
    const failures = FAILURE_KINDS.filter((kind) => group.failures[kind])
      .map((kind) => `${kind}:${group.failures[kind]}`)
      .join(", ");
    const retryEconomics =
      group.resumedRetries > 0 || group.freshRetries > 0
        ? `\n  retries: resumed ${group.resumedRetries} ($${average(group.resumedRetryExecutorCost, group.resumedRetries)} avg exec) · fresh ${group.freshRetries} ($${average(group.freshRetryExecutorCost, group.freshRetries)} avg exec)`
        : "";
    return [
      `${group.tier} · ${group.model}`,
      `  attempts ${group.attempts} · first-review approval ${firstReviewRate}`,
      `  avg cost / approved task ${averageApprovedCost}`,
      `  reviewer rejection ${rejectionRate} · failures ${failures || "none"}${retryEconomics}`,
    ].join("\n");
  });

  const retained: string[] = [header];
  let length = header.length;
  for (const [index, section] of sections.entries()) {
    const addition = section.length + 2;
    const omitted = sections.length - index;
    const suffix = `\n\n… ${omitted} model/tier group(s) omitted by report bound`;
    if (length + addition + suffix.length > maxCharacters) {
      retained.push(`… ${omitted} model/tier group(s) omitted by report bound`);
      break;
    }
    retained.push(section);
    length += addition;
  }
  return retained.join("\n\n");
}

function ensureGroup(
  groups: Map<string, MutableInsight>,
  tier: string,
  model: string
): MutableInsight {
  const key = groupKey(tier, model);
  const existing = groups.get(key);
  if (existing) return existing;
  const created: MutableInsight = {
    model,
    tier,
    attempts: 0,
    firstReviews: 0,
    firstReviewApprovals: 0,
    approvedTasks: 0,
    approvedTaskCost: 0,
    failures: {},
    reviewerVerdicts: 0,
    reviewerRejections: 0,
    resumedRetries: 0,
    resumedRetryExecutorCost: 0,
    freshRetries: 0,
    freshRetryExecutorCost: 0,
    approvedTaskKeys: new Set<string>(),
  };
  groups.set(key, created);
  return created;
}

function groupKey(tier: string, model: string): string {
  return `${tier}\u0000${model.toLowerCase()}`;
}

function taskKey(task: Task): string {
  if (task.approvedProvenance) {
    return `approved:${task.approvedProvenance.fingerprint}:${task.approvedProvenance.artifact.identity}`;
  }
  if (task.integratedCommit) return `commit:${task.integratedCommit}`;
  return `task:${task.createdAt}:${task.id}:${task.title}`;
}

function attemptKey(taskIdentity: string, attempt: Task["attempts"][number]): string {
  return `${taskIdentity}\u0000${attempt.sessionFile ?? attempt.logFile}\u0000${attempt.startedAt}\u0000${attempt.index}`;
}

function average(total: number, count: number): string {
  return count > 0 ? (total / count).toFixed(4) : "0.0000";
}

function rate(numerator: number, denominator: number): string {
  return denominator > 0
    ? `${((numerator / denominator) * 100).toFixed(1)}% (${numerator}/${denominator})`
    : "n/a (0/0)";
}
