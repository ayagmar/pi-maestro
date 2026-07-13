import { archiveBoard, loadBoard, replaceBoard, saveBoard } from "./board.js";
import { loadConfig } from "./config.js";
import { truncateText } from "./format.js";
import { type TaskStatus } from "./types.js";
import { type DriveSummary } from "./workflow.js";

export interface ActiveDriveControl {
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

export class DriveRuntimeController {
  private active: ActiveDriveControl | undefined;
  private background: BackgroundDrive | undefined;

  hasActive(): boolean {
    return this.active !== undefined;
  }

  activeOwner(): Pick<ActiveDriveControl, "cwd" | "ownerSession"> | undefined {
    if (!this.active) return undefined;
    return {
      cwd: this.active.cwd,
      ...(this.active.ownerSession ? { ownerSession: this.active.ownerSession } : {}),
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
  evidence: string
): void {
  const board = loadBoard(cwd);
  board.activeDecision = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...(ownerSession ? { ownerSession } : {}),
    kind: summary.stoppedBecause.code,
    taskIds: (summary.stoppedBecause.taskIds ?? summary.tasks.map((task) => task.id)).slice(0, 64),
    evidence: truncateText(evidence, 4000),
    allowedInterventions: summary.stoppedBecause.code === "completed" ? [] : ["handoff", "abort"],
    createdAt: Date.now(),
  };
  saveBoard(cwd, board);
}

export function deliverPendingDecision(
  cwd: string,
  currentSession: string | undefined,
  send: (evidence: string) => void
): void {
  const board = loadBoard(cwd);
  const decision = board.activeDecision;
  if (!decision || decision.deliveredAt || decision.resolution) return;
  if (decision.ownerSession && currentSession && decision.ownerSession !== currentSession) return;

  send(decision.evidence);
  const fresh = loadBoard(cwd);
  if (fresh.activeDecision?.id !== decision.id || fresh.activeDecision.deliveredAt) return;
  fresh.activeDecision.deliveredAt = Date.now();
  saveBoard(cwd, fresh);
}

export function cleanupCompletedBoard(cwd: string): void {
  const config = loadConfig(cwd);
  if (!(config.cleanupCompletedTasks ?? true)) return;

  const board = loadBoard(cwd);
  if (
    board.tasks.length === 0 ||
    board.tasks.some((task) => task.status !== "approved" && task.status !== "cancelled")
  ) {
    return;
  }

  archiveBoard(cwd);
  replaceBoard(cwd, { version: 1, nextTaskNumber: 1, tasks: [] }, board.revision ?? 0);
}
