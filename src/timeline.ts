import { type Board, type Task } from "./types.js";

export type RunTimelineKind =
  | "plan_gate"
  | "planned"
  | "dispatch"
  | "execute"
  | "provider_fallback"
  | "watchdog"
  | "review"
  | "finding"
  | "verification"
  | "integration"
  | "conflict"
  | "approval"
  | "pause"
  | "resume"
  | "abort"
  | "decision"
  | "decision_delivery"
  | "decision_resolution"
  | "cleanup"
  | "archive";

export interface RunTimelineEvent {
  timestamp: number;
  taskId?: string;
  kind: RunTimelineKind;
  summary: string;
  severity: "info" | "warning" | "error";
  cost?: number;
  turns?: number;
  reference?: string;
}

function taskEvents(task: Task): RunTimelineEvent[] {
  const events: RunTimelineEvent[] = [
    {
      timestamp: task.createdAt,
      taskId: task.id,
      kind: "planned",
      summary: `planned: ${task.title}`,
      severity: "info",
    },
  ];

  for (const attempt of task.attempts) {
    const failed = attempt.exitCode !== undefined && attempt.exitCode !== 0;
    events.push({
      timestamp: attempt.startedAt,
      taskId: task.id,
      kind: "dispatch",
      summary: `executor launch ${attempt.index}`,
      severity: "info",
      reference: attempt.sessionFile ?? attempt.logFile,
    });
    if (attempt.failureReason?.kind === "provider_failure") {
      events.push({
        timestamp: attempt.endedAt ?? attempt.startedAt,
        taskId: task.id,
        kind: "provider_fallback",
        summary: attempt.failureReason.message.slice(0, 300),
        severity: "warning",
      });
    }
    if (attempt.failureReason?.kind === "stalled") {
      events.push({
        timestamp: attempt.endedAt ?? attempt.startedAt,
        taskId: task.id,
        kind: "watchdog",
        summary: attempt.failureReason.message.slice(0, 300),
        severity: "error",
      });
    }
    if (attempt.failureReason?.kind === "user_abort") {
      events.push({
        timestamp: attempt.endedAt ?? attempt.startedAt,
        taskId: task.id,
        kind: "abort",
        summary: attempt.failureReason.message.slice(0, 300),
        severity: "warning",
      });
    }
    events.push({
      timestamp: attempt.endedAt ?? attempt.startedAt,
      taskId: task.id,
      kind: "execute",
      summary: failed
        ? `execution failed: ${attempt.failureReason?.kind ?? `exit ${attempt.exitCode}`}`
        : "execution settled",
      severity: failed ? "error" : "info",
      cost: attempt.usage.cost,
      turns: attempt.usage.turns,
      reference: attempt.sessionFile ?? attempt.logFile,
    });
    for (const launch of attempt.reviewLaunches ?? []) {
      const role = launch.role ?? "reviewer";
      const result = launch.failureReason?.kind ?? launch.verdict ?? "completed";
      events.push({
        timestamp: launch.endedAt ?? launch.startedAt,
        taskId: task.id,
        kind: "review",
        summary: `${role} review ${result}`,
        severity: launch.failureReason ? "error" : "info",
        cost: launch.usage.cost,
        turns: launch.usage.turns,
        ...(launch.sessionFile ? { reference: launch.sessionFile } : {}),
      });
    }
  }

  for (const finding of task.findings ?? []) {
    const kind = finding.fingerprint.includes("verification")
      ? "verification"
      : finding.fingerprint.includes("merge") || finding.message.toLowerCase().includes("conflict")
        ? "conflict"
        : "finding";
    events.push({
      timestamp: task.updatedAt,
      taskId: task.id,
      kind,
      summary: `${finding.status} finding [${finding.fingerprint}]: ${finding.message.slice(0, 300)}`,
      severity: finding.status === "open" ? "warning" : "info",
    });
  }
  if (task.provenance?.verifiedAt) {
    events.push({
      timestamp: task.provenance.verifiedAt,
      taskId: task.id,
      kind: "verification",
      summary: `verified with ${task.provenance.verificationProfile ?? "trusted profile"}`,
      severity: "info",
    });
  }
  if (task.provenance?.integratedCommit) {
    events.push({
      timestamp: task.provenance.reviewedAt ?? task.updatedAt,
      taskId: task.id,
      kind: "integration",
      summary: `integrated ${task.provenance.integratedCommit.slice(0, 12)}`,
      severity: "info",
      reference: task.provenance.integratedCommit,
    });
  }
  if (task.status === "approved") {
    events.push({
      timestamp: task.updatedAt,
      taskId: task.id,
      kind: "approval",
      summary: task.approvalKind === "manual" ? "accepted manually" : "approved after review",
      severity: task.approvalKind === "manual" ? "warning" : "info",
    });
  }
  return events;
}

export function deriveRunTimeline(board: Board, taskId?: string): RunTimelineEvent[] {
  const tasks = taskId
    ? board.tasks.filter((task) => task.id.toUpperCase() === taskId.trim().toUpperCase())
    : board.tasks;
  const events = tasks.flatMap(taskEvents);
  if (board.planPending && board.tasks.length > 0) {
    events.push({
      timestamp: Math.min(...board.tasks.map((task) => task.createdAt)),
      kind: "plan_gate",
      summary: "plan awaiting human approval",
      severity: "warning",
    });
  }
  if (board.pausedDrive && board.tasks.length > 0) {
    events.push({
      timestamp: Math.max(...board.tasks.map((task) => task.updatedAt)),
      kind: "pause",
      summary: `drive paused${board.pausedDrive.taskIds?.length ? ` for ${board.pausedDrive.taskIds.join(", ")}` : ""}`,
      severity: "warning",
    });
  }
  if (board.activeDecision) {
    events.push({
      timestamp: board.activeDecision.createdAt,
      kind: "decision",
      summary: `${board.activeDecision.kind}: ${board.activeDecision.evidence.slice(0, 300)}`,
      severity: board.activeDecision.resolution ? "info" : "warning",
    });
    if (board.activeDecision.deliveredAt) {
      events.push({
        timestamp: board.activeDecision.deliveredAt,
        kind: "decision_delivery",
        summary: "decision delivered to owner",
        severity: "info",
      });
    }
    if (board.activeDecision.resolution) {
      events.push({
        timestamp: board.activeDecision.resolution.resolvedAt,
        kind: "decision_resolution",
        summary: `resolved with ${board.activeDecision.resolution.intervention}`,
        severity: "info",
      });
    }
  }
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.timestamp - right.event.timestamp || left.index - right.index)
    .map(({ event }) => event);
}

export function formatRunTimeline(events: RunTimelineEvent[], limit = 4_000): string {
  if (events.length === 0) return "No timeline events.";
  const dates = new Set(events.map((event) => eventDate(event)));
  const lines =
    dates.size === 1
      ? [`Timeline · ${eventDate(events[0])} · paths relative to .pi/maestro/`]
      : ["Timeline · paths relative to .pi/maestro/"];
  let currentDate: string | undefined;
  for (const event of events) {
    const date = eventDate(event);
    if (dates.size > 1 && date !== currentDate) {
      lines.push(date);
      currentDate = date;
    }
    const usage =
      event.cost !== undefined || event.turns !== undefined
        ? ` · ${event.turns ?? 0} turns · $${(event.cost ?? 0).toFixed(4)}`
        : "";
    const reference = event.reference
      ? ` · ${event.reference.replace(/^.*[\\/]\.pi[\\/]maestro[\\/]/, "")}`
      : "";
    lines.push(
      `${new Date(event.timestamp).toISOString().slice(11, 19)} ${event.taskId ?? "run"} ${event.kind}: ${event.summary}${usage}${reference}`
    );
  }
  const output = lines.join("\n");
  if (output.length <= limit) return output;
  return `${output.slice(0, limit - 80)}\n… timeline omitted; inspect task session/log references for detail`;
}

function eventDate(event: RunTimelineEvent | undefined): string {
  return new Date(event?.timestamp ?? 0).toISOString().slice(0, 10);
}
