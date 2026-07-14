import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureApprovedProvenance } from "../src/artifact-policy.js";
import { listArchivedBoards, loadBoard, saveBoard, updateBoard } from "../src/board.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";
import {
  cleanupCompletedBoard,
  clearActiveDrive,
  deliverPendingDecision,
  persistActiveDrive,
  persistDriveDecision,
  resolveDriveDecision,
} from "../src/drive-controller.js";
import { type Board, type DriveDecision } from "../src/types.js";

const owner = "/tmp/maestro-owner.jsonl";

function decision(overrides: Partial<DriveDecision> = {}): DriveDecision {
  return {
    id: "decision-1",
    ownerSession: owner,
    kind: "blocked",
    taskIds: [],
    evidence: "Owner action is required",
    allowedInterventions: ["handoff"],
    createdAt: Date.now(),
    ...overrides,
  };
}

function withBoard(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-drive-controller-test-"));
  try {
    saveConfig("project", cwd, { ...DEFAULT_CONFIG, autoCommit: false });
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("updateBoard returns the mutation result and does not persist thrown mutations", () => {
  withBoard((cwd) => {
    saveBoard(cwd, { version: 1, nextTaskNumber: 1, tasks: [] });

    const result = updateBoard(cwd, (board) => {
      board.goal = "saved";
      return "result";
    });
    assert.equal(result, "result");
    assert.equal(loadBoard(cwd).goal, "saved");

    assert.throws(() =>
      updateBoard(cwd, (board) => {
        board.goal = "discarded";
        throw new Error("invalid transaction");
      })
    );
    assert.equal(loadBoard(cwd).goal, "saved");
  });
});

test("decision delivery is owner-strict and serializes reentrant delivery", () => {
  withBoard((cwd) => {
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      tasks: [],
      activeDecision: decision(),
    });

    const delivered: string[] = [];
    deliverPendingDecision(cwd, undefined, (evidence) => delivered.push(evidence));
    deliverPendingDecision(cwd, "/tmp/foreign.jsonl", (evidence) => delivered.push(evidence));
    assert.equal(delivered.length, 0);

    deliverPendingDecision(cwd, owner, (evidence) => {
      delivered.push(evidence);
      deliverPendingDecision(cwd, owner, (nested) => delivered.push(nested));
    });

    assert.deepEqual(delivered, ["Owner action is required"]);
    assert.ok(loadBoard(cwd).activeDecision?.deliveredAt);
    assert.equal(loadBoard(cwd).activeDecision?.deliveryClaim, undefined);
  });
});

test("failed and stale delivery claims remain retryable", () => {
  withBoard((cwd) => {
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      tasks: [],
      activeDecision: decision({
        deliveryClaim: { id: "abandoned", claimedAt: Date.now() - 31_000 },
      }),
    });

    deliverPendingDecision(cwd, owner, () => {
      throw new Error("temporary send failure");
    });
    assert.equal(loadBoard(cwd).activeDecision?.deliveredAt, undefined);
    assert.equal(loadBoard(cwd).activeDecision?.deliveryClaim, undefined);

    const delivered: string[] = [];
    deliverPendingDecision(cwd, owner, (evidence) => delivered.push(evidence));
    assert.deepEqual(delivered, ["Owner action is required"]);
  });
});

test("decision resolution is owner-strict and stale attempts do not mutate the board", () => {
  withBoard((cwd) => {
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      tasks: [],
      activeDecision: decision(),
    });
    const revision = loadBoard(cwd).revision;

    assert.throws(
      () => resolveDriveDecision(cwd, "decision-1", undefined, "handoff"),
      /Only the decision owner/
    );
    assert.equal(loadBoard(cwd).revision, revision);

    const resolved = resolveDriveDecision(cwd, "decision-1", owner, "handoff");
    assert.equal(resolved.resolution?.intervention, "handoff");
    assert.throws(
      () => resolveDriveDecision(cwd, "decision-1", owner, "handoff"),
      /stale or already resolved/
    );
  });
});

test("active drive state clears only when the durable identity matches", () => {
  withBoard((cwd) => {
    saveBoard(cwd, { version: 1, nextTaskNumber: 1, tasks: [] });
    persistActiveDrive(cwd, {
      id: "drive-1",
      ownerSession: owner,
      taskIds: ["T1"],
      startedAt: Date.now(),
    });

    assert.equal(clearActiveDrive(cwd, "drive-2"), false);
    assert.equal(loadBoard(cwd).activeDrive?.id, "drive-1");
    assert.equal(clearActiveDrive(cwd, "drive-1"), true);
    assert.equal(loadBoard(cwd).activeDrive, undefined);
  });
});

test("active drive reservation cannot replace a foreign active or paused owner", () => {
  withBoard((cwd) => {
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      activeDrive: { id: "drive-owner", ownerSession: owner, startedAt: 1 },
      tasks: [],
    });

    assert.equal(
      persistActiveDrive(cwd, {
        id: "drive-foreign",
        ownerSession: "/tmp/foreign.jsonl",
        startedAt: 2,
      }),
      false
    );
    assert.equal(loadBoard(cwd).activeDrive?.id, "drive-owner");

    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      pausedDrive: { ownerSession: owner, taskIds: ["T1"] },
      tasks: [],
    });
    assert.equal(
      persistActiveDrive(cwd, {
        id: "drive-foreign",
        ownerSession: "/tmp/foreign.jsonl",
        startedAt: 2,
      }),
      false
    );
    assert.equal(loadBoard(cwd).pausedDrive?.ownerSession, owner);
    assert.equal(loadBoard(cwd).activeDrive, undefined);
  });
});

test("starting corrected work resolves the stale decision in the active-drive transaction", () => {
  withBoard((cwd) => {
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      activeDecision: decision({
        deliveryClaim: { id: "pending-send", claimedAt: Date.now() },
      }),
      tasks: [],
    });

    persistActiveDrive(cwd, {
      id: "drive-1",
      ownerSession: owner,
      startedAt: Date.now(),
    });

    const board = loadBoard(cwd);
    assert.equal(board.activeDrive?.id, "drive-1");
    assert.equal(board.activeDecision?.resolution?.intervention, "resume");
    assert.equal(board.activeDecision?.deliveryClaim, undefined);
  });
});

test("only the current drive can replace its claim with a terminal decision", () => {
  withBoard((cwd) => {
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      activeDrive: { id: "drive-current", ownerSession: owner, startedAt: Date.now() },
      tasks: [],
    });
    const summary = {
      rounds: 0,
      tasks: [],
      stoppedBecause: { code: "error" as const, message: "setup failed" },
    };

    assert.equal(persistDriveDecision(cwd, owner, summary, "stale callback", "drive-stale"), false);
    assert.equal(loadBoard(cwd).activeDecision, undefined);
    assert.equal(loadBoard(cwd).activeDrive?.id, "drive-current");

    assert.equal(
      persistDriveDecision(cwd, owner, summary, "current callback", "drive-current"),
      true
    );
    assert.equal(loadBoard(cwd).activeDecision?.evidence, "current callback");
    assert.equal(loadBoard(cwd).activeDrive, undefined);
  });
});

test("completed-board cleanup preserves terminal decision and ownership evidence", () => {
  withBoard((cwd) => {
    const board: Board = {
      version: 1,
      nextTaskNumber: 2,
      ownerSessions: [owner],
      activeDecision: decision({ kind: "completed", allowedInterventions: [] }),
      activeDrive: { id: "drive-1", ownerSession: owner, startedAt: Date.now() },
      tasks: [
        {
          id: "T1",
          title: "Complete",
          brief: "Already complete",
          tier: "standard",
          status: "approved",
          dependsOn: [],
          attempts: [
            {
              index: 1,
              logFile: "completed.jsonl",
              thinking: "medium",
              startedAt: 1,
              endedAt: 2,
              usage: { input: 1, output: 1, cost: 0, turns: 1 },
              finalReport: "Completed with durable evidence",
              touchedFiles: [],
            },
          ],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    };
    const task = board.tasks[0];
    assert.ok(task);
    const proof = captureApprovedProvenance(board, task, DEFAULT_CONFIG);
    assert.ok(proof);
    task.approvedProvenance = proof;
    saveBoard(cwd, board);

    cleanupCompletedBoard(cwd);

    const cleaned = loadBoard(cwd);
    assert.deepEqual(cleaned.tasks, []);
    assert.deepEqual(cleaned.ownerSessions, [owner]);
    assert.equal(cleaned.activeDecision?.id, "decision-1");
    assert.equal(cleaned.activeDrive?.id, "drive-1");
    assert.equal(listArchivedBoards(cwd).length, 1);
  });
});
