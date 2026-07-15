import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  artifactFindings,
  captureApprovedProvenance,
  pathsOutsideWriteScope,
} from "./artifact-policy.js";
import { assertTaskNotDispatched, findTask, forceStatus, loadBoard, updateBoard } from "./board.js";
import { loadConfig } from "./config.js";
import { type Task } from "./types.js";
import { parkWorktree, restoreWorktree, snapshotArtifact } from "./worktree.js";

export function manuallyApproveTask(ctx: ExtensionContext, taskId: string): Task {
  const initialBoard = loadBoard(ctx.cwd);
  const initialTask = findTask(initialBoard, taskId);
  if (!initialTask) throw new Error(`Unknown task id: ${taskId}`);
  assertTaskNotDispatched(initialTask);
  if (initialTask.status !== "ready_for_review") {
    throw new Error("Manual approval requires a task that is ready for review.");
  }
  const attempt = initialTask.attempts.at(-1);
  if (!attempt?.finalReport?.trim() || attempt.endedAt === undefined) {
    throw new Error("Manual approval requires a completed attempt with a final report.");
  }
  const findings = artifactFindings(initialTask, attempt);
  if (findings && findings.length > 0) {
    throw new Error(`Manual approval refused: ${findings[0]?.message ?? "artifact is unsafe"}`);
  }
  const worktree =
    attempt.worktreePath && attempt.branch
      ? { worktreePath: attempt.worktreePath, branch: attempt.branch }
      : undefined;
  if (worktree) restoreWorktree(ctx.cwd, worktree);
  const candidateTree =
    (initialTask.writePaths?.length ?? 0) > 0
      ? (() => {
          if (attempt.touchedFiles.length === 0) {
            throw new Error("Manual approval requires nonempty attributable Git changes.");
          }
          const outsideScope = pathsOutsideWriteScope(initialTask, attempt);
          if (outsideScope.length > 0) {
            throw new Error(
              `Manual approval refused changes outside write scope: ${outsideScope.join(", ")}`
            );
          }
          const artifact = snapshotArtifact(attempt.worktreePath ?? ctx.cwd, attempt.touchedFiles);
          if (!artifact) throw new Error("Manual approval requires a scoped Git artifact.");
          return artifact;
        })()
      : undefined;
  const attemptIdentity = `${attempt.index}:${attempt.logFile}:${attempt.startedAt}`;
  if (worktree) parkWorktree(ctx.cwd, worktree);

  return updateBoard(ctx.cwd, (board) => {
    const task = findTask(board, taskId);
    const freshAttempt = task?.attempts.at(-1);
    if (
      !task ||
      task.updatedAt !== initialTask.updatedAt ||
      !freshAttempt ||
      `${freshAttempt.index}:${freshAttempt.logFile}:${freshAttempt.startedAt}` !== attemptIdentity
    ) {
      throw new Error("Manual approval became stale while inspecting Git; retry it.");
    }
    assertTaskNotDispatched(task);
    if (candidateTree) task.provenance = { candidateTree, capturedAt: Date.now() };
    const proof = captureApprovedProvenance(board, task, loadConfig(ctx.cwd));
    if (!proof)
      throw new Error("Manual approval requires an authoritative artifact or final report.");
    forceStatus(task, "approved");
    task.approvalKind = "manual";
    task.verificationSummary = "accepted manually with versioned artifact proof";
    task.approvedProvenance = proof;
    return task;
  });
}
