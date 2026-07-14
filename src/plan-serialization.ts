import { createHash } from "node:crypto";
import { createTask, normalizeTaskContract, planValidationMessage, validatePlan } from "./board.js";
import { preflightWorkflow, type WorkflowPreflight } from "./preflight.js";
import { type Board, type MaestroConfig, type Task } from "./types.js";

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
  reviewPolicy?: "single" | "confirm" | "find-and-refute";
  commitMessage?: string;
  cancelled?: boolean;
  discovery?: { allowedWritePaths: string[] };
}

interface ExportedPlan {
  kind: "pi-maestro-plan";
  version: 1;
  tasks: ExportedPlanTask[];
}

export interface PlanTaskChange {
  id: string;
  fields: string[];
  fingerprintEffects: string[];
}

export interface PlanComparison {
  added: string[];
  removed: string[];
  changed: PlanTaskChange[];
  currentPreflight: WorkflowPreflight;
  candidatePreflight: WorkflowPreflight;
  reference: string;
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
      ...(task.reviewPolicy ? { reviewPolicy: task.reviewPolicy } : {}),
      ...(task.commitMessage ? { commitMessage: task.commitMessage } : {}),
      ...(task.status === "cancelled" ? { cancelled: true } : {}),
      ...(task.discovery
        ? { discovery: { allowedWritePaths: [...task.discovery.allowedWritePaths] } }
        : {}),
    })),
  };
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function importPlan(
  text: string,
  availableTiers: Iterable<string>,
  availableVerificationProfiles: Iterable<string>,
  maxPlanTasks = 64
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
  if (value.tasks.length > maxPlanTasks) {
    throw new Error(
      `Plan has ${value.tasks.length} tasks; configured maxPlanTasks is ${maxPlanTasks}.`
    );
  }

  const profiles = new Set(availableVerificationProfiles);
  const board: Board = { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
  const originalIds: string[] = [];
  for (const raw of value.tasks) {
    if (!isExportedTask(raw)) throw new Error("Plan export contains a malformed task.");
    if (raw.verificationProfile && !profiles.has(raw.verificationProfile)) {
      throw new Error(`Unknown verification profile: ${raw.verificationProfile}`);
    }
    const contract = normalizeTaskContract(raw);
    const task = createTask(board, {
      title: raw.title,
      brief: raw.brief,
      tier: raw.tier,
      dependsOn: raw.dependsOn,
      writePaths: contract.writePaths,
      ...(contract.successCriteria ? { successCriteria: contract.successCriteria } : {}),
      ...(raw.verificationProfile ? { verificationProfile: raw.verificationProfile } : {}),
      ...(raw.reviewPolicy ? { reviewPolicy: raw.reviewPolicy } : {}),
      ...(raw.commitMessage ? { commitMessage: raw.commitMessage } : {}),
      ...(raw.discovery
        ? { discovery: { allowedWritePaths: raw.discovery.allowedWritePaths } }
        : {}),
    });
    originalIds.push(raw.id.trim().toUpperCase());
    if (raw.cancelled) task.status = "cancelled";
  }
  const stableTaskIds =
    new Set(originalIds).size === originalIds.length &&
    originalIds.every((id) => /^T[1-9]\d*$/.test(id));
  if (stableTaskIds) {
    for (const [index, task] of board.tasks.entries()) task.id = originalIds[index] as string;
    board.nextTaskNumber =
      Math.max(...originalIds.map((id) => Number.parseInt(id.slice(1), 10))) + 1;
  }
  const idMap = new Map(
    originalIds.map((id, index) => [id, stableTaskIds ? id : board.tasks[index]?.id])
  );
  for (const task of board.tasks) {
    task.dependsOn = task.dependsOn.map((id) => idMap.get(id) ?? id);
  }
  const error = planValidationMessage(validatePlan(board, availableTiers));
  if (error) throw new Error(error);
  return board;
}

export function comparePlans(
  current: Board,
  candidate: Board,
  config: MaestroConfig
): PlanComparison {
  const currentTasks = new Map(current.tasks.map((task) => [task.id.toUpperCase(), task]));
  const candidateTasks = new Map(candidate.tasks.map((task) => [task.id.toUpperCase(), task]));
  const added = [...candidateTasks.keys()]
    .filter((id) => !currentTasks.has(id))
    .sort(naturalCompare);
  const removed = [...currentTasks.keys()]
    .filter((id) => !candidateTasks.has(id))
    .sort(naturalCompare);
  const changed: PlanTaskChange[] = [];

  for (const id of [...currentTasks.keys()]
    .filter((taskId) => candidateTasks.has(taskId))
    .sort(naturalCompare)) {
    const before = currentTasks.get(id) as Task;
    const after = candidateTasks.get(id) as Task;
    const fields = changedFields(before, after);
    if (fields.length === 0) continue;
    changed.push({ id, fields, fingerprintEffects: fingerprintEffects(fields) });
  }

  const currentPreflight = preflightWorkflow(definitionBoard(current), config);
  const candidatePreflight = preflightWorkflow(definitionBoard(candidate), config);
  const payload = {
    added,
    removed,
    changed,
    currentPreflight: preflightSummary(currentPreflight),
    candidatePreflight: preflightSummary(candidatePreflight),
  };
  return {
    added,
    removed,
    changed,
    currentPreflight,
    candidatePreflight,
    reference: createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16),
  };
}

export function formatPlanComparison(
  comparison: PlanComparison,
  sourceReference: string,
  taskId?: string,
  maxCharacters = 4_000,
  omittedDetailReference = `${sourceReference}${taskId ? "" : " <taskId>"}`
): string {
  const selectedId = taskId?.trim().toUpperCase();
  const selectedChanges = selectedId
    ? comparison.changed.filter((change) => change.id === selectedId)
    : comparison.changed;
  const lines = [
    `Plan comparison · ${comparison.reference}`,
    `source: ${sourceReference}`,
    `tasks: +${comparison.added.length} -${comparison.removed.length} ~${comparison.changed.length}`,
    `added: ${comparison.added.join(", ") || "none"}`,
    `removed: ${comparison.removed.join(", ") || "none"}`,
    ...(selectedId && selectedChanges.length === 0
      ? [`${selectedId}: unchanged or absent from both plans`]
      : selectedChanges.map(
          (change) =>
            `${change.id}: ${change.fields.join(", ")} · fingerprint ${change.fingerprintEffects.join("+") || "unchanged"}`
        )),
    `waves: ${waveSummary(comparison.currentPreflight)} → ${waveSummary(comparison.candidatePreflight)}`,
    `concurrency: ${comparison.currentPreflight.effectiveConcurrency} → ${comparison.candidatePreflight.effectiveConcurrency} (configured ${comparison.candidatePreflight.configuredConcurrency})`,
    `launch bounds: executor ${comparison.currentPreflight.executorLaunchUpperBound} → ${comparison.candidatePreflight.executorLaunchUpperBound}; reviewer ${comparison.currentPreflight.reviewerLaunchUpperBound} → ${comparison.candidatePreflight.reviewerLaunchUpperBound}`,
    `verification profiles: ${profileSummary(comparison.currentPreflight)} → ${profileSummary(comparison.candidatePreflight)}`,
  ];
  const report = lines.join("\n");
  if (report.length <= maxCharacters) return report;

  const instruction = `… details omitted · reference ${comparison.reference} · inspect ${omittedDetailReference}`;
  const retained: string[] = [];
  let length = instruction.length;
  for (const line of lines) {
    if (length + line.length + 1 > maxCharacters) break;
    retained.push(line);
    length += line.length + 1;
  }
  return [...retained, instruction].join("\n");
}

function changedFields(before: Task, after: Task): string[] {
  const fields: Array<[string, unknown, unknown]> = [
    ["title", before.title, after.title],
    ["brief", before.brief, after.brief],
    ["success criteria", before.successCriteria ?? [], after.successCriteria ?? []],
    ["write scope", before.writePaths ?? [], after.writePaths ?? []],
    ["dependencies", before.dependsOn, after.dependsOn],
    ["tier", before.tier, after.tier],
    ["verification profile", before.verificationProfile ?? null, after.verificationProfile ?? null],
    ["review policy", before.reviewPolicy ?? "single", after.reviewPolicy ?? "single"],
    ["discovery", before.discovery ?? null, after.discovery ?? null],
    ["commit message", before.commitMessage ?? null, after.commitMessage ?? null],
    ["cancelled", before.status === "cancelled", after.status === "cancelled"],
  ];
  return fields
    .filter(([, left, right]) => JSON.stringify(left) !== JSON.stringify(right))
    .map(([name]) => name);
}

function fingerprintEffects(fields: readonly string[]): string[] {
  const effects = new Set<string>();
  for (const field of fields) {
    if (["title", "brief", "success criteria", "write scope", "discovery"].includes(field)) {
      effects.add("contract");
    }
    if (field === "dependencies") {
      effects.add("contract");
      effects.add("dependencies");
    }
    if (field === "tier" || field === "review policy") effects.add("execution");
    if (field === "verification profile") effects.add("verification");
  }
  return ["contract", "execution", "verification", "dependencies"].filter((effect) =>
    effects.has(effect)
  );
}

function definitionBoard(board: Board): Board {
  return {
    version: 1,
    nextTaskNumber: board.nextTaskNumber,
    tasks: board.tasks.map((task) => ({
      ...structuredClone(task),
      status: task.status === "cancelled" ? "cancelled" : "todo",
    })),
  };
}

function preflightSummary(preflight: WorkflowPreflight): object {
  return {
    waves: preflight.waves,
    effectiveConcurrency: preflight.effectiveConcurrency,
    executorLaunchUpperBound: preflight.executorLaunchUpperBound,
    reviewerLaunchUpperBound: preflight.reviewerLaunchUpperBound,
    verificationProfileUsage: preflight.verificationProfileUsage,
  };
}

function waveSummary(preflight: WorkflowPreflight): string {
  return preflight.waves.map((wave) => `[${wave.join(",")}]`).join(" ") || "none";
}

function profileSummary(preflight: WorkflowPreflight): string {
  return (
    preflight.verificationProfileUsage
      .map(({ profile, tasks }) => `${profile}:${tasks}`)
      .join(",") || "none"
  );
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
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
    (value.reviewPolicy === undefined ||
      value.reviewPolicy === "single" ||
      value.reviewPolicy === "confirm" ||
      value.reviewPolicy === "find-and-refute") &&
    (value.commitMessage === undefined || typeof value.commitMessage === "string") &&
    (value.cancelled === undefined || typeof value.cancelled === "boolean") &&
    (value.discovery === undefined ||
      (isRecord(value.discovery) &&
        Object.keys(value.discovery).length === 1 &&
        Array.isArray(value.discovery.allowedWritePaths) &&
        value.discovery.allowedWritePaths.length > 0 &&
        value.discovery.allowedWritePaths.every((path) => typeof path === "string") &&
        value.writePaths.length === 0))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
