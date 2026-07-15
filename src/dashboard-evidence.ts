import { executorUsage, formatPromptSections, singleLine } from "./dashboard-format.js";
import { type DashboardLaunch } from "./dashboard-launches.js";
import { type Board, type Task } from "./types.js";

export interface EvidenceSection {
  title: string;
  lines: string[];
}

export interface EvidenceExtras {
  phaseLabel: string;
  lastActivity?: string;
  pausedDrive?: Board["pausedDrive"];
  decision?: Board["activeDecision"];
}

const EVIDENCE_SECTION_LINE_BUDGET = 12;

/**
 * Pure projection from a task's persisted evidence (plus caller-supplied live/board extras)
 * into fixed, ordered, budgeted sections for the evidence view. Never invents data — a section
 * with nothing to show is omitted entirely.
 */
export function projectEvidenceSections(
  task: Task,
  selectedLaunch: DashboardLaunch | undefined,
  extras: EvidenceExtras
): EvidenceSection[] {
  const attempt = selectedLaunch?.attempt ?? task.attempts.at(-1);
  const latestReview = selectedLaunch ? selectedLaunch.review : attempt?.reviewLaunches?.at(-1);

  const contract: string[] = [`Prompt source: ${singleLine(task.brief).slice(0, 500)}`];
  if (task.supersedes) contract.push(`Lineage: supersedes ${task.supersedes}`);
  if (task.successCriteria?.length) {
    contract.push(
      `Success criteria: ${task.successCriteria.map(singleLine).join(" | ").slice(0, 800)}`
    );
  }

  const review: string[] = [];
  if (latestReview) {
    review.push(
      `Reviewer: ${latestReview.role ?? "reviewer"} · ${latestReview.verdict ?? latestReview.failureReason?.kind ?? "pending"} · model ${latestReview.model ?? "unknown"} · provider ${latestReview.provider ?? "unknown"}`,
      `Review usage: ${latestReview.usage.turns} turns · $${latestReview.usage.cost.toFixed(4)} · ${latestReview.usage.input} input · ${latestReview.usage.output} output`
    );
    if (latestReview.finalReport) {
      review.push(`Review result: ${singleLine(latestReview.finalReport).slice(0, 1_000)}`);
    }
    for (const entry of latestReview.criterionEvidence ?? []) {
      review.push(
        `Criterion evidence: ${entry.criterion} ${entry.passed ? "PASS" : "FAIL"} ${singleLine(entry.evidence).slice(0, 500)}`
      );
    }
  } else if (attempt?.reviewUsage) {
    review.push(
      `Legacy review: model ${attempt.reviewModel ?? "unknown"} · provider ${attempt.reviewProvider ?? "unknown"} · ${attempt.reviewUsage.turns} turns · $${attempt.reviewUsage.cost.toFixed(4)}`
    );
  }
  if (attempt?.reviewConvergence) {
    review.push(
      `Convergence: ${attempt.reviewConvergence.policy} · ${attempt.reviewConvergence.status} · ${attempt.reviewConvergence.actualApprovals}/${attempt.reviewConvergence.requiredApprovals} approvals · ${singleLine(attempt.reviewConvergence.summary).slice(0, 500)}`
    );
  }
  for (const finding of task.findings ?? []) {
    review.push(
      `Finding: ${finding.status} ${finding.fingerprint}: ${singleLine(finding.message).slice(0, 500)}`
    );
  }

  const execution: string[] = [];
  if (attempt) {
    const executionUsage = executorUsage(attempt);
    execution.push(
      `Executor identity: model ${attempt.model ?? "unknown"} · provider ${attempt.provider ?? "unknown"}`,
      `Executor usage: ${executionUsage.turns} turns · $${executionUsage.cost.toFixed(4)} · ${executionUsage.input} input · ${executionUsage.output} output`
    );
    if (attempt.finalReport) {
      execution.push(`Final result: ${singleLine(attempt.finalReport).slice(0, 1_000)}`);
    }
  }
  if (extras.pausedDrive) {
    execution.push(
      `Paused drive: owner ${extras.pausedDrive.ownerSession ?? "unknown"} · scope ${extras.pausedDrive.taskIds?.join(", ") ?? "all"}`
    );
  }
  if (extras.decision?.taskIds.includes(task.id)) {
    execution.push(
      `Decision: ${extras.decision.id} · ${extras.decision.kind} · owner ${extras.decision.ownerSession ?? "unknown"} · ${singleLine(extras.decision.evidence).slice(0, 500)}`
    );
  }
  if (extras.lastActivity) execution.push(`Recent activity: ${extras.lastActivity.slice(0, 800)}`);

  const artifact: string[] = [];
  if (task.provenance?.candidateTree)
    artifact.push(`Candidate tree: ${task.provenance.candidateTree}`);
  if (task.approvedProvenance) {
    artifact.push(
      `Completion fingerprint: ${task.approvedProvenance.fingerprint.slice(0, 12)} · ${task.approvedProvenance.artifact.kind} ${task.approvedProvenance.artifact.identity.slice(0, 12)}`
    );
  } else if (task.status === "approved") {
    artifact.push("Completion fingerprint: legacy proof unavailable · retry or create a successor");
  }
  if (task.provenance?.integratedTree)
    artifact.push(`Integrated tree: ${task.provenance.integratedTree}`);
  const integratedCommit = task.provenance?.integratedCommit ?? task.integratedCommit;
  if (integratedCommit) artifact.push(`Integration commit: ${integratedCommit}`);
  if (task.verificationProfile || task.verificationSummary || task.provenance?.verifiedAt) {
    artifact.push(
      `Verification: ${task.provenance?.verifiedAt ? "passed" : "pending"} · profile ${task.provenance?.verificationProfile ?? task.verificationProfile ?? "none"} · ${singleLine(task.verificationSummary ?? "no summary")}`
    );
  }

  const recovery: string[] = [];
  if (attempt) {
    recovery.push(
      `Recovery refs: worktree ${attempt.worktreePath ?? "none"} · branch ${attempt.branch ?? "none"} · log ${attempt.logFile} · session ${attempt.sessionFile ?? "none"}`
    );
    if (attempt.failureReason) {
      recovery.push(
        `Failure: ${attempt.failureReason.kind} · ${singleLine(attempt.failureReason.message)} · ${attempt.failureReason.retryable ? "retryable" : "not retryable"}`
      );
    }
  }
  if (task.dispatchClaim || task.dispatchNote) {
    recovery.push(
      `Dispatch: ${task.dispatchClaim?.kind ?? "none"} ${task.dispatchClaim?.id ?? ""} · ${singleLine(task.dispatchNote ?? "no note")}`
    );
  }

  const accounting: string[] = [];
  if (
    attempt &&
    (attempt.promptCharacters !== undefined || attempt.promptApproximateTokens !== undefined)
  ) {
    accounting.push(
      `Executor prompt: ${attempt.promptCharacters ?? 0} chars · ~${attempt.promptApproximateTokens ?? 0} tokens${formatPromptSections(attempt.promptSections)}`
    );
  }
  if (attempt && attempt.touchedFiles.length > 0) {
    accounting.push(`Changed files: ${attempt.touchedFiles.join(", ").slice(0, 800)}`);
  }
  if (
    latestReview &&
    (latestReview.promptCharacters !== undefined ||
      latestReview.promptApproximateTokens !== undefined)
  ) {
    accounting.push(
      `Review prompt: ${latestReview.promptCharacters ?? 0} chars · ~${latestReview.promptApproximateTokens ?? 0} tokens${formatPromptSections(latestReview.promptSections)}`
    );
  }

  return [
    { title: "Contract", lines: contract },
    { title: "Review", lines: review },
    { title: "Execution", lines: execution },
    { title: "Artifact & verification", lines: artifact },
    { title: "Recovery", lines: recovery },
    { title: "Accounting", lines: accounting },
  ]
    .filter((section) => section.lines.length > 0)
    .map(applyEvidenceSectionBudget);
}

function applyEvidenceSectionBudget(section: EvidenceSection): EvidenceSection {
  if (section.lines.length <= EVIDENCE_SECTION_LINE_BUDGET) return section;
  const hidden = section.lines.length - EVIDENCE_SECTION_LINE_BUDGET;
  return {
    title: section.title,
    lines: [
      ...section.lines.slice(0, EVIDENCE_SECTION_LINE_BUDGET),
      `… (+${hidden} more — open session for full detail)`,
    ],
  };
}
