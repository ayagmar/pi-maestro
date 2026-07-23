import {
  createTask,
  findTask,
  normalizeSuccessCriteria,
  normalizeWritePaths,
  planValidationMessage,
  validatePlan,
} from "./board.js";
import { MAX_DISCOVERY_REPORT_BYTES } from "./constants.js";
import { assertPlanTaskLimit } from "./preflight.js";
import { type Board, type MaestroConfig, type Task } from "./types.js";

export const DISCOVERY_TOOLS = "read,grep,find,ls";
export { MAX_DISCOVERY_REPORT_BYTES };
export const MAX_DISCOVERY_ITEMS = 32;
const MAX_DISCOVERY_PREVIEW = 4_000;

interface DiscoveryItem {
  key: string;
  title: string;
  brief: string;
  tier: string;
  writePaths: string[];
  successCriteria: string[];
  dependsOn: string[];
  verificationProfile?: string;
  reviewPolicy?: "single" | "confirm" | "find-and-refute";
  commitMessage?: string;
}

export interface DiscoveryOutput {
  kind: "pi-maestro-discovery";
  version: 1;
  items: DiscoveryItem[];
}

export function completedDiscoveryReport(task: Task | undefined): string {
  if (!task?.discovery || task.writePaths?.length !== 0) {
    throw new Error(`${task?.id ?? "Task"} is not an explicit no-file discovery task.`);
  }
  const attempt = task.attempts.at(-1);
  if (
    (task.status !== "ready_for_review" && task.status !== "approved") ||
    task.dispatchClaim ||
    !attempt?.endedAt ||
    attempt.exitCode !== 0 ||
    !attempt.finalReport
  ) {
    throw new Error(`${task.id} does not have a retained completed discovery result.`);
  }
  return attempt.finalReport;
}

const OUTPUT_KEYS = new Set(["kind", "version", "items"]);
const ITEM_KEYS = new Set([
  "key",
  "title",
  "brief",
  "tier",
  "writePaths",
  "successCriteria",
  "dependsOn",
  "verificationProfile",
  "reviewPolicy",
  "commitMessage",
]);
const ITEM_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function discoveryInstructions(allowedWritePaths: string[]): string {
  return [
    'Return only one JSON object: {"kind":"pi-maestro-discovery","version":1,"items":[...]}',
    "Each item requires key, title, brief, tier, non-empty writePaths, successCriteria, and dependsOn.",
    "dependsOn contains item keys or existing task IDs. Do not include commands, scripts, hooks, or prose outside JSON.",
    `Generated writePaths must stay within: ${allowedWritePaths.join(", ")}.`,
  ].join("\n");
}

export function parseDiscoveryOutput(
  text: string,
  maxItems = MAX_DISCOVERY_ITEMS
): DiscoveryOutput {
  if (Buffer.byteLength(text, "utf-8") > MAX_DISCOVERY_REPORT_BYTES) {
    throw new Error(`Discovery output exceeds ${MAX_DISCOVERY_REPORT_BYTES} bytes.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Discovery output must be one valid JSON object.");
  }
  if (!isRecord(value)) throw new Error("Discovery output must be a JSON object.");
  rejectUnknownFields(value, OUTPUT_KEYS, "discovery output");
  if (value.kind !== "pi-maestro-discovery" || value.version !== 1) {
    throw new Error("Unsupported discovery output kind or version.");
  }
  if (!Array.isArray(value.items) || value.items.length < 1) {
    throw new Error("Discovery output must contain at least one item.");
  }
  if (value.items.length > maxItems) {
    throw new Error(`Discovery output cannot contain more than ${maxItems} items.`);
  }

  const items = value.items.map(parseItem);
  const keys = new Set<string>();
  for (const item of items) {
    const key = item.key.toUpperCase();
    if (keys.has(key)) throw new Error(`Duplicate discovery item key: ${item.key}`);
    keys.add(key);
  }
  return { kind: "pi-maestro-discovery", version: 1, items };
}

export function buildDiscoveryBoard(
  current: Board,
  discoveryTaskId: string,
  report: string,
  mode: "append" | "replace",
  config: MaestroConfig
): Board {
  const discoveryTask = findTask(current, discoveryTaskId);
  if (!discoveryTask?.discovery || discoveryTask.writePaths?.length !== 0) {
    throw new Error(`${discoveryTaskId} is not an explicit no-file discovery task.`);
  }
  const output = parseDiscoveryOutput(report, config.maxDiscoveryGeneratedTasks);
  const candidate: Board =
    mode === "append"
      ? structuredClone(current)
      : { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
  const keyToId = new Map(
    output.items.map((item, index) => [
      item.key.toUpperCase(),
      `T${candidate.nextTaskNumber + index}`,
    ])
  );
  const existingIds = new Set(candidate.tasks.map((task) => task.id.toUpperCase()));

  for (const item of output.items) {
    validateItem(item, discoveryTask, config);
    for (const dependency of item.dependsOn) {
      const key = dependency.toUpperCase();
      if (!keyToId.has(key) && !existingIds.has(key)) {
        throw new Error(`${item.key} references unknown dependency "${dependency}".`);
      }
    }
  }

  const created: Task[] = [];
  for (const item of output.items) {
    const verificationProfile = item.verificationProfile ?? config.defaultVerificationProfile;
    created.push(
      createTask(candidate, {
        title: item.title,
        brief: item.brief,
        tier: item.tier,
        dependsOn: [],
        writePaths: item.writePaths,
        successCriteria: item.successCriteria,
        ...(verificationProfile ? { verificationProfile } : {}),
        ...(item.reviewPolicy ? { reviewPolicy: item.reviewPolicy } : {}),
        ...(item.commitMessage ? { commitMessage: item.commitMessage } : {}),
      })
    );
  }
  for (const [index, task] of created.entries()) {
    task.dependsOn =
      output.items[index]?.dependsOn.map(
        (dependency) => keyToId.get(dependency.toUpperCase()) ?? dependency.toUpperCase()
      ) ?? [];
  }

  candidate.planPending = true;
  assertPlanTaskLimit(candidate.tasks.length, config);
  const validationError = planValidationMessage(validatePlan(candidate, Object.keys(config.tiers)));
  if (validationError) throw new Error(validationError);
  return candidate;
}

export function formatDiscoveryPreview(
  output: DiscoveryOutput,
  mode: "append" | "replace"
): string {
  const lines = [
    `Discovery preview (${mode}) · ${output.items.length} task(s)`,
    ...output.items.map(
      (item, index) =>
        `${index + 1}. ${item.key}: ${item.title} [${item.tier}] · ${item.writePaths.join(", ")} · depends on ${item.dependsOn.join(", ") || "nothing"}`
    ),
  ];
  const preview = lines.join("\n");
  if (preview.length <= MAX_DISCOVERY_PREVIEW) return preview;
  const suffix = `\n… ${output.items.length} total task(s); inspect the retained discovery report for omitted details.`;
  return `${preview.slice(0, MAX_DISCOVERY_PREVIEW - suffix.length)}${suffix}`;
}

function parseItem(value: unknown): DiscoveryItem {
  if (!isRecord(value)) throw new Error("Discovery output contains a malformed item.");
  rejectUnknownFields(value, ITEM_KEYS, "discovery item");
  for (const key of ["key", "title", "brief", "tier"] as const) {
    const maximum = key === "brief" ? 20_000 : 500;
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > maximum) {
      throw new Error(`Discovery item ${key} is invalid.`);
    }
  }
  if (!ITEM_KEY.test(value.key as string)) throw new Error("Discovery item key is invalid.");
  for (const key of ["writePaths", "successCriteria", "dependsOn"] as const) {
    if (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === "string")) {
      throw new Error(`Discovery item ${key} must be an array of strings.`);
    }
  }
  if (
    value.verificationProfile !== undefined &&
    (typeof value.verificationProfile !== "string" ||
      !value.verificationProfile.trim() ||
      value.verificationProfile.length > 64)
  ) {
    throw new Error("Discovery item verificationProfile is invalid.");
  }
  if (
    value.commitMessage !== undefined &&
    (typeof value.commitMessage !== "string" ||
      !value.commitMessage.trim() ||
      value.commitMessage.length > 500)
  ) {
    throw new Error("Discovery item commitMessage is invalid.");
  }
  if (
    value.reviewPolicy !== undefined &&
    value.reviewPolicy !== "single" &&
    value.reviewPolicy !== "confirm" &&
    value.reviewPolicy !== "find-and-refute"
  ) {
    throw new Error("Discovery item reviewPolicy is invalid.");
  }
  return {
    key: (value.key as string).trim(),
    title: (value.title as string).trim(),
    brief: (value.brief as string).trim(),
    tier: (value.tier as string).trim(),
    writePaths: normalizeWritePaths(value.writePaths as string[]),
    successCriteria: [...new Set(normalizeSuccessCriteria(value.successCriteria as string[]))],
    dependsOn: normalizeDependencies(value.dependsOn as string[]),
    ...(value.verificationProfile ? { verificationProfile: value.verificationProfile.trim() } : {}),
    ...(value.reviewPolicy ? { reviewPolicy: value.reviewPolicy } : {}),
    ...(value.commitMessage ? { commitMessage: value.commitMessage.trim() } : {}),
  };
}

function validateItem(item: DiscoveryItem, discoveryTask: Task, config: MaestroConfig): void {
  if (item.writePaths.length === 0)
    throw new Error(`${item.key} must have a non-empty write scope.`);
  if (!config.tiers[item.tier]) throw new Error(`${item.key} uses unknown tier "${item.tier}".`);
  const profile = item.verificationProfile ?? config.defaultVerificationProfile;
  if (profile && !config.verificationProfiles?.[profile]) {
    throw new Error(`Unknown verification profile: ${profile}`);
  }
  for (const path of item.writePaths) {
    if (!discoveryTask.discovery?.allowedWritePaths.some((scope) => pathIsWithin(path, scope))) {
      throw new Error(`${item.key} write path "${path}" is outside its declared discovery scope.`);
    }
  }
}

function pathIsWithin(path: string, scope: string): boolean {
  if (scope.endsWith("/**")) {
    const prefix = scope.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === scope;
}

function normalizeDependencies(values: string[]): string[] {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value))
    throw new Error("Discovery dependencies cannot be empty.");
  return [...new Set(normalized.map((value) => value.toUpperCase()))].sort();
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains unknown field "${unknown}".`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
