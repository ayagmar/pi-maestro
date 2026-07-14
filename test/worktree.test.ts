import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { taskFingerprint } from "../src/artifact-policy.js";
import { createTask, findTask, forceStatus, loadBoard, saveBoard } from "../src/board.js";
import { loadConfig } from "../src/config.js";
import { MAX_INJECTED_CONTEXT_LENGTH } from "../src/prompts.js";
import { type ExecutorHandle, type RunOutcome } from "../src/runner.js";
import { type Attempt, type Board, type MaestroConfig, type Task } from "../src/types.js";
import { reviewTask, type StartExecutor } from "../src/workflow.js";
import {
  captureDiff,
  changedPaths,
  cleanupManagedWorktrees,
  createWorktree,
  inspectManagedWorktrees,
  snapshotArtifact,
  sweepWorktrees,
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
    assert.equal(existsSync(ref.worktreePath), true);
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

test("failed post-integration verification retains the recovery worktree", async () => {
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
    assert.equal(existsSync(ref.worktreePath), true);
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
    assert.equal(existsSync(ref.worktreePath), true);
    assert.equal(git(cwd, "branch", "--list", ref.branch).trim(), `+ ${ref.branch}`);
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
