import { completionFreshness } from "./artifact-policy.js";
import { archiveBoard, updateBoard } from "./board.js";
import { loadConfig } from "./config.js";
import { truncateText } from "./format.js";
import { type ActiveDriveState, type DriveDecision, type TaskStatus } from "./types.js";
import { type DriveSummary } from "./workflow.js";

export interface ActiveDriveControl {
  id: string;
  cwd: string;
  ownerSession?: string;
  taskIds?: string[];
  pauseRequested: boolean;
  abortController: AbortController;
}

export interface BackgroundDrive {
  promise: Promise<void>;
  summary?: DriveSummary;
  error?: string;
  ownerSession?: string;
  lastPulseStatuses?: Map<string, TaskStatus>;
}

const DELIVERY_CLAIM_STALE_MS = 30_000;

export class DriveRuntimeController {
  private active: ActiveDriveControl | undefined;
  private background: BackgroundDrive | undefined;

  hasActive(): boolean {
    return this.active !== undefined;
  }

  activeOwner(): Pick<ActiveDriveControl, "id" | "cwd" | "ownerSession" | "taskIds"> | undefined {
    if (!this.active) return undefined;
    return {
      cwd: this.active.cwd,
      id: this.active.id,
      ...(this.active.ownerSession ? { ownerSession: this.active.ownerSession } : {}),
      ...(this.active.taskIds ? { taskIds: this.active.taskIds } : {}),
    };
  }

  requestPause(): boolean {
    if (!this.active) return false;
    this.active.pauseRequested = true;
    return true;
  }

  abort(): boolean {
    if (!this.active) return false;
    this.active.abortController.abort();
    return true;
  }

  begin(control: ActiveDriveControl): void {
    if (this.active) throw new Error("An autonomous drive is already active.");
    this.active = control;
  }

  finish(control: ActiveDriveControl): void {
    if (this.active === control) this.active = undefined;
  }

  setBackground(operation: BackgroundDrive): void {
    this.background = operation;
  }

  getBackground(): BackgroundDrive | undefined {
    return this.background;
  }

  shutdown(): void {
    this.active?.abortController.abort();
  }
}

export function persistDriveDecision(
  cwd: string,
  ownerSession: string | undefined,
  summary: DriveSummary,
  evidence: string,
  driveId?: string
): boolean {
  return updateBoard(cwd, (board) => {
    if (driveId && board.activeDrive?.id !== driveId) return false;
    board.activeDecision = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...(ownerSession ? { ownerSession } : {}),
      kind: summary.stoppedBecause.code,
      taskIds: (summary.stoppedBecause.taskIds ?? summary.tasks.map((task) => task.id)).slice(
        0,
        64
      ),
      evidence: truncateText(evidence, 4000),
      allowedInterventions: summary.stoppedBecause.code === "completed" ? [] : ["handoff", "abort"],
      createdAt: Date.now(),
    };
    if (driveId) delete board.activeDrive;
    return true;
  });
}

export function resolveDriveDecision(
  cwd: string,
  decisionId: string,
  currentSession: string | undefined,
  intervention: "handoff" | "abort" | "steer"
): DriveDecision {
  return updateBoard(cwd, (board) => {
    const decision = board.activeDecision;
    if (!decision || decision.id !== decisionId || decision.resolution) {
      throw new Error("Decision is stale or already resolved");
    }
    if (decision.ownerSession && decision.ownerSession !== currentSession) {
      throw new Error("Only the decision owner may resolve it");
    }
    const resumesCorrectedBoard =
      intervention === "steer" &&
      (decision.kind === "escalation_required" || decision.kind === "stale_completion");
    if (!decision.allowedInterventions.includes(intervention) && !resumesCorrectedBoard) {
      throw new Error(`${intervention} is not allowed for this decision`);
    }

    decision.resolution = {
      intervention: resumesCorrectedBoard ? "resume" : intervention,
      resolvedAt: Date.now(),
    };
    delete decision.deliveryClaim;
    return decision;
  });
}

export function deliverPendingDecision(
  cwd: string,
  currentSession: string | undefined,
  send: (evidence: string, decisionId: string) => void
): void {
  const claimId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let evidence: string | undefined;
  let decisionId: string | undefined;
  updateBoard(cwd, (board) => {
    const decision = board.activeDecision;
    if (!decision || decision.deliveredAt || decision.resolution) return false;
    if (decision.ownerSession && decision.ownerSession !== currentSession) return false;

    const claim = decision.deliveryClaim;
    if (claim && Date.now() - claim.claimedAt <= DELIVERY_CLAIM_STALE_MS) return false;

    decision.deliveryClaim = { id: claimId, claimedAt: Date.now() };
    evidence = decision.evidence;
    decisionId = decision.id;
    return true;
  });
  if (evidence === undefined) return;

  try {
    send(evidence, decisionId as string);
  } catch {
    updateBoard(cwd, (board) => {
      const decision = board.activeDecision;
      if (!decision || decision.deliveryClaim?.id !== claimId || decision.deliveredAt) return false;
      delete decision.deliveryClaim;
      return true;
    });
    return;
  }

  updateBoard(cwd, (board) => {
    const decision = board.activeDecision;
    if (!decision || decision.deliveryClaim?.id !== claimId || decision.deliveredAt) return false;
    decision.deliveredAt = Date.now();
    delete decision.deliveryClaim;
    return true;
  });
}

export function acknowledgeDeliveredDecision(cwd: string, decisionId: string): boolean {
  return updateBoard(cwd, (board) => {
    const decision = board.activeDecision;
    if (!decision || decision.id !== decisionId || decision.resolution) return false;
    if (decision.deliveredAt) return false;
    decision.deliveredAt = Date.now();
    delete decision.deliveryClaim;
    return true;
  });
}

export function persistActiveDrive(cwd: string, activeDrive: ActiveDriveState): boolean {
  let persisted = false;
  updateBoard(cwd, (board) => {
    if (board.activeDrive && board.activeDrive.id !== activeDrive.id) return false;
    if (board.pausedDrive && board.pausedDrive.ownerSession !== activeDrive.ownerSession) {
      return false;
    }
    if (board.activeDecision && !board.activeDecision.resolution) {
      if (board.activeDecision.ownerSession !== activeDrive.ownerSession) return false;
      if (board.activeDecision.kind !== "stale_completion") {
        board.activeDecision.resolution = { intervention: "resume", resolvedAt: Date.now() };
        delete board.activeDecision.deliveryClaim;
      }
    }
    delete board.pausedDrive;
    board.activeDrive = activeDrive;
    persisted = true;
    return true;
  });
  return persisted;
}

export function clearActiveDrive(cwd: string, driveId: string): boolean {
  let cleared = false;
  updateBoard(cwd, (board) => {
    if (board.activeDrive?.id !== driveId) return false;
    delete board.activeDrive;
    cleared = true;
    return true;
  });
  return cleared;
}

export function cleanupCompletedBoard(cwd: string): void {
  const config = loadConfig(cwd);
  if (!(config.cleanupCompletedTasks ?? true)) return;

  updateBoard(cwd, (board) => {
    if (
      board.tasks.length === 0 ||
      board.tasks.some(
        (task) =>
          (task.status !== "approved" && task.status !== "cancelled") ||
          (task.status === "approved" && completionFreshness(board, task, config).state !== "fresh")
      )
    ) {
      return false;
    }

    archiveBoard(cwd);
    board.nextTaskNumber = 1;
    board.tasks = [];
    delete board.goal;
    delete board.planPending;
    delete board.pausedDrive;
    return true;
  });
}
