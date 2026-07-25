import { type taskFingerprint } from "./artifact-policy.js";
import { buildReviewPrompt } from "./prompts.js";
import { redactFailureMessage } from "./runner.js";
import { type Attempt, type ReviewLaunch, type ReviewPolicy, type Task } from "./types.js";

/** Session picker name: "T3 add replay command · attempt 2" beats "maestro T3-attempt-2". */
export function sessionLabel(task: Task, kind: "attempt" | "review", index: number): string {
  const title = task.title.length > 40 ? `${task.title.slice(0, 40)}…` : task.title;
  return `${task.id} ${title} · ${kind} ${index}`;
}

/** Conventional commit message for a task: orchestrator-provided, or derived from the title. */
export function taskCommitMessage(task: Task): string {
  if (task.commitMessage) return task.commitMessage;
  const title = task.title.charAt(0).toLowerCase() + task.title.slice(1);
  return `feat: ${title}`;
}

type CriterionEvidence = NonNullable<ReviewLaunch["criterionEvidence"]>;

export function reviewEvidence(
  report: string,
  criteriaCount: number
): CriterionEvidence | undefined {
  // A task with no criteria has nothing for a reviewer to enumerate, so
  // per-criterion evidence cannot corroborate its verdict either way. Callers
  // must fall back to the verdict line instead of comparing against an empty
  // list, where `every` is vacuously true and would read a rejection as an
  // inconsistency.
  if (criteriaCount <= 0) return undefined;
  const matches = [...report.matchAll(/^CRITERION\s+(\d+):\s*(PASS|FAIL)\s*(?:—|-)\s*(.+)$/gim)];
  if (matches.length !== criteriaCount) return undefined;
  const evidence = matches.map((match) => ({
    criterion: Number(match[1]),
    passed: match[2]?.toUpperCase() === "PASS",
    evidence: redactFailureMessage(match[3] ?? "").slice(0, 500),
  }));
  const numbers = new Set(evidence.map((entry) => entry.criterion));
  if (numbers.size !== criteriaCount) return undefined;
  if (evidence.some((entry) => entry.criterion < 1 || entry.criterion > criteriaCount)) {
    return undefined;
  }
  return evidence.sort((left, right) => left.criterion - right.criterion);
}

export function policyReviewPrompt(
  task: Task,
  report: string,
  policy: ReviewPolicy,
  role: NonNullable<ReviewLaunch["role"]>,
  finderReport?: string
): string {
  const base = buildReviewPrompt(task, report);
  if (policy === "single") return base;
  const criteria = (task.successCriteria ?? [])
    .map((_criterion, index) => `CRITERION ${index + 1}: PASS|FAIL — bounded concrete evidence`)
    .join("\n");
  const roleText =
    role === "finder"
      ? "Act as the finding reviewer. Try to identify a concrete reason to reject the artifact."
      : role === "refuter"
        ? `Act as an independent confirmer/refuter. Assess the artifact yourself, then evaluate only this bounded finder evidence:\n${finderReport?.slice(0, 4_000) ?? "(none)"}`
        : "Act as an independent confirmer. Do not assume another reviewer approved the artifact.";
  // With no stated criteria there is nothing to enumerate; asking for the
  // lines anyway invites invented criteria that no parser can corroborate.
  if (!criteria) return `${base}\n\n${roleText}`;
  return `${base}\n\n${roleText}\nReport every criterion exactly once using these lines:\n${criteria}\nThe VERDICT must agree with the criterion lines.`;
}

export function convergenceRecord(
  policy: ReviewPolicy,
  status: NonNullable<Attempt["reviewConvergence"]>["status"],
  requiredApprovals: number,
  actualApprovals: number,
  reviewerCount: number,
  summary: string
): NonNullable<Attempt["reviewConvergence"]> {
  return {
    policy,
    status,
    requiredApprovals,
    actualApprovals,
    reviewerCount,
    summary: redactFailureMessage(summary).slice(0, 2_000),
    decidedAt: Date.now(),
  };
}

const STALE_COMPONENT_LABELS: Record<keyof Attempt["executionComponentHashes"] & string, string> = {
  contract: "Task contract (brief/criteria/policy)",
  execution: "Execution configuration (tier/review policy)",
  verification: "Verification profile",
  dependencies: "Dependency artifacts",
};

export function staleExecutionInputsMessage(
  latestAttempt: Attempt,
  currentFingerprint: ReturnType<typeof taskFingerprint>
): string {
  const before = latestAttempt.executionComponentHashes;
  const after = currentFingerprint?.componentHashes;
  const changedLabels = before
    ? (Object.keys(STALE_COMPONENT_LABELS) as Array<keyof typeof STALE_COMPONENT_LABELS>)
        .filter((component) => before[component] !== after?.[component])
        .map((component) => STALE_COMPONENT_LABELS[component])
    : [];
  const subject =
    changedLabels.length > 0
      ? changedLabels.join(", ")
      : "Task, configured execution, verification, or dependency inputs";
  return `${subject} changed after execution — the attempt ran under the old contract. Retry the task to re-execute under the current one.`;
}
