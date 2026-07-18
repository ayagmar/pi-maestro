import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadBoard, sweepDispatchState } from "./board.js";
import { loadConfig, setProjectConfigTrust } from "./config.js";
import { COMMAND, CONTEXT_NUDGE_PERCENT } from "./constants.js";
import {
  acknowledgeDeliveredDecision,
  type DriveRuntimeController,
  deliverPendingDecision,
  persistDriveDecision,
} from "./drive-controller.js";
import { formatDrivePulse, unexpectedDriveSummary } from "./drive-summary.js";
import { notify } from "./handoff.js";
import { reattachDetachedExecutor } from "./runner.js";
import {
  maestroBoardCwd,
  previousBoardSession,
  sessionCanControlDrive,
  sessionSwitchBlocked,
} from "./session-control.js";
import { type Board } from "./types.js";
import { settleReattachedDetachedAttempt } from "./workflow-execution.js";
import { type WorkflowRun } from "./workflow-runtime.js";
import { parkInactiveWorktrees, sweepWorktrees } from "./worktree.js";

export class ExtensionLifecycleState {
  private active = true;
  private contextNudgeShown = false;

  isActive(): boolean {
    return this.active;
  }

  start(): void {
    this.active = true;
    this.contextNudgeShown = false;
  }

  shutdown(): void {
    this.active = false;
  }

  hasShownContextNudge(): boolean {
    return this.contextNudgeShown;
  }

  markContextNudgeShown(): void {
    this.contextNudgeShown = true;
  }
}

export interface LifecycleDependencies {
  state: ExtensionLifecycleState;
  driveController: DriveRuntimeController;
  setCommandCwd(cwd: string): void;
  setPreviousSession(sessionFile: string | undefined): void;
  closeLivePane(): void;
  clearSuppressedPane(): void;
  refreshUI(ctx: ExtensionContext): void;
  sessionOwnsBoard(ctx: ExtensionContext, board: Board): boolean;
  sendDecision(evidence: string, decisionId: string): void;
}

export function registerMaestroLifecycle(
  pi: ExtensionAPI,
  dependencies: LifecycleDependencies
): void {
  const { driveController, state } = dependencies;

  pi.on("turn_end", (_event, ctx) => {
    if (state.hasShownContextNudge()) return;

    try {
      const usage = ctx.getContextUsage();
      const config = loadConfig(ctx.cwd);
      const threshold = (config.handoffContextRatio ?? CONTEXT_NUDGE_PERCENT / 100) * 100;
      if (!usage || usage.percent === null || threshold <= 0 || usage.percent < threshold) return;

      const board = loadBoard(ctx.cwd);
      if (board.tasks.length === 0 || !dependencies.sessionOwnsBoard(ctx, board)) return;
      if (driveController.hasActive() || driveController.liveRunCount() > 0) {
        if (ctx.hasUI) {
          ctx.ui.notify("Maestro handoff pending until live work reaches a safe boundary.");
        }
        return;
      }

      state.markContextNudgeShown();
      pi.sendUserMessage(`/${COMMAND} handoff`, { deliverAs: "followUp" });
    } catch {
      // The turn may belong to a context invalidated by a session switch.
    }
  });

  pi.on("session_before_switch", (_event, ctx) => {
    if (!sessionSwitchBlocked(driveController.hasActive(), driveController.liveRunCount())) return;
    notify(
      ctx,
      `Session switch blocked while maestro work is active. Use /${COMMAND} pause and wait, or /${COMMAND} abort.`,
      "warning"
    );
    return { cancel: true };
  });

  pi.on("session_before_fork", (_event, ctx) => {
    if (!sessionSwitchBlocked(driveController.hasActive(), driveController.liveRunCount())) return;
    notify(
      ctx,
      `Session fork blocked while maestro work is active. Use /${COMMAND} pause and wait, or /${COMMAND} abort.`,
      "warning"
    );
    return { cancel: true };
  });

  pi.on("session_start", (event, ctx) => {
    dependencies.setCommandCwd(ctx.cwd);
    // Project-local .pi/maestro.json can steer budgets, tiers, and tool
    // lists; honor it only for projects the user told pi to trust. Contexts
    // without the trust API (legacy harnesses) keep the trusted default.
    const trustApi = (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted;
    if (typeof trustApi === "function") {
      try {
        setProjectConfigTrust(trustApi.call(ctx));
      } catch {
        setProjectConfigTrust(false);
      }
    } else {
      setProjectConfigTrust(true);
    }
    state.start();
    dependencies.closeLivePane();
    dependencies.clearSuppressedPane();
    driveController.clearLiveRuns();

    const boardCwd = maestroBoardCwd(ctx.cwd);
    const navigationBoard = loadBoard(boardCwd);
    const executorSessions = navigationBoard.tasks.flatMap((task) =>
      task.attempts.flatMap((attempt) =>
        [attempt.sessionFile, attempt.reviewSessionFile].filter(
          (sessionFile): sessionFile is string => sessionFile !== undefined
        )
      )
    );
    dependencies.setPreviousSession(
      previousBoardSession(
        event.previousSessionFile,
        ctx.sessionManager.getSessionFile(),
        navigationBoard.ownerSessions,
        executorSessions
      )
    );

    const recoveryNotes = sweepDispatchState(boardCwd);
    for (const note of recoveryNotes) notify(ctx, note, "warning");
    let recovered = loadBoard(boardCwd);
    for (const task of recovered.tasks) {
      const attempt = task.attempts.at(-1);
      const claim = task.dispatchClaim;
      if (
        task.status !== "running" ||
        claim?.kind !== "execute" ||
        !attempt?.detached ||
        !attempt.controlFile
      ) {
        continue;
      }
      let live: WorkflowRun | undefined;
      const handle = reattachDetachedExecutor(
        attempt,
        attempt.worktreePath ?? boardCwd,
        (update) => {
          if (!live) return;
          live.turns = update.turns;
          live.cost = update.cost;
          live.lastActivity = update.lastActivity;
          try {
            dependencies.refreshUI(ctx);
          } catch {
            // The reattached executor outlives stale UI contexts.
          }
        }
      );
      live = {
        taskId: task.id,
        kind: "execute",
        turns: attempt.usage.turns,
        cost: attempt.usage.cost,
        lastActivity: "reattached detached executor",
        handle,
      };
      driveController.registerLiveRun(live);
      void handle.outcome
        .then((outcome) => {
          settleReattachedDetachedAttempt(boardCwd, task.id, claim.id, handle.attempt, outcome);
          if (live) driveController.removeLiveRun(live);
          const detachedBoard = loadBoard(boardCwd);
          if (driveController.liveRunCount() === 0 && detachedBoard.activeDrive) {
            const summary = unexpectedDriveSummary(
              boardCwd,
              detachedBoard.activeDrive.taskIds,
              "detached executor settled after supervisor reattachment; resume the drive from persisted task state"
            );
            persistDriveDecision(
              boardCwd,
              detachedBoard.activeDrive.ownerSession,
              summary,
              formatDrivePulse(summary),
              detachedBoard.activeDrive.id
            );
          }
          try {
            dependencies.refreshUI(ctx);
          } catch {
            // The session may have switched while the detached run settled.
          }
        })
        .catch((error) => {
          if (live) driveController.removeLiveRun(live);
          try {
            notify(ctx, `${task.id}: detached recovery failed: ${String(error)}`, "error");
          } catch {
            // Persisted attempt and claim remain available to the next startup sweep.
          }
        });
      notify(
        ctx,
        `${task.id}: reattached detached executor ${attempt.pid ?? "(exited)"} (log tail + control).`
      );
    }
    const orphanedDrive = recovered.activeDrive;
    const currentSession = ctx.sessionManager.getSessionFile();
    if (
      orphanedDrive &&
      !driveController.hasActive() &&
      driveController.liveRunCount() === 0 &&
      sessionCanControlDrive(orphanedDrive.ownerSession, currentSession)
    ) {
      const summary = unexpectedDriveSummary(
        boardCwd,
        orphanedDrive.taskIds,
        "the owning extension runtime stopped before recording an outcome"
      );
      persistDriveDecision(
        boardCwd,
        orphanedDrive.ownerSession,
        summary,
        formatDrivePulse(summary),
        orphanedDrive.id
      );
      recovered = loadBoard(boardCwd);
    }
    const pendingDecision = recovered.activeDecision;
    if (
      pendingDecision &&
      !pendingDecision.deliveredAt &&
      sessionCanControlDrive(pendingDecision.ownerSession, currentSession) &&
      sessionContainsDecision(ctx, pendingDecision.id)
    ) {
      acknowledgeDeliveredDecision(boardCwd, pendingDecision.id);
      recovered = loadBoard(boardCwd);
    }
    deliverPendingDecision(
      boardCwd,
      ctx.sessionManager.getSessionFile(),
      dependencies.sendDecision
    );

    const parking = parkInactiveWorktrees(boardCwd, recovered);
    for (const warning of parking.warnings) {
      notify(ctx, `Could not clean idle maestro worktree: ${warning}`, "warning");
    }

    const knownWorktrees = recovered.tasks.flatMap((task) =>
      task.attempts.flatMap((attempt) =>
        attempt.worktreePath && attempt.branch
          ? [{ worktreePath: attempt.worktreePath, branch: attempt.branch }]
          : []
      )
    );
    const retained = recovered.tasks
      .filter((task) => task.status === "ready_for_review" || task.status === "changes_requested")
      .flatMap((task) => {
        const attempt = task.attempts.at(-1);
        return attempt?.worktreePath && attempt.branch
          ? [{ worktreePath: attempt.worktreePath, branch: attempt.branch }]
          : [];
      });
    try {
      sweepWorktrees(boardCwd, retained, knownWorktrees);
    } catch (error) {
      notify(ctx, `Could not clean stale maestro worktrees: ${String(error)}`, "warning");
    }
    dependencies.refreshUI(ctx);
  });

  pi.on("session_shutdown", () => {
    state.shutdown();
    dependencies.closeLivePane();
    const active = driveController.activeOwner();
    const hasDetachedSurvivor = [...driveController.liveRunValues()].some(
      (run) => run.handle.survivesShutdown
    );
    if (active && !hasDetachedSurvivor) {
      try {
        const summary = unexpectedDriveSummary(
          active.cwd,
          active.taskIds,
          "the extension runtime shut down while the drive was active"
        );
        persistDriveDecision(
          active.cwd,
          active.ownerSession,
          summary,
          formatDrivePulse(summary),
          active.id
        );
      } catch {
        // The durable active-drive record remains for owner-scoped startup reconciliation.
      }
    }
    driveController.shutdown();
  });
}

function sessionContainsDecision(ctx: ExtensionContext, decisionId: string): boolean {
  const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
    getEntries?: () => unknown[];
  };
  if (typeof sessionManager.getEntries !== "function") return false;
  return sessionManager.getEntries().some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as unknown as Record<string, unknown>;
    const details = record.details;
    if (
      details &&
      typeof details === "object" &&
      (details as Record<string, unknown>).decisionId === decisionId
    ) {
      return true;
    }
    const message = record.message;
    if (!message || typeof message !== "object") return false;
    const messageDetails = (message as Record<string, unknown>).details;
    return (
      !!messageDetails &&
      typeof messageDetails === "object" &&
      (messageDetails as Record<string, unknown>).decisionId === decisionId
    );
  });
}
