import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { taskFingerprint } from "./artifact-policy.js";
import { findTask, loadBoard, stateDir } from "./board.js";
import { runVerification } from "./runner.js";
import { type MaestroConfig, type Task, type VerificationProfile } from "./types.js";
import { taskCommitMessage } from "./workflow-review-policy.js";
import {
  artifactMatchesCommit,
  changedPaths,
  commitTree,
  headCommit,
  mainTreeIdentityMatches,
  prepareMainTreeIntegration,
  prepareWorktreeIntegration,
  promotePreparedIntegration,
  promotePreparedMainTreeIntegration,
  removePreparedIntegration,
  removeWorktree,
  snapshotArtifact,
  type WorktreeRef,
} from "./worktree.js";

export interface ReviewedCandidateIntegrationOptions {
  cwd: string;
  task: Task;
  candidateTree: string | undefined;
  candidatePaths: string[];
  worktree: WorktreeRef | undefined;
  autoCommit: boolean | undefined;
  requiresIntegration: boolean;
  configuredProfile: VerificationProfile | undefined;
  fingerprintBeforeIntegration: NonNullable<ReturnType<typeof taskFingerprint>> | undefined;
  signal: AbortSignal | undefined;
  reviewIdentityMatches(task: Task): boolean;
  runtimeConfig(): MaestroConfig;
}

export interface ReviewedCandidateIntegration {
  mechanicalFailure?: string;
  mergeConflict?: string;
  integratedCommit?: string;
  integratedTree?: string;
  verification?: Awaited<ReturnType<typeof runVerification>>;
}

const mainTreeOperationTails = new Map<string, Promise<void>>();

export async function integrateReviewedCandidate(
  options: ReviewedCandidateIntegrationOptions
): Promise<ReviewedCandidateIntegration> {
  const {
    cwd,
    task,
    candidateTree,
    candidatePaths,
    worktree,
    autoCommit,
    requiresIntegration,
    configuredProfile,
    fingerprintBeforeIntegration,
    signal,
    reviewIdentityMatches,
    runtimeConfig,
  } = options;

  if (!fingerprintBeforeIntegration) {
    return { mechanicalFailure: "Approved completion fingerprint inputs are unavailable." };
  }

  let result: ReviewedCandidateIntegration;
  if (worktree) {
    result = await integrateWorktreeCandidate({
      cwd,
      task,
      candidateTree,
      candidatePaths,
      worktree,
      configuredProfile,
      fingerprintBeforeIntegration,
      signal,
      reviewIdentityMatches,
      runtimeConfig,
    });
  } else if (autoCommit) {
    result = await integrateMainTreeCandidate({
      cwd,
      task,
      candidateTree,
      candidatePaths,
      configuredProfile,
      fingerprintBeforeIntegration,
      signal,
      reviewIdentityMatches,
      runtimeConfig,
    });
  } else if (requiresIntegration) {
    result = { mechanicalFailure: "Automated approval requires a proven integration commit." };
  } else {
    result = {};
  }

  if (result.mechanicalFailure) return result;
  if (result.integratedCommit) {
    result.integratedTree = commitTree(cwd, result.integratedCommit);
    if (
      candidateTree &&
      !artifactMatchesCommit(cwd, candidateTree, result.integratedCommit, candidatePaths)
    ) {
      return {
        ...result,
        mechanicalFailure: "Integrated commit does not contain the reviewed candidate tree.",
      };
    }
  }
  if (requiresIntegration && (!candidateTree || !result.integratedCommit)) {
    return {
      ...result,
      mechanicalFailure:
        "Automated approval requires an authoritative Git artifact and proven integration.",
    };
  }
  return result;
}

export async function removeIntegratedWorktree(cwd: string, worktree: WorktreeRef): Promise<void> {
  await serializeMainTreeOperation(cwd, () => removeWorktree(cwd, worktree));
}

type PreparedIntegrationOptions = Pick<
  ReviewedCandidateIntegrationOptions,
  | "cwd"
  | "task"
  | "candidateTree"
  | "candidatePaths"
  | "configuredProfile"
  | "signal"
  | "reviewIdentityMatches"
  | "runtimeConfig"
> & {
  fingerprintBeforeIntegration: NonNullable<ReturnType<typeof taskFingerprint>>;
};

type WorktreeIntegrationOptions = PreparedIntegrationOptions & { worktree: WorktreeRef };

async function integrateWorktreeCandidate(
  options: WorktreeIntegrationOptions
): Promise<ReviewedCandidateIntegration> {
  const { cwd, task, candidateTree, candidatePaths, worktree } = options;
  if (!worktree) return {};

  const verificationStateDir = mkdtempSync(join(tmpdir(), "maestro-verification-"));
  let verification: Awaited<ReturnType<typeof runVerification>> | undefined;
  try {
    const integrated = await serializeMainTreeOperation(cwd, async () => {
      const prepared = prepareWorktreeIntegration(cwd, worktree, taskCommitMessage(task));
      try {
        if (
          !candidateTree ||
          !artifactMatchesCommit(
            prepared.tempRef.worktreePath,
            candidateTree,
            prepared.integratedCommit,
            candidatePaths
          )
        ) {
          throw new Error("prepared integration does not contain the reviewed candidate tree");
        }
        await verifyPreparedCandidate(
          options,
          prepared,
          verificationStateDir,
          {
            identityBeforeVerification:
              "review identity changed before prepared integration verification",
            verificationFailure: "post-integration verification",
            mutatedCandidate: "post-integration verification mutated the prepared checkout",
            identityBeforePromotion: "review identity changed before integration promotion",
          },
          (value) => {
            verification = value;
          }
        );
        if (!mainTreeIdentityMatches(cwd, prepared.mainIdentity)) {
          throw new Error("main checkout changed before integration promotion");
        }
        const promoted = promotePreparedIntegration(cwd, prepared);
        if (!promoted.ok) {
          throw new Error(promoted.error ?? "prepared integration promotion failed");
        }
        return {
          integratedCommit: prepared.integratedCommit,
          integratedTree: prepared.integratedTree,
        };
      } finally {
        removePreparedIntegration(cwd, prepared);
      }
    });
    verification = retainVerificationLog(cwd, verification);
    return { ...integrated, ...(verification ? { verification } : {}) };
  } catch (error) {
    verification = retainVerificationLog(cwd, verification);
    const mergeConflict = `Approved review could not be integrated safely because of a git conflict or transaction check. Recovery worktree: ${worktree.worktreePath}\nBranch: ${worktree.branch}\n${error instanceof Error ? error.message : String(error)}`;
    return {
      mechanicalFailure: mergeConflict,
      mergeConflict,
      ...(verification ? { verification } : {}),
    };
  } finally {
    rmSync(verificationStateDir, { recursive: true, force: true });
  }
}

async function integrateMainTreeCandidate(
  options: PreparedIntegrationOptions
): Promise<ReviewedCandidateIntegration> {
  const { cwd, task, candidateTree, candidatePaths } = options;
  const verificationStateDir = mkdtempSync(join(tmpdir(), "maestro-verification-"));
  let verification: Awaited<ReturnType<typeof runVerification>> | undefined;
  try {
    const integrated = await serializeMainTreeOperation(cwd, async () => {
      if (!candidateTree || snapshotArtifact(cwd, candidatePaths) !== candidateTree) {
        throw new Error(
          "Candidate artifact changed after review; the unreviewed working files were left untouched."
        );
      }
      const prepared = prepareMainTreeIntegration(cwd, candidateTree, taskCommitMessage(task));
      try {
        if (
          !artifactMatchesCommit(
            prepared.tempRef.worktreePath,
            candidateTree,
            prepared.integratedCommit,
            candidatePaths
          )
        ) {
          throw new Error("prepared commit does not contain the reviewed candidate tree");
        }
        await verifyPreparedCandidate(
          options,
          prepared,
          verificationStateDir,
          {
            identityBeforeVerification:
              "review identity changed before prepared commit verification",
            verificationFailure: "post-review verification",
            mutatedCandidate: "post-review verification mutated the prepared commit checkout",
            identityBeforePromotion: "review identity changed before main-tree promotion",
          },
          (value) => {
            verification = value;
          }
        );
        if (!mainTreeIdentityMatches(cwd, prepared.mainIdentity)) {
          throw new Error(
            "main checkout changed after review; the immutable reviewed commit was not promoted"
          );
        }
        const promoted = promotePreparedMainTreeIntegration(cwd, prepared, candidatePaths);
        if (!promoted.ok) {
          throw new Error(promoted.error ?? "prepared main-tree promotion failed");
        }
        return {
          integratedCommit: prepared.integratedCommit,
          integratedTree: prepared.integratedTree,
        };
      } finally {
        removePreparedIntegration(cwd, prepared);
      }
    });
    verification = retainVerificationLog(cwd, verification);
    return { ...integrated, ...(verification ? { verification } : {}) };
  } catch (error) {
    verification = retainVerificationLog(cwd, verification);
    return {
      mechanicalFailure: `The reviewed artifact could not be committed: ${error instanceof Error ? error.message : String(error)}`,
      ...(verification ? { verification } : {}),
    };
  } finally {
    rmSync(verificationStateDir, { recursive: true, force: true });
  }
}

type PreparedCandidate = {
  tempRef: WorktreeRef;
  integratedCommit: string;
};

type PreparedCandidateMessages = {
  identityBeforeVerification: string;
  verificationFailure: string;
  mutatedCandidate: string;
  identityBeforePromotion: string;
};

async function verifyPreparedCandidate(
  options: PreparedIntegrationOptions,
  prepared: PreparedCandidate,
  verificationStateDir: string,
  messages: PreparedCandidateMessages,
  setVerification: (verification: Awaited<ReturnType<typeof runVerification>>) => void
): Promise<void> {
  const { cwd, task, configuredProfile, fingerprintBeforeIntegration, signal } = options;
  const heldTask = findTask(loadBoard(cwd), task.id);
  if (!heldTask || !options.reviewIdentityMatches(heldTask)) {
    throw new Error(messages.identityBeforeVerification);
  }
  if (configuredProfile) {
    const verification = await runVerification({
      cwd: prepared.tempRef.worktreePath,
      stateDir: verificationStateDir,
      name: `${task.id}-integrated`,
      command: configuredProfile.command,
      timeoutSeconds: configuredProfile.timeoutSeconds,
      ...(signal ? { signal } : {}),
    });
    setVerification(verification);
    if (!verification.ok) {
      throw new Error(
        `${messages.verificationFailure} ${task.verificationProfile} failed or was interrupted`
      );
    }
  }
  if (
    headCommit(prepared.tempRef.worktreePath) !== prepared.integratedCommit ||
    changedPaths(prepared.tempRef.worktreePath).length > 0
  ) {
    throw new Error(messages.mutatedCandidate);
  }
  const currentTask = findTask(loadBoard(cwd), task.id);
  if (!currentTask || !options.reviewIdentityMatches(currentTask)) {
    throw new Error(messages.identityBeforePromotion);
  }
  const currentFingerprint = taskFingerprint(loadBoard(cwd), currentTask, options.runtimeConfig());
  if (
    !currentFingerprint ||
    currentFingerprint.fingerprint !== fingerprintBeforeIntegration.fingerprint
  ) {
    throw new Error("task, config, or dependency fingerprint changed before promotion");
  }
}

function retainVerificationLog(
  cwd: string,
  verification: Awaited<ReturnType<typeof runVerification>> | undefined
): Awaited<ReturnType<typeof runVerification>> | undefined {
  if (!verification) return undefined;
  const directory = join(stateDir(cwd), "verification");
  mkdirSync(directory, { recursive: true });
  const logFile = join(directory, basename(verification.logFile));
  copyFileSync(verification.logFile, logFile);
  return { ...verification, logFile };
}

async function serializeMainTreeOperation<T>(cwd: string, operation: () => T): Promise<T> {
  const previous = mainTreeOperationTails.get(cwd) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => {},
    () => {}
  );
  mainTreeOperationTails.set(cwd, tail);

  try {
    return await result;
  } finally {
    if (mainTreeOperationTails.get(cwd) === tail) mainTreeOperationTails.delete(cwd);
  }
}
