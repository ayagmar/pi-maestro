import { createTask, planValidationMessage, validatePlan } from "./board.js";
import { type Board } from "./types.js";

export const PLAN_EXPORT_VERSION = 1;

interface ExportedPlanTask {
  id: string;
  title: string;
  brief: string;
  tier: string;
  dependsOn: string[];
  writePaths: string[];
  successCriteria: string[];
  verificationProfile?: string;
  commitMessage?: string;
  cancelled?: boolean;
}

interface ExportedPlan {
  kind: "pi-maestro-plan";
  version: 1;
  tasks: ExportedPlanTask[];
}

export function exportPlan(board: Board): string {
  const plan: ExportedPlan = {
    kind: "pi-maestro-plan",
    version: PLAN_EXPORT_VERSION,
    tasks: board.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      brief: task.brief,
      tier: task.tier,
      dependsOn: [...task.dependsOn],
      writePaths: [...(task.writePaths ?? [])],
      successCriteria: [...(task.successCriteria ?? [])],
      ...(task.verificationProfile ? { verificationProfile: task.verificationProfile } : {}),
      ...(task.commitMessage ? { commitMessage: task.commitMessage } : {}),
      ...(task.status === "cancelled" ? { cancelled: true } : {}),
    })),
  };
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function importPlan(
  text: string,
  availableTiers: Iterable<string>,
  availableVerificationProfiles: Iterable<string>
): Board {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Plan import is not valid JSON.");
  }
  if (!isRecord(value) || value.kind !== "pi-maestro-plan" || value.version !== 1) {
    throw new Error("Unsupported plan export kind or version.");
  }
  if (!Array.isArray(value.tasks)) throw new Error("Plan export tasks must be an array.");

  const profiles = new Set(availableVerificationProfiles);
  const board: Board = { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
  const originalIds: string[] = [];
  for (const raw of value.tasks) {
    if (!isExportedTask(raw)) throw new Error("Plan export contains a malformed task.");
    if (raw.verificationProfile && !profiles.has(raw.verificationProfile)) {
      throw new Error(`Unknown verification profile: ${raw.verificationProfile}`);
    }
    const task = createTask(board, {
      title: raw.title,
      brief: raw.brief,
      tier: raw.tier,
      dependsOn: raw.dependsOn,
      writePaths: raw.writePaths,
      successCriteria: raw.successCriteria,
      ...(raw.verificationProfile ? { verificationProfile: raw.verificationProfile } : {}),
      ...(raw.commitMessage ? { commitMessage: raw.commitMessage } : {}),
    });
    originalIds.push(raw.id.trim().toUpperCase());
    if (raw.cancelled) task.status = "cancelled";
  }
  const idMap = new Map(originalIds.map((id, index) => [id, board.tasks[index]?.id]));
  for (const task of board.tasks) {
    task.dependsOn = task.dependsOn.map((id) => idMap.get(id) ?? id);
  }
  const error = planValidationMessage(validatePlan(board, availableTiers));
  if (error) throw new Error(error);
  return board;
}

function isExportedTask(value: unknown): value is ExportedPlanTask {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.brief === "string" &&
    typeof value.tier === "string" &&
    Array.isArray(value.dependsOn) &&
    value.dependsOn.every((item) => typeof item === "string") &&
    Array.isArray(value.writePaths) &&
    value.writePaths.every((item) => typeof item === "string") &&
    Array.isArray(value.successCriteria) &&
    value.successCriteria.every((item) => typeof item === "string") &&
    (value.verificationProfile === undefined || typeof value.verificationProfile === "string") &&
    (value.commitMessage === undefined || typeof value.commitMessage === "string") &&
    (value.cancelled === undefined || typeof value.cancelled === "boolean")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
