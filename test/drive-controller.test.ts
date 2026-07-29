import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureApprovedProvenance } from "../src/artifact-policy.js";
import { createTask, listArchivedBoards, loadBoard, saveBoard, updateBoard } from "../src/board.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";
import {
  armDeliveredDecisionNudge,
  cleanupCompletedBoard,
  clearActiveDrive,
  DriveRuntimeController,
  deliverPendingDecision,
  type LiveRun,
  persistActiveDrive,
  persistDriveDecision,
  resolveDriveDecision,
} from "../src/drive-controller.js";
import { startDriveHeartbeat } from "../src/drive-summary.js";
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

test("live-run cleanup cannot remove an overlapping replacement run", () => {
  const controller = new DriveRuntimeController();
  const executor = { taskId: "T1", kind: "execute" } as unknown as LiveRun;
  const reviewer = { taskId: "T1", kind: "review" } as unknown as LiveRun;

  controller.registerLiveRun(executor);
  controller.registerLiveRun(reviewer);
  assert.equal(controller.liveRunCount(), 2);
  assert.equal(controller.getLiveRun("T1"), reviewer);
  assert.equal(controller.getLiveRun("T1", "execute"), executor);
  assert.equal(controller.getLiveRun("T1", "review"), reviewer);

  controller.removeLiveRun(executor);
  assert.equal(controller.liveRunCount(), 1);
  assert.equal(controller.getLiveRun("T1"), reviewer);
  assert.equal(controller.isTaskLive("T1"), true);
});

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
      }).ok,
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
      }).ok,
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

test("completed-board cleanup archives all-cancelled settled work", () => {
  withBoard((cwd) => {
    const board: Board = {
      version: 1,
      nextTaskNumber: 1,
      goal: "cancelled scope",
      tasks: [],
    };
    const first = createTask(board, { title: "First", brief: "cancelled", tier: "standard" });
    const second = createTask(board, { title: "Second", brief: "cancelled", tier: "standard" });
    first.status = "cancelled";
    second.status = "cancelled";
    saveBoard(cwd, board);

    cleanupCompletedBoard(cwd);

    const cleaned = loadBoard(cwd);
    assert.deepEqual(cleaned.tasks, []);
    assert.equal(cleaned.goal, undefined);
    const [archive] = listArchivedBoards(cwd);
    assert.ok(archive);
    assert.equal(archive.taskCount, 2);
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

test("drive heartbeat pulses live agents, spend, and status deltas without waking the model", () => {
  withBoard((cwd) => {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    createTask(board, { title: "Streaming", brief: "work", tier: "standard" });
    saveBoard(cwd, board);

    const attempt = {
      index: 1,
      logFile: "run.jsonl",
      thinking: "low" as const,
      startedAt: Date.now(),
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      touchedFiles: [] as string[],
    };
    const controller = new DriveRuntimeController();
    controller.registerLiveRun({
      taskId: "T1",
      kind: "execute",
      turns: 7,
      cost: 1.25,
      lastActivity: "bash",
      handle: {
        attempt,
        outcome: new Promise(() => {}),
        steer: () => {},
        followUp: () => {},
        abort: () => {},
      },
    });

    // An injected scheduler keeps the test off real time and off host timers.
    let tick: (() => void) | undefined;
    let stopped = false;
    const pulses: string[] = [];
    const stop = startDriveHeartbeat(
      cwd,
      controller,
      { ...DEFAULT_CONFIG, statusWaitSeconds: 60 },
      (message) => pulses.push(message),
      (callback) => {
        tick = callback;
        return {
          stop: () => {
            stopped = true;
          },
        };
      }
    );

    assert.ok(tick, "a positive statusWaitSeconds must schedule a pulse");
    tick();
    assert.match(pulses[0] ?? "", /Drive running · 1 live agent\(s\)/);
    assert.match(pulses[0] ?? "", /T1 running · 7 turns · \$1\.2500 · bash/);

    // The second pulse reports what actually advanced since the first.
    updateBoard(cwd, (current) => {
      const task = current.tasks[0];
      if (task) task.status = "ready_for_review";
      return true;
    });
    tick();
    assert.match(pulses[1] ?? "", /Advanced since last pulse: T1 todo → ready for review/);

    stop();
    assert.equal(stopped, true);
  });
});

test("drive heartbeat is disabled when the pulse interval is zero", () => {
  withBoard((cwd) => {
    let scheduled = false;
    const stop = startDriveHeartbeat(
      cwd,
      new DriveRuntimeController(),
      { ...DEFAULT_CONFIG, statusWaitSeconds: 0 },
      () => {},
      (callback) => {
        scheduled = true;
        void callback;
        return { stop: () => {} };
      }
    );
    assert.equal(scheduled, false);
    stop();
  });
});

test("a foreign completed decision cannot deadlock a new drive reservation", () => {
  withBoard((cwd) => {
    // The exact production deadlock: a drive completed, its terminal
    // "completed" decision was delivered to a session that is now gone, and
    // every other session was refused with a misleading ownership error.
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      activeDecision: decision({
        kind: "completed",
        ownerSession: "/tmp/dead-session.jsonl",
        deliveredAt: Date.now(),
      }),
      tasks: [],
    });

    const reserved = persistActiveDrive(cwd, {
      id: "drive-new",
      ownerSession: owner,
      startedAt: Date.now(),
    });
    assert.equal(reserved.ok, true);
    const board = loadBoard(cwd);
    assert.equal(board.activeDrive?.id, "drive-new");
    assert.equal(board.activeDecision?.resolution?.intervention, "resume");
  });
});

test("a foreign actionable decision refuses reservation and names the blocker", () => {
  withBoard((cwd) => {
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      activeDecision: decision({
        kind: "escalation_required",
        ownerSession: "/tmp/sessions/other-owner.jsonl",
      }),
      tasks: [],
    });

    const reserved = persistActiveDrive(cwd, {
      id: "drive-new",
      ownerSession: owner,
      startedAt: Date.now(),
    });
    assert.equal(reserved.ok, false);
    if (!reserved.ok) {
      assert.match(reserved.reason, /escalation_required decision/);
      assert.match(reserved.reason, /other-owner\.jsonl/);
      assert.match(reserved.reason, /act on it from that session/);
    }
    // The pending judgment is preserved untouched for its owner.
    const board = loadBoard(cwd);
    assert.equal(board.activeDrive, undefined);
    assert.equal(board.activeDecision?.resolution, undefined);
  });
});

test("a delivered decision that stays untouched re-nudges the owner session", () => {
  withBoard((cwd) => {
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      activeDecision: decision({ kind: "escalation_required", ownerSession: owner }),
      tasks: [],
    });
    const sent: string[] = [];
    const timers: Array<() => void> = [];
    let busy = false;
    deliverPendingDecision(cwd, owner, (evidence) => sent.push(evidence), {
      minutes: 5,
      isRuntimeActive: () => true,
      isBusy: () => busy,
      scheduleTimer: (callback) => {
        timers.push(callback);
        return { stop: () => {} };
      },
    });
    assert.equal(sent.length, 1, "the decision itself is delivered once");
    assert.equal(timers.length, 1, "delivery arms the watchdog");

    // A live drive means the decision is being acted on: no reminder, re-armed.
    busy = true;
    timers[1 - 1]?.();
    assert.equal(sent.length, 1);
    assert.equal(timers.length, 2);

    // Quiet interval with no board change: the reminder fires with the evidence.
    busy = false;
    timers[2 - 1]?.();
    assert.equal(sent.length, 2);
    assert.match(sent[1] ?? "", /Reminder 1\/3/);
    assert.match(sent[1] ?? "", /escalation_required/);
    assert.match(sent[1] ?? "", /Owner action is required/);

    // Board activity resets the quiet interval without spending an attempt.
    updateBoard(cwd, (board) => {
      board.goal = "changed";
      return true;
    });
    timers[3 - 1]?.();
    assert.equal(sent.length, 2);

    // Reminders stop for good once the decision is resolved.
    updateBoard(cwd, (board) => {
      const active = board.activeDecision;
      if (!active) return false;
      active.resolution = { intervention: "resume", resolvedAt: Date.now() };
      return true;
    });
    timers[4 - 1]?.();
    assert.equal(sent.length, 2);
    assert.equal(timers.length, 4, "a resolved decision arms nothing further");
  });
});

test("reminders are bounded and a reload re-arms a previously delivered decision", () => {
  withBoard((cwd) => {
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      activeDecision: decision({
        kind: "no_progress",
        ownerSession: owner,
        deliveredAt: Date.now(),
      }),
      tasks: [],
    });
    const sent: string[] = [];
    const timers: Array<() => void> = [];
    const options = {
      minutes: 5,
      isRuntimeActive: () => true,
      isBusy: () => false,
      scheduleTimer: (callback: () => void) => {
        timers.push(callback);
        return { stop: () => {} };
      },
    };
    // The delivering process died; a reload must still arm the watchdog.
    armDeliveredDecisionNudge(cwd, owner, (evidence) => sent.push(evidence), options);
    assert.equal(timers.length, 1);

    for (const round of [1, 2, 3]) {
      const armed: number = timers.length;
      timers[timers.length - 1]?.();
      assert.equal(sent.length, round);
      assert.match(sent[round - 1] ?? "", new RegExp(`Reminder ${round}/3`));
      if (round < 3) assert.equal(timers.length, armed + 1, "next reminder is armed");
    }
    // The limit is respected: the third reminder arms no fourth timer.
    assert.equal(timers.length, 3);
    assert.equal(sent.length, 3);

    // A foreign session must not arm a watchdog for someone else's decision.
    const foreign: string[] = [];
    armDeliveredDecisionNudge(
      cwd,
      "/tmp/foreign.jsonl",
      (evidence) => foreign.push(evidence),
      options
    );
    const before = timers.length;
    assert.equal(timers.length, before);
    assert.deepEqual(foreign, []);
  });
});

test("decision evidence is bounded by characters, not only lines", () => {
  withBoard((cwd) => {
    saveBoard(cwd, { version: 1, nextTaskNumber: 1, tasks: [] });
    // One enormous single line defeated the old line-based bound entirely.
    const flood = `escalated: ${"x".repeat(50_000)}`;
    persistDriveDecision(
      cwd,
      owner,
      {
        rounds: 1,
        tasks: [],
        stoppedBecause: { code: "escalation_required", message: flood },
      },
      flood
    );
    const evidence = loadBoard(cwd).activeDecision?.evidence ?? "";
    assert.ok(evidence.length <= 12_100, `evidence is ${evidence.length} characters`);
    assert.match(evidence, /more characters\)/);
  });
});
