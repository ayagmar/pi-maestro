import { blockedReason, taskGroup } from "./board.js";
import { boardUsage } from "./format.js";
import { type Board } from "./types.js";

export interface StatusProjection {
  code: "empty" | "plan_pending" | "running" | "decision" | "blocked" | "ready" | "complete";
  phase: string;
  ownerSession?: string;
  runnable: number;
  reviewable: number;
  blocked: number;
  running: number;
  approved: number;
  total: number;
  cost: number;
  recovery?: string;
}

export function projectStatus(board: Board, liveTaskIds: Iterable<string> = []): StatusProjection {
  const live = new Set(liveTaskIds);
  const running = board.tasks.filter(
    (task) => live.has(task.id) || task.status === "running"
  ).length;
  const runnable = board.tasks.filter((task) => taskGroup(board, task) === "ready").length;
  const reviewable = board.tasks.filter((task) => task.status === "ready_for_review").length;
  const blocked = board.tasks.filter((task) => blockedReason(board, task) !== undefined).length;
  const approved = board.tasks.filter((task) => task.status === "approved").length;
  const base = {
    runnable,
    reviewable,
    blocked,
    running,
    approved,
    total: board.tasks.length,
    cost: boardUsage(board.tasks).cost,
  };
  if (board.tasks.length === 0) return { code: "empty", phase: "empty", ...base };
  if (board.planPending) return { code: "plan_pending", phase: "plan approval", ...base };
  if (running > 0) return { code: "running", phase: "executing", ...base };
  if (board.activeDecision && !board.activeDecision.resolution) {
    return {
      code: "decision",
      phase: "decision required",
      ...(board.activeDecision.ownerSession
        ? { ownerSession: board.activeDecision.ownerSession }
        : {}),
      recovery: board.activeDecision.allowedInterventions.join(" or ") || "inspect",
      ...base,
    };
  }
  if (approved === board.tasks.length) return { code: "complete", phase: "complete", ...base };
  if (runnable > 0 || reviewable > 0) return { code: "ready", phase: "ready", ...base };
  return { code: "blocked", phase: "blocked", recovery: "inspect blockers", ...base };
}

export function formatStatusProjection(status: StatusProjection): string {
  const owner = status.ownerSession ? ` · owner ${status.ownerSession}` : "";
  const recovery = status.recovery ? ` · recovery: ${status.recovery}` : "";
  return `${status.code} · ${status.phase} · ${status.approved}/${status.total} approved · ${status.running} running · ${status.runnable} runnable · ${status.reviewable} reviewable · ${status.blocked} blocked · $${status.cost.toFixed(4)}${owner}${recovery}`;
}
