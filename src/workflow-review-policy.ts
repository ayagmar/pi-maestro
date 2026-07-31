import { createHash } from "node:crypto";
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

/**
 * Independent approvals worth paying for on this attempt.
 *
 * A multi-reviewer policy buys confidence in *contested* work. Once an
 * attempt has already been approved and only re-review after a mechanical
 * failure (merge conflict, changed artifact, verification retry) remains, the
 * extra confirmers re-derive a verdict the panel already reached, at full
 * price. This keeps the first panel intact and charges one reviewer for a
 * pure re-confirmation.
 */
export function effectiveRequiredApprovals(
  task: Task,
  policy: ReviewPolicy,
  configuredApprovals: number
): number {
  if (policy !== "confirm") return policy === "find-and-refute" ? 2 : 1;
  const attempt = task.attempts.at(-1);
  const launches = attempt?.reviewLaunches ?? [];
  if (launches.length === 0) return configuredApprovals;
  // Any genuine rejection on this attempt means the work is contested; the
  // full panel is exactly what that case needs.
  if (launches.some((launch) => launch.verdict === "request_changes")) return configuredApprovals;
  const approvals = new Set(
    launches.filter((launch) => launch.verdict === "approve").map((launch) => launch.reviewerIndex)
  ).size;
  if (approvals < configuredApprovals) return configuredApprovals;
  return 1;
}

/**
 * Stable identity for one reviewer finding, used to detect the same defect
 * surviving an attempt.
 *
 * Reviewers write Markdown: `**Criterion 1 — \`src/x.ts\`:** …`. Matching a
 * bare `criterion N:` prefix missed all of it and fell through to hashing the
 * raw text, which any rewording defeated — so a genuinely stuck task looked
 * like it was converging and quietly consumed every attempt. Emphasis and
 * incidental punctuation are normalized away before both checks.
 */
export function findingFingerprint(message: string): string {
  const plain = message
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // A criterion reference is the strongest identity available: the same
  // criterion failing twice is the same unmet requirement regardless of prose.
  const criterion = plain.match(/^criterion\s+(\d+)\b/i)?.[1];
  if (criterion) return `criterion-${criterion}`;
  const normalized = plain
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

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
  summary: string,
  cause?: "gate"
): NonNullable<Attempt["reviewConvergence"]> {
  return {
    policy,
    status,
    requiredApprovals,
    actualApprovals,
    reviewerCount,
    summary: redactFailureMessage(summary).slice(0, 2_000),
    decidedAt: Date.now(),
    ...(cause ? { cause } : {}),
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

/**
 * An executor's own statement that it did not finish.
 *
 * A real task was approved while the plan document it produced said
 * "State: BLOCKED — the clean full non-device gate failed twice", and the
 * board then unblocked six dependents on that foundation. A reviewer may
 * reasonably judge partial work acceptable, but it must not do so silently
 * against the executor's explicit self-report: the words below are a claim of
 * incompletion, not a stylistic choice.
 */
const SELF_REPORTED_INCOMPLETE =
  /^[^\S\n]*(?:[-*>|#\s]*)?(?:\**)(?:state|status|result|outcome)(?:\**)\s*[:|]\s*(?:\**)\s*(BLOCKED|INCOMPLETE|NOT DONE|FAILED)\b/gim;

export function selfReportedBlocker(report: string): string | undefined {
  const match = [...report.matchAll(SELF_REPORTED_INCOMPLETE)].at(0);
  if (!match) return undefined;
  // The match can start on the newline that begins the line, so take the
  // first non-empty line from it rather than the literal first segment.
  const line =
    report
      .slice(match.index ?? 0)
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0) ?? "";
  return line.slice(0, 300);
}
