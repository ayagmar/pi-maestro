import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { taskFingerprint } from "../src/artifact-policy.js";
import { createTask, findTask, forceStatus, loadBoard, saveBoard } from "../src/board.js";
import { loadConfig } from "../src/config.js";
import { manuallyApproveTask } from "../src/manual-approval.js";
import { MAX_INJECTED_CONTEXT_LENGTH } from "../src/prompts.js";
import { type ExecutorHandle, type RunOutcome } from "../src/runner.js";
import { type Attempt, type Board, type MaestroConfig, type Task } from "../src/types.js";
import { reviewTask, type StartExecutor } from "../src/workflow.js";
import {
  captureChangeBaseline,
  captureDiff,
  changedPaths,
  commitAll,
  changedPathsSinceBaseline,
  cleanupManagedWorktrees,
  createWorktree,
  inspectManagedWorktrees,
  mergeWorktree,
  parkInactiveWorktrees,
  parkWorktree,
  prepareMainTreeIntegration,
  promotePreparedMainTreeIntegration,
  removePreparedIntegration,
  restoreWorktree,
  snapshotArtifact,
  sweepWorktrees,
  uncommittedPathsInvisibleToWorktrees,
  worktreeRecoveryExists,
  worktreeRef,
} from "../src/worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function gitBytes(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd }).toString("hex");
}

function assertNoPreparedIntegration(cwd: string): void {
  assert.equal(git(cwd, "branch", "--list", "maestro-integration/*"), "");
  assert.doesNotMatch(git(cwd, "worktree", "list", "--porcelain"), /maestro-integration-/);
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-worktree-test-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "shared.txt"), "base\n");
  writeFileSync(join(cwd, "staged.txt"), "base staged\n");
  writeFileSync(join(cwd, "unstaged.txt"), "base unstaged\n");
  writeFileSync(join(cwd, ".gitignore"), ".pi/maestro/\ndist/\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");
  return cwd;
}

function attempt(worktreePath: string, branch: string, touchedFile = "shared.txt"): Attempt {
  return {
    index: 1,
    logFile: "executor.jsonl",
    thinking: "low",
    startedAt: Date.now(),
    usage: { input: 0, output: 0, cost: 0, turns: 1 },
    finalReport: "Implemented the requested change",
    touchedFiles: [touchedFile],
    worktreePath,
    branch,
  };
}

function readyTask(cwd: string): Task {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  const task = createTask(board, {
    title: "Change file",
    brief: "Change it",
    tier: "standard",
    writePaths: ["shared.txt"],
    successCriteria: ["shared.txt contains the requested change"],
  });
  forceStatus(task, "ready_for_review");
  saveBoard(cwd, board);
  return task;
}

function recordExecutionFingerprint(
  cwd: string,
  board: Board,
  task: Task,
  config: MaestroConfig = loadConfig(cwd)
): void {
  const latestAttempt = task.attempts.at(-1);
  assert.ok(latestAttempt);
  const fingerprint = taskFingerprint(board, task, config);
  assert.ok(fingerprint);
  latestAttempt.executionFingerprint = fingerprint.fingerprint;
}

function approvingReviewer(cwdSeen: string[]): StartExecutor {
  return (options) => {
    cwdSeen.push(options.cwd);
    const outcome: RunOutcome = {
      exitCode: 0,
      usage: { input: 1, output: 1, cost: 0, turns: 1 },
      finalReport: "Verified tests and implementation.\nVERDICT: APPROVE",
      touchedFiles: [],
      aborted: false,
    };
    const handle: ExecutorHandle = {
      attempt: {
        index: 0,
        logFile: "review.jsonl",
        thinking: "high",
        startedAt: Date.now(),
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
        touchedFiles: [],
      },
      outcome: Promise.resolve(outcome),
      steer: () => {},
      followUp: () => {},
      abort: () => {},
    };
    return handle;
  };
}

async function review(cwd: string, task: Task, cwdSeen: string[]): Promise<void> {
  await reviewTask({
    cwd,
    task,
    tier: { thinking: "high" },
    startExecutor: approvingReviewer(cwdSeen),
    onUpdate: () => {},
    trackRun: () => () => {},
  });
}

test("worktree refs sanitize task ids deterministically", () => {
  const ref = worktreeRef("/repo", "../Feature / A", 2);
  assert.equal(ref.worktreePath, "/repo/.pi/maestro/worktrees/feature-a-attempt-2");
  assert.equal(ref.branch, "maestro/feature-a-attempt-2");
});

test("worktree creation chooses a free name when the base branch already exists", () => {
  const cwd = repository();
  try {
    const existingBranch = "maestro/t1-attempt-1";
    const existingCommit = git(cwd, "rev-parse", "HEAD");
    git(cwd, "branch", existingBranch);

    const ref = createWorktree(cwd, "T1", 1);

    assert.equal(ref.branch, "maestro/t1-attempt-1-2");
    assert.equal(ref.worktreePath, join(cwd, ".pi", "maestro", "worktrees", "t1-attempt-1-2"));
    assert.equal(existsSync(ref.worktreePath), true);
    assert.equal(git(cwd, "rev-parse", existingBranch), existingCommit);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("changed paths preserve the first character for unstaged tracked files", () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, "shared.txt"), "modified\n");
    writeFileSync(join(cwd, "README.md"), "new\n");
    assert.deepEqual(changedPaths(cwd), ["README.md", "shared.txt"]);
    assert.ok(snapshotArtifact(cwd, changedPaths(cwd)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rename attribution preserves both paths through baseline comparison", () => {
  const cwd = repository();
  try {
    const baseline = captureChangeBaseline(cwd);
    assert.ok(baseline);
    git(cwd, "mv", "shared.txt", "renamed.txt");
    assert.deepEqual(changedPaths(cwd), ["renamed.txt", "shared.txt"]);
    assert.deepEqual(changedPathsSinceBaseline(cwd, baseline), ["renamed.txt", "shared.txt"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unstaged renames and staged copies retain source and destination attribution", () => {
  const cwd = repository();
  try {
    renameSync(join(cwd, "shared.txt"), join(cwd, "unstaged-renamed.txt"));
    assert.deepEqual(changedPaths(cwd), ["shared.txt", "unstaged-renamed.txt"]);

    git(cwd, "reset", "--hard", "-q", "HEAD");
    rmSync(join(cwd, "unstaged-renamed.txt"));
    git(cwd, "config", "status.renames", "copies");
    writeFileSync(join(cwd, "shared.txt"), "modified source\n");
    copyFileSync(join(cwd, "shared.txt"), join(cwd, "copied.txt"));
    git(cwd, "add", "shared.txt", "copied.txt");
    assert.deepEqual(changedPaths(cwd), ["copied.txt", "shared.txt"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("artifact snapshots include untracked content and exclude unrelated dirty files", () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, "candidate.txt"), "one\n");
    writeFileSync(join(cwd, "unrelated.txt"), "dirty\n");
    const first = snapshotArtifact(cwd, ["candidate.txt"]);
    const identical = snapshotArtifact(cwd, ["candidate.txt"]);

    writeFileSync(join(cwd, "candidate.txt"), "two\n");
    const changed = snapshotArtifact(cwd, ["candidate.txt"]);

    assert.ok(first);
    assert.equal(first, identical);
    assert.notEqual(first, changed);
    assert.equal(git(cwd, "status", "--porcelain").includes("unrelated.txt"), true);
    assert.equal(snapshotArtifact(cwd, []), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("failed main-tree HEAD CAS leaves the real index byte-for-byte unchanged", () => {
  const cwd = repository();
  let prepared: ReturnType<typeof prepareMainTreeIntegration> | undefined;
  const hook = join(cwd, ".git", "hooks", "reference-transaction");
  try {
    const baseHead = git(cwd, "rev-parse", "HEAD");
    writeFileSync(join(cwd, "shared.txt"), "reviewed\n");
    writeFileSync(join(cwd, "staged.txt"), "user staged\n");
    git(cwd, "add", "staged.txt");
    const stagedBefore = git(cwd, "diff", "--cached", "--", "staged.txt");
    const candidateTree = snapshotArtifact(cwd, ["shared.txt"]);
    assert.ok(candidateTree);
    prepared = prepareMainTreeIntegration(cwd, candidateTree, "fix: reviewed snapshot");
    const indexBefore = readFileSync(join(cwd, ".git", "index"));

    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const result = promotePreparedMainTreeIntegration(cwd, prepared, ["shared.txt"]);

    assert.equal(result.ok, false);
    assert.equal(git(cwd, "rev-parse", "HEAD"), baseHead);
    assert.deepEqual(readFileSync(join(cwd, ".git", "index")), indexBefore);
    assert.equal(git(cwd, "diff", "--cached", "--", "staged.txt"), stagedBefore);
    assert.equal(readFileSync(join(cwd, "shared.txt"), "utf8"), "reviewed\n");
  } finally {
    rmSync(hook, { force: true });
    if (prepared) removePreparedIntegration(cwd, prepared);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("trusted verifier mutation invalidates the candidate before review", async () => {
  const cwd = repository();
  try {
    const task = readyTask(cwd);
    const ref = createWorktree(cwd, task.id, 1);
    writeFileSync(join(ref.worktreePath, "shared.txt"), "candidate\n");
    task.verificationProfile = "mutating";
    task.attempts.push(attempt(ref.worktreePath, ref.branch));
    saveBoard(cwd, { ...loadBoard(cwd), tasks: [task] });
    let reviewerStarts = 0;

    const result = await reviewTask({
      cwd,
      task,
      tier: { thinking: "high" },
      verificationProfiles: {
        mutating: {
          command: `${process.execPath} -e "require('fs').appendFileSync('shared.txt','mutation\\n')"`,
          timeoutSeconds: 5,
        },
      },
      startExecutor: () => {
        reviewerStarts += 1;
        return approvingReviewer([])({} as never);
      },
      onUpdate: () => {},
      trackRun: () => () => {},
    });

    assert.equal(result.status, "ready_for_review");
    assert.equal(
      findTask(loadBoard(cwd), task.id)?.attempts.at(-1)?.reviewConvergence?.status,
      "operational_failure"
    );
    assert.equal(reviewerStarts, 0);
    assert.match(result.note ?? "", /changed during trusted verification/);
    assert.equal(existsSync(ref.worktreePath), false);
    assert.notEqual(git(cwd, "branch", "--list", ref.branch), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("diff capture includes staged task files, excludes unrelated files, and is bounded", () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, "unrelated.txt"), "base\n");
    git(cwd, "add", "unrelated.txt");
    git(cwd, "commit", "-qm", "add unrelated file");
    writeFileSync(join(cwd, "shared.txt"), `${"task change\n".repeat(2_000)}`);
    git(cwd, "add", "shared.txt");
    writeFileSync(join(cwd, "unrelated.txt"), "unrelated change\n");

    const diff = captureDiff(cwd, ["shared.txt"]);

    assert.equal(diff.length, MAX_INJECTED_CONTEXT_LENGTH);
    assert.match(diff, /shared\.txt/);
    assert.doesNotMatch(diff, /unrelated\.txt/);
    assert.equal(captureDiff(cwd, []), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("orphan sweep is idempotent and preserves retained recovery worktrees", () => {
  const cwd = repository();
  try {
    const retained = createWorktree(cwd, "T1", 1);
    const stale = createWorktree(cwd, "T2", 1);
    sweepWorktrees(cwd, [retained], [retained, stale]);
    sweepWorktrees(cwd, [retained], [retained, stale]);

    assert.equal(existsSync(retained.worktreePath), true);
    assert.equal(existsSync(stale.worktreePath), false);
    assert.equal(git(cwd, "branch", "--list", retained.branch).trim(), `+ ${retained.branch}`);
    assert.equal(git(cwd, "branch", "--list", stale.branch), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("startup sweep preserves dirty and branch-ahead orphan worktrees", () => {
  const cwd = repository();
  try {
    const dirty = createWorktree(cwd, "dirty-orphan", 1);
    writeFileSync(join(dirty.worktreePath, "shared.txt"), "recoverable uncommitted work\n");

    const ahead = createWorktree(cwd, "ahead-orphan", 1);
    writeFileSync(join(ahead.worktreePath, "ahead.txt"), "recoverable committed work\n");
    git(ahead.worktreePath, "add", "ahead.txt");
    git(ahead.worktreePath, "commit", "-qm", "orphan work");

    const stale = createWorktree(cwd, "stale-orphan", 1);

    sweepWorktrees(cwd, []);

    assert.equal(
      readFileSync(join(dirty.worktreePath, "shared.txt"), "utf-8"),
      "recoverable uncommitted work\n"
    );
    assert.equal(
      readFileSync(join(ahead.worktreePath, "ahead.txt"), "utf-8"),
      "recoverable committed work\n"
    );
    assert.equal(existsSync(stale.worktreePath), false);
    assert.equal(git(cwd, "branch", "--list", stale.branch), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("idle worktrees are checkpointed, removed, and restored only when needed", () => {
  const cwd = repository();
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const task = createTask(board, { title: "Task", brief: "Change it", tier: "standard" });
    forceStatus(task, "failed");
    const ref = createWorktree(cwd, task.id, 1);
    writeFileSync(join(ref.worktreePath, "shared.txt"), "recoverable work\n");
    task.attempts.push(attempt(ref.worktreePath, ref.branch));

    const parking = parkInactiveWorktrees(cwd, board);

    assert.deepEqual(parking.warnings, []);
    assert.deepEqual(parking.parked, [ref]);
    assert.equal(existsSync(ref.worktreePath), false);
    assert.notEqual(git(cwd, "branch", "--list", ref.branch), "");
    assert.equal(worktreeRecoveryExists(cwd, ref), true);
    assert.doesNotMatch(git(cwd, "worktree", "list", "--porcelain"), new RegExp(ref.worktreePath));

    restoreWorktree(cwd, ref);
    assert.equal(readFileSync(join(ref.worktreePath, "shared.txt"), "utf-8"), "recoverable work\n");
    assert.equal(changedPaths(ref.worktreePath).length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("orphan parking uses the branch registered by Git", () => {
  const cwd = repository();
  try {
    const worktreePath = join(cwd, ".pi", "maestro", "worktrees", "recovered-task");
    const branch = "recovery/recovered-task";
    git(cwd, "worktree", "add", "-b", branch, worktreePath, "HEAD");
    writeFileSync(join(worktreePath, "shared.txt"), "recovered work\n");

    const parking = parkInactiveWorktrees(cwd, {
      version: 1,
      nextTaskNumber: 1,
      tasks: [],
    });

    assert.deepEqual(parking.warnings, []);
    assert.equal(parking.parked[0]?.branch, branch);
    assert.equal(existsSync(worktreePath), false);
    assert.notEqual(git(cwd, "branch", "--list", branch), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("idle clean worktrees and branches are removed completely", () => {
  const cwd = repository();
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const task = createTask(board, { title: "Task", brief: "No changes", tier: "standard" });
    forceStatus(task, "cancelled");
    const ref = createWorktree(cwd, task.id, 1);
    task.attempts.push(attempt(ref.worktreePath, ref.branch));

    const parking = parkInactiveWorktrees(cwd, board);

    assert.deepEqual(parking.warnings, []);
    assert.deepEqual(parking.removed, [ref]);
    assert.equal(existsSync(ref.worktreePath), false);
    assert.equal(git(cwd, "branch", "--list", ref.branch), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("managed worktree inspection distinguishes protected and cleanup states", () => {
  const cwd = repository();
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const specs: { status: Task["status"]; notes?: string }[] = [
      { status: "running" },
      { status: "ready_for_review" },
      { status: "changes_requested", notes: "Approved review hit a git conflict" },
      { status: "approved" },
    ];
    for (const [index, spec] of specs.entries()) {
      const task = createTask(board, {
        title: `Task ${index + 1}`,
        brief: "Change it",
        tier: "standard",
      });
      forceStatus(task, spec.status);
      if (spec.notes) task.reviewNotes = spec.notes;
      const ref = createWorktree(cwd, task.id, 1);
      task.attempts.push(attempt(ref.worktreePath, ref.branch));
    }
    createWorktree(cwd, "orphan", 1);

    const entries = inspectManagedWorktrees(cwd, board);

    assert.deepEqual(
      entries.map((entry) => entry.state).sort(),
      ["active", "recoverable", "retained-conflict", "stale", "orphaned"].sort()
    );
    assert.equal(
      entries.every((entry) => entry.exists),
      true
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("inspection reports missing managed checkouts from stale metadata", () => {
  const cwd = repository();
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const task = createTask(board, { title: "Task", brief: "Change it", tier: "standard" });
    forceStatus(task, "approved");
    const ref = worktreeRef(cwd, task.id, 1);
    task.attempts.push(attempt(ref.worktreePath, ref.branch));

    const entries = inspectManagedWorktrees(cwd, board);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.state, "stale");
    assert.equal(entries[0]?.exists, false);
    assert.match(entries[0]?.reason ?? "", /checkout is missing/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("orphan with uncommitted work is classified recoverable and preserved on cleanup", () => {
  const cwd = repository();
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const orphan = createWorktree(cwd, "orphan-dirty", 1);
    writeFileSync(join(orphan.worktreePath, "shared.txt"), "uncommitted work\n");

    const entries = inspectManagedWorktrees(cwd, board);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.state, "recoverable");

    const cleaned = cleanupManagedWorktrees(
      cwd,
      new Set([orphan.worktreePath]),
      () => board,
      () => false
    );
    assert.equal(cleaned.removed.length, 0);
    assert.equal(existsSync(orphan.worktreePath), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cleanup ignores paths that appeared after confirmation", () => {
  const cwd = repository();
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const confirmed = createWorktree(cwd, "confirmed", 1);
    const appeared = createWorktree(cwd, "appeared", 1);

    const result = cleanupManagedWorktrees(
      cwd,
      new Set([confirmed.worktreePath]),
      () => board,
      () => false
    );

    assert.deepEqual(
      result.removed.map((entry) => entry.ref.worktreePath),
      [confirmed.worktreePath]
    );
    assert.equal(existsSync(confirmed.worktreePath), false);
    assert.equal(existsSync(appeared.worktreePath), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("confirmed cleanup removes only stale and orphaned worktrees", () => {
  const cwd = repository();
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const recoverableTask = createTask(board, {
      title: "Recoverable",
      brief: "Change it",
      tier: "standard",
    });
    forceStatus(recoverableTask, "ready_for_review");
    const recoverable = createWorktree(cwd, recoverableTask.id, 1);
    recoverableTask.attempts.push(attempt(recoverable.worktreePath, recoverable.branch));

    const staleTask = createTask(board, {
      title: "Settled",
      brief: "Change it",
      tier: "standard",
    });
    forceStatus(staleTask, "approved");
    const stale = createWorktree(cwd, staleTask.id, 1);
    staleTask.attempts.push(attempt(stale.worktreePath, stale.branch));
    const orphaned = createWorktree(cwd, "orphan", 1);

    const confirmedPaths = new Set([stale.worktreePath, orphaned.worktreePath]);
    const cancelled = cleanupManagedWorktrees(
      cwd,
      new Set<string>(),
      () => board,
      () => false
    );
    assert.equal(cancelled.confirmed, false);
    assert.equal(cancelled.removed.length, 0);
    assert.equal(existsSync(stale.worktreePath), true);
    assert.equal(existsSync(orphaned.worktreePath), true);

    const cleaned = cleanupManagedWorktrees(
      cwd,
      confirmedPaths,
      () => board,
      () => false
    );
    assert.deepEqual(cleaned.removed.map((entry) => entry.state).sort(), ["orphaned", "stale"]);
    assert.equal(existsSync(recoverable.worktreePath), true);
    assert.equal(existsSync(stale.worktreePath), false);
    assert.equal(existsSync(orphaned.worktreePath), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cleanup rechecks live and newly recoverable worktrees before removal", () => {
  const cwd = repository();
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const task = createTask(board, { title: "Task", brief: "Change it", tier: "standard" });
    forceStatus(task, "approved");
    const ref = createWorktree(cwd, task.id, 1);
    task.attempts.push(attempt(ref.worktreePath, ref.branch));

    const confirmedPaths = new Set([ref.worktreePath]);
    const liveResult = cleanupManagedWorktrees(
      cwd,
      confirmedPaths,
      () => board,
      () => true
    );
    assert.equal(liveResult.removed.length, 0);
    assert.equal(liveResult.preserved[0]?.state, "active");
    assert.equal(existsSync(ref.worktreePath), true);

    forceStatus(task, "approved");
    const recoveryResult = cleanupManagedWorktrees(
      cwd,
      confirmedPaths,
      () => {
        // The task became recoverable between confirmation and the pre-removal recheck.
        forceStatus(task, "ready_for_review");
        return board;
      },
      () => false
    );
    assert.equal(recoveryResult.removed.length, 0);
    assert.equal(recoveryResult.preserved[0]?.state, "recoverable");
    assert.equal(existsSync(ref.worktreePath), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("manual approval parks its completed worktree", () => {
  const cwd = repository();
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const task = createTask(board, {
      title: "Manual task",
      brief: "Change the file",
      tier: "standard",
      writePaths: ["shared.txt"],
      successCriteria: ["shared.txt changes"],
    });
    forceStatus(task, "ready_for_review");
    const ref = createWorktree(cwd, task.id, 1);
    writeFileSync(join(ref.worktreePath, "shared.txt"), "manual change\n");
    const completed = attempt(ref.worktreePath, ref.branch);
    completed.endedAt = Date.now();
    task.attempts.push(completed);
    saveBoard(cwd, board);

    const approved = manuallyApproveTask({ cwd } as never, task.id);

    assert.equal(approved.status, "approved");
    assert.equal(approved.approvalKind, "manual");
    assert.equal(existsSync(ref.worktreePath), false);
    assert.notEqual(git(cwd, "branch", "--list", ref.branch), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("approved review uses its worktree, merges it, then removes worktree and branch", async () => {
  const cwd = repository();
  try {
    const task = readyTask(cwd);
    const ref = createWorktree(cwd, task.id, 1);
    writeFileSync(join(ref.worktreePath, "shared.txt"), "executor change\n");
    task.attempts.push(attempt(ref.worktreePath, ref.branch));
    const board = { ...loadBoard(cwd), tasks: [task] };
    recordExecutionFingerprint(cwd, board, task);
    saveBoard(cwd, board);
    const parking = parkInactiveWorktrees(cwd, board);
    assert.deepEqual(parking.warnings, []);
    assert.equal(existsSync(ref.worktreePath), false);
    writeFileSync(join(cwd, "staged.txt"), "user staged\n");
    git(cwd, "add", "staged.txt");
    writeFileSync(join(cwd, "unstaged.txt"), "user unstaged\n");
    writeFileSync(join(cwd, "untracked.txt"), "user untracked\n");
    const stagedDiff = gitBytes(cwd, "diff", "--cached", "--", "staged.txt");
    const unstagedDiff = gitBytes(cwd, "diff", "--", "unstaged.txt");

    const cwdSeen: string[] = [];
    await review(cwd, task, cwdSeen);

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.deepEqual(cwdSeen, [ref.worktreePath]);
    assert.equal(persisted?.status, "approved");
    assert.ok(persisted?.provenance?.candidateTree);
    assert.ok(persisted?.provenance?.reviewedAt);
    assert.equal(persisted?.provenance?.integratedCommit, git(cwd, "rev-parse", "HEAD"));
    assert.equal(readFileSync(join(cwd, "shared.txt"), "utf-8"), "executor change\n");
    assert.equal(gitBytes(cwd, "diff", "--cached", "--", "staged.txt"), stagedDiff);
    assert.equal(gitBytes(cwd, "diff", "--", "unstaged.txt"), unstagedDiff);
    assert.equal(readFileSync(join(cwd, "untracked.txt"), "utf-8"), "user untracked\n");
    assert.equal(existsSync(ref.worktreePath), false);
    assert.equal(git(cwd, "branch", "--list", ref.branch), "");
    assertNoPreparedIntegration(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("post-integration verification may create ignored disposable output", async () => {
  const cwd = repository();
  try {
    const task = readyTask(cwd);
    const ref = createWorktree(cwd, task.id, 1);
    writeFileSync(join(ref.worktreePath, "shared.txt"), "executor change\n");
    task.verificationProfile = "build";
    task.attempts.push(attempt(ref.worktreePath, ref.branch));
    const board = { ...loadBoard(cwd), tasks: [task] };
    const verificationProfiles = {
      build: {
        command: `${process.execPath} -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/result.txt','generated')"`,
        timeoutSeconds: 5,
      },
    };
    recordExecutionFingerprint(cwd, board, task, { ...loadConfig(cwd), verificationProfiles });
    saveBoard(cwd, board);

    const result = await reviewTask({
      cwd,
      task,
      tier: { thinking: "high" },
      verificationProfiles,
      startExecutor: approvingReviewer([]),
      onUpdate: () => {},
      trackRun: () => () => {},
    });

    assert.equal(result.status, "approved", result.note);
    assert.equal(readFileSync(join(cwd, "shared.txt"), "utf-8"), "executor change\n");
    assert.equal(existsSync(join(cwd, "dist", "result.txt")), false);
    assertNoPreparedIntegration(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("failed post-integration verification parks the recovery worktree", async () => {
  const cwd = repository();
  try {
    const task = readyTask(cwd);
    const originalHead = git(cwd, "rev-parse", "HEAD");
    const ref = createWorktree(cwd, task.id, 1);
    writeFileSync(join(ref.worktreePath, "shared.txt"), "executor change\n");
    task.verificationProfile = "required";
    task.attempts.push(attempt(ref.worktreePath, ref.branch));
    const board = { ...loadBoard(cwd), tasks: [task] };
    const verificationProfiles = {
      required: {
        command: `${process.execPath} -e "process.exit(2)"`,
        timeoutSeconds: 5,
      },
    };
    recordExecutionFingerprint(cwd, board, task, { ...loadConfig(cwd), verificationProfiles });
    saveBoard(cwd, board);
    writeFileSync(join(cwd, "staged.txt"), "user staged\n");
    git(cwd, "add", "staged.txt");
    writeFileSync(join(cwd, "unstaged.txt"), "user unstaged\n");
    writeFileSync(join(cwd, "untracked.txt"), "user untracked\n");
    const originalIndex = git(cwd, "write-tree");
    const originalStatus = gitBytes(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all");
    const stagedBytes = readFileSync(join(cwd, "staged.txt"));
    const unstagedBytes = readFileSync(join(cwd, "unstaged.txt"));
    const untrackedBytes = readFileSync(join(cwd, "untracked.txt"));

    const result = await reviewTask({
      cwd,
      task,
      tier: { thinking: "high" },
      verificationProfiles,
      startExecutor: approvingReviewer([]),
      onUpdate: () => {},
      trackRun: () => () => {},
    });

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.equal(result.status, "ready_for_review");
    assert.equal(persisted?.attempts.at(-1)?.reviewConvergence?.status, "operational_failure");
    assert.equal(persisted?.provenance?.integratedCommit, undefined);
    assert.equal(persisted?.integratedCommit, undefined);
    assert.equal(git(cwd, "rev-parse", "HEAD"), originalHead);
    assert.equal(git(cwd, "write-tree"), originalIndex);
    assert.equal(
      gitBytes(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
      originalStatus
    );
    assert.deepEqual(readFileSync(join(cwd, "staged.txt")), stagedBytes);
    assert.deepEqual(readFileSync(join(cwd, "unstaged.txt")), unstagedBytes);
    assert.deepEqual(readFileSync(join(cwd, "untracked.txt")), untrackedBytes);
    assert.equal(existsSync(ref.worktreePath), false);
    assert.notEqual(git(cwd, "branch", "--list", ref.branch), "");
    assertNoPreparedIntegration(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("concurrent approved reviews serialize merges and clean up both worktrees", async () => {
  const cwd = repository();
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const first = createTask(board, {
      title: "Add first file",
      brief: "Add first.txt",
      tier: "standard",
      writePaths: ["first.txt"],
      successCriteria: ["first.txt is added"],
    });
    const second = createTask(board, {
      title: "Add second file",
      brief: "Add second.txt",
      tier: "standard",
      writePaths: ["second.txt"],
      successCriteria: ["second.txt is added"],
    });
    forceStatus(first, "ready_for_review");
    forceStatus(second, "ready_for_review");

    const firstRef = createWorktree(cwd, first.id, 1);
    const secondRef = createWorktree(cwd, second.id, 1);
    writeFileSync(join(firstRef.worktreePath, "first.txt"), "first\n");
    writeFileSync(join(secondRef.worktreePath, "second.txt"), "second\n");
    first.attempts.push(attempt(firstRef.worktreePath, firstRef.branch, "first.txt"));
    second.attempts.push(attempt(secondRef.worktreePath, secondRef.branch, "second.txt"));
    recordExecutionFingerprint(cwd, board, first);
    recordExecutionFingerprint(cwd, board, second);
    saveBoard(cwd, board);

    const cwdSeen: string[] = [];
    await Promise.all([review(cwd, first, cwdSeen), review(cwd, second, cwdSeen)]);

    const persisted = loadBoard(cwd);
    assert.equal(findTask(persisted, first.id)?.status, "approved");
    assert.equal(findTask(persisted, second.id)?.status, "approved");
    assert.deepEqual(new Set(cwdSeen), new Set([firstRef.worktreePath, secondRef.worktreePath]));
    assert.equal(readFileSync(join(cwd, "first.txt"), "utf-8"), "first\n");
    assert.equal(readFileSync(join(cwd, "second.txt"), "utf-8"), "second\n");
    for (const ref of [firstRef, secondRef]) {
      assert.equal(existsSync(ref.worktreePath), false);
      assert.equal(git(cwd, "branch", "--list", ref.branch), "");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("merge conflict aborts and retains recoverable worktree metadata and notes", async () => {
  const cwd = repository();
  try {
    const task = readyTask(cwd);
    const ref = createWorktree(cwd, task.id, 1);
    writeFileSync(join(ref.worktreePath, "shared.txt"), "executor change\n");
    task.attempts.push(attempt(ref.worktreePath, ref.branch));
    const board = { ...loadBoard(cwd), tasks: [task] };
    recordExecutionFingerprint(cwd, board, task);
    saveBoard(cwd, board);

    writeFileSync(join(cwd, "shared.txt"), "main change\n");
    git(cwd, "add", "shared.txt");
    git(cwd, "commit", "-qm", "main change");
    writeFileSync(join(cwd, "unstaged.txt"), "user dirt\n");
    writeFileSync(join(cwd, "untracked.txt"), "untracked dirt\n");
    const originalHead = git(cwd, "rev-parse", "HEAD");
    const originalIndex = git(cwd, "write-tree");
    const originalStatus = gitBytes(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all");
    const unstagedBytes = readFileSync(join(cwd, "unstaged.txt"));
    const untrackedBytes = readFileSync(join(cwd, "untracked.txt"));

    const cwdSeen: string[] = [];
    await review(cwd, task, cwdSeen);

    const persisted = findTask(loadBoard(cwd), task.id);
    assert.deepEqual(cwdSeen, [ref.worktreePath]);
    assert.equal(persisted?.status, "ready_for_review");
    assert.equal(persisted?.attempts.at(-1)?.reviewConvergence?.status, "operational_failure");
    assert.match(persisted?.reviewNotes ?? "", /git conflict/i);
    assert.match(
      persisted?.reviewNotes ?? "",
      new RegExp(ref.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    assert.equal(existsSync(ref.worktreePath), false);
    assert.equal(git(cwd, "branch", "--list", ref.branch).trim(), ref.branch);
    assert.equal(existsSync(join(cwd, ".git", "MERGE_HEAD")), false);
    assert.equal(readFileSync(join(cwd, "shared.txt"), "utf-8"), "main change\n");
    assert.equal(git(cwd, "rev-parse", "HEAD"), originalHead);
    assert.equal(git(cwd, "write-tree"), originalIndex);
    assert.equal(
      gitBytes(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
      originalStatus
    );
    assert.deepEqual(readFileSync(join(cwd, "unstaged.txt")), unstagedBytes);
    assert.deepEqual(readFileSync(join(cwd, "untracked.txt")), untrackedBytes);
    assertNoPreparedIntegration(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("maestro commits succeed when the user requires GPG signing they cannot perform", () => {
  const cwd = repository();
  try {
    // Exactly the reported setup: signing is on, but the key cannot be used
    // non-interactively — away from the signing machine, with no pinentry.
    // Plain `git commit` fails (or worse, blocks on a prompt) here.
    git(cwd, "config", "commit.gpgsign", "true");
    git(cwd, "config", "user.signingkey", "DEADBEEFDEADBEEF");
    writeFileSync(join(cwd, "shared.txt"), "executor change\n");

    assert.equal(commitAll(cwd, "chore(maestro): checkpoint"), true);
    assert.equal(changedPaths(cwd).length, 0, "the checkpoint must actually land");
    assert.match(git(cwd, "log", "-1", "--pretty=%s"), /chore\(maestro\): checkpoint/);
    // The commit exists and is simply unsigned; the user's own commits are
    // unaffected because only maestro's own git invocations pass --no-gpg-sign.
    assert.equal(git(cwd, "log", "-1", "--pretty=%G?"), "N");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("reviewed integration completes under mandatory GPG signing", () => {
  const cwd = repository();
  try {
    git(cwd, "config", "commit.gpgsign", "true");
    git(cwd, "config", "user.signingkey", "DEADBEEFDEADBEEF");
    writeFileSync(join(cwd, "shared.txt"), "reviewed change\n");
    const tree = snapshotArtifact(cwd, ["shared.txt"]);
    assert.ok(tree);

    // commit-tree and the fast-forward merge both honor commit.gpgsign, so
    // both had to stop signing for integration to survive this config.
    const prepared = prepareMainTreeIntegration(cwd, tree, "feat: reviewed work");
    const promoted = promotePreparedMainTreeIntegration(cwd, prepared, ["shared.txt"]);
    removePreparedIntegration(cwd, prepared);

    assert.equal(promoted.ok, true, promoted.error);
    assert.match(git(cwd, "log", "-1", "--pretty=%s"), /feat: reviewed work/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("uncommitted paths invisible to isolated checkouts are reported", () => {
  const cwd = repository();
  try {
    // A plan document the user can see but has not committed. `worktree add`
    // checks out a commit, so an executor never sees this file and reports
    // itself blocked on something that plainly exists in the main checkout.
    writeFileSync(join(cwd, "plan-012.md"), "# Plan 012\n");
    writeFileSync(join(cwd, "shared.txt"), "local edit\n");
    // Maestro's own runtime state is not user content and must not be listed.
    mkdirSync(join(cwd, ".pi", "maestro"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "maestro", "board.json"), "{}\n");

    const invisible = uncommittedPathsInvisibleToWorktrees(cwd);
    assert.ok(invisible.includes("plan-012.md"), JSON.stringify(invisible));
    assert.ok(invisible.includes("shared.txt"), JSON.stringify(invisible));
    assert.equal(
      invisible.some((path) => path.startsWith(".pi/maestro")),
      false,
      "maestro runtime state is not user content"
    );

    const ref = createWorktree(cwd, "T1", 1);
    assert.equal(existsSync(join(ref.worktreePath, "plan-012.md")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("worktree merge integration completes under mandatory GPG signing", () => {
  const cwd = repository();
  try {
    const ref = createWorktree(cwd, "T1", 1);
    writeFileSync(join(ref.worktreePath, "shared.txt"), "worktree change\n");
    // Advance the main branch so integration needs a real merge commit rather
    // than a fast-forward; a merge commit is signed when commit.gpgsign is set.
    writeFileSync(join(cwd, "staged.txt"), "main moved\n");
    git(cwd, "commit", "-qam", "main moves ahead");
    git(cwd, "config", "commit.gpgsign", "true");
    git(cwd, "config", "user.signingkey", "DEADBEEFDEADBEEF");

    const merged = mergeWorktree(cwd, ref, "feat: merged work");

    assert.equal(merged.ok, true, merged.error);
    assert.match(readFileSync(join(cwd, "shared.txt"), "utf-8"), /worktree change/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parking preserves a checkout whose work cannot be checkpointed", () => {
  const cwd = repository();
  try {
    const ref = createWorktree(cwd, "T1", 1);
    writeFileSync(join(ref.worktreePath, "shared.txt"), "irreplaceable executor work\n");
    // Make the checkpoint commit fail the way a broken commit configuration
    // does. The checkpoint is the only copy of this work, so parking must not
    // proceed to force-remove the checkout and delete its branch.
    git(ref.worktreePath, "config", "core.hooksPath", ".githooks");
    mkdirSync(join(ref.worktreePath, ".githooks"), { recursive: true });
    const hook = join(ref.worktreePath, ".githooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    assert.throws(() => parkWorktree(cwd, ref), /refusing to remove/);

    // The work survived: both the checkout and its content are still present.
    assert.equal(existsSync(ref.worktreePath), true);
    assert.match(readFileSync(join(ref.worktreePath, "shared.txt"), "utf-8"), /irreplaceable/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
