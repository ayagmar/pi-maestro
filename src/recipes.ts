import {
  createTask,
  listStoredRecipeFiles,
  normalizeTaskContract,
  planValidationMessage,
  removeStoredRecipe,
  saveStoredRecipe,
  validatePlan,
} from "./board.js";
import { loadConfig, userDataDirectory } from "./config.js";
import {
  type Board,
  type RecipeInput,
  type RecipeInputValue,
  type RecipeScope,
  type RecipeTask,
  type ResolvedRecipe,
  type WorkflowRecipe,
} from "./types.js";

export const RECIPE_VERSION = 1;

const RECIPE_KEYS = new Set(["kind", "version", "name", "description", "inputs", "tasks"]);
const INPUT_KEYS = new Set(["description", "required", "default"]);
const TASK_KEYS = new Set([
  "id",
  "title",
  "brief",
  "tier",
  "dependsOn",
  "writePaths",
  "successCriteria",
  "verificationProfile",
  "reviewPolicy",
  "commitMessage",
  "discovery",
]);
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RECIPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLACEHOLDER = /\{\{\s*input\.([A-Za-z][A-Za-z0-9_-]{0,63})\s*\}\}/g;

export function parseRecipe(text: string): WorkflowRecipe {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Recipe is not valid JSON.");
  }
  if (!isRecord(value)) throw new Error("Recipe must be a JSON object.");
  rejectUnknownFields(value, RECIPE_KEYS, "recipe");
  if (value.kind !== "pi-maestro-recipe" || value.version !== RECIPE_VERSION) {
    throw new Error("Unsupported recipe kind or version.");
  }
  if (typeof value.name !== "string" || !RECIPE_NAME.test(value.name)) {
    throw new Error("Recipe has an invalid name.");
  }
  if (value.description !== undefined && !isBoundedString(value.description, 1, 500)) {
    throw new Error("Recipe description must contain 1-500 characters.");
  }
  const inputs = parseInputs(value.inputs);
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 100) {
    throw new Error("Recipe tasks must contain 1-100 tasks.");
  }
  const tasks = value.tasks.map(parseTask);
  const ids = tasks.map((task) => task.id.trim().toUpperCase());
  if (new Set(ids).size !== ids.length) throw new Error("Recipe task ids must be unique.");

  return {
    kind: "pi-maestro-recipe",
    version: RECIPE_VERSION,
    name: value.name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(inputs ? { inputs } : {}),
    tasks,
  };
}

/** List valid effective recipes. Project files shadow same-name user files before parsing. */
export function loadRecipes(cwd: string): ResolvedRecipe[] {
  const effective = effectiveRecipeFiles(cwd);
  const recipes: ResolvedRecipe[] = [];
  for (const stored of effective.values()) {
    try {
      recipes.push(parseStoredRecipe(stored));
    } catch {
      // A malformed effective file is reported when explicitly inspected or run.
    }
  }
  return recipes.sort((left, right) => left.recipe.name.localeCompare(right.recipe.name));
}

export function resolveRecipe(cwd: string, name: string): ResolvedRecipe {
  const stored = effectiveRecipeFiles(cwd).get(name);
  if (!stored) throw new Error(`Unknown recipe: ${name}`);
  try {
    return parseStoredRecipe(stored);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${stored.scope} recipe "${name}" at ${stored.file}: ${message}`);
  }
}

export function saveRecipeFromBoard(
  scope: RecipeScope,
  cwd: string,
  name: string,
  board: Board
): string {
  if (!RECIPE_NAME.test(name)) throw new Error("Recipe has an invalid name.");
  if (board.tasks.length === 0) throw new Error("Cannot save an empty board as a recipe.");

  const tasks = board.tasks.map((task): RecipeTask => {
    const contract = normalizeTaskContract(task);
    return {
      id: task.id,
      title: task.title,
      brief: task.brief,
      tier: task.tier,
      dependsOn: [...task.dependsOn],
      writePaths: contract.writePaths,
      successCriteria: contract.successCriteria ?? [],
      ...(task.verificationProfile ? { verificationProfile: task.verificationProfile } : {}),
      ...(task.reviewPolicy ? { reviewPolicy: task.reviewPolicy } : {}),
      ...(task.commitMessage ? { commitMessage: task.commitMessage } : {}),
      ...(task.discovery
        ? { discovery: { allowedWritePaths: [...task.discovery.allowedWritePaths] } }
        : {}),
    };
  });
  const recipe: WorkflowRecipe = {
    kind: "pi-maestro-recipe",
    version: RECIPE_VERSION,
    name,
    tasks,
  };
  const text = `${JSON.stringify(recipe, null, 2)}\n`;
  const parsed = parseRecipe(text);
  const config = loadConfig(cwd);
  expandRecipe(
    parsed,
    {},
    Object.keys(config.tiers),
    Object.keys(config.verificationProfiles ?? {}),
    config.maxPlanTasks
  );
  return saveStoredRecipe(scope, cwd, name, text, userDirectory(scope));
}

export function removeRecipe(scope: RecipeScope, cwd: string, name: string): boolean {
  return removeStoredRecipe(scope, cwd, name, userDirectory(scope));
}

export function parseRecipeInput(text: string | undefined): Record<string, RecipeInputValue> {
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Recipe input must be a valid JSON object.");
  }
  if (!isRecord(value)) throw new Error("Recipe input must be a JSON object.");
  const result: Record<string, RecipeInputValue> = {};
  for (const [name, input] of Object.entries(value)) {
    if (!INPUT_NAME.test(name) || !isInputValue(input)) {
      throw new Error(`Recipe input "${name}" must be a string, finite number, or boolean.`);
    }
    result[name] = input;
  }
  return result;
}

export function expandRecipe(
  recipe: WorkflowRecipe,
  suppliedInput: Record<string, RecipeInputValue>,
  availableTiers: Iterable<string>,
  availableVerificationProfiles: Iterable<string>,
  maxPlanTasks = 64
): Board {
  const input = resolveInput(recipe.inputs ?? {}, suppliedInput);
  if (recipe.tasks.length > maxPlanTasks) {
    throw new Error(
      `Plan has ${recipe.tasks.length} tasks; configured maxPlanTasks is ${maxPlanTasks}.`
    );
  }
  const profiles = new Set(availableVerificationProfiles);
  const expandedTasks = recipe.tasks.map((task) => parseTask(expandTask(task, input)));
  const originalIds = expandedTasks.map((task) => task.id.trim().toUpperCase());
  const declaredIds = new Set(originalIds);
  if (declaredIds.size !== originalIds.length) {
    throw new Error("Expanded recipe task ids must be unique.");
  }

  for (const task of expandedTasks) {
    if (task.verificationProfile && !profiles.has(task.verificationProfile)) {
      throw new Error(`Unknown verification profile: ${task.verificationProfile}`);
    }
    for (const dependency of task.dependsOn) {
      if (!declaredIds.has(dependency.trim().toUpperCase())) {
        throw new Error(
          `Recipe task "${task.id}" references undeclared dependency "${dependency}".`
        );
      }
    }
    normalizeTaskContract(task);
    if (task.discovery && task.writePaths.length !== 0) {
      throw new Error("Recipe discovery tasks must use writePaths: [].");
    }
  }

  const board: Board = { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
  for (const task of expandedTasks) {
    createTask(board, {
      title: task.title,
      brief: task.brief,
      tier: task.tier,
      dependsOn: [],
      writePaths: task.writePaths,
      ...(task.successCriteria.length > 0 ? { successCriteria: task.successCriteria } : {}),
      ...(task.verificationProfile ? { verificationProfile: task.verificationProfile } : {}),
      ...(task.reviewPolicy ? { reviewPolicy: task.reviewPolicy } : {}),
      ...(task.commitMessage ? { commitMessage: task.commitMessage } : {}),
      ...(task.discovery
        ? { discovery: { allowedWritePaths: task.discovery.allowedWritePaths } }
        : {}),
    });
  }

  const idMap = new Map(originalIds.map((id, index) => [id, board.tasks[index]?.id]));
  for (const [index, task] of board.tasks.entries()) {
    task.dependsOn =
      expandedTasks[index]?.dependsOn.map((id) => idMap.get(id.trim().toUpperCase()) as string) ??
      [];
  }
  const error = planValidationMessage(validatePlan(board, availableTiers));
  if (error) throw new Error(error);
  return board;
}

function effectiveRecipeFiles(cwd: string) {
  const effective = new Map<string, ReturnType<typeof listStoredRecipeFiles>[number]>();
  for (const stored of listStoredRecipeFiles("user", cwd, userDirectory("user"))) {
    effective.set(stored.name, stored);
  }
  for (const stored of listStoredRecipeFiles("project", cwd)) effective.set(stored.name, stored);
  return effective;
}

function parseStoredRecipe(
  stored: ReturnType<typeof listStoredRecipeFiles>[number]
): ResolvedRecipe {
  const recipe = parseRecipe(stored.text);
  if (recipe.name !== stored.name) {
    throw new Error(`Recipe name "${recipe.name}" must match file name "${stored.name}".`);
  }
  return { recipe, scope: stored.scope, file: stored.file };
}

function parseInputs(value: unknown): Record<string, RecipeInput> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Recipe inputs must be an object.");
  if (Object.keys(value).length > 32) throw new Error("Recipe cannot declare more than 32 inputs.");
  const inputs: Record<string, RecipeInput> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!INPUT_NAME.test(name) || !isRecord(raw))
      throw new Error(`Recipe input "${name}" is malformed.`);
    rejectUnknownFields(raw, INPUT_KEYS, `recipe input "${name}"`);
    if (raw.description !== undefined && !isBoundedString(raw.description, 1, 300)) {
      throw new Error(`Recipe input "${name}" has an invalid description.`);
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean") {
      throw new Error(`Recipe input "${name}" required must be boolean.`);
    }
    if (raw.default !== undefined && !isInputValue(raw.default)) {
      throw new Error(`Recipe input "${name}" has an invalid default.`);
    }
    inputs[name] = {
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.required === "boolean" ? { required: raw.required } : {}),
      ...(raw.default !== undefined ? { default: raw.default as RecipeInputValue } : {}),
    };
  }
  return inputs;
}

function parseTask(value: unknown): RecipeTask {
  if (!isRecord(value)) throw new Error("Recipe contains a malformed task.");
  rejectUnknownFields(value, TASK_KEYS, "recipe task");
  for (const key of ["dependsOn", "writePaths", "successCriteria"] as const) {
    if (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === "string")) {
      throw new Error(`Recipe task ${key} must be an array of strings.`);
    }
  }
  for (const key of ["id", "title", "brief", "tier"] as const) {
    if (!isBoundedString(value[key], 1, key === "brief" ? 20_000 : 500)) {
      throw new Error(`Recipe task ${key} is invalid.`);
    }
  }
  if (
    value.verificationProfile !== undefined &&
    !isBoundedString(value.verificationProfile, 1, 64)
  ) {
    throw new Error("Recipe task verificationProfile is invalid.");
  }
  if (value.commitMessage !== undefined && !isBoundedString(value.commitMessage, 1, 500)) {
    throw new Error("Recipe task commitMessage is invalid.");
  }
  if (
    value.reviewPolicy !== undefined &&
    value.reviewPolicy !== "single" &&
    value.reviewPolicy !== "confirm" &&
    value.reviewPolicy !== "find-and-refute"
  ) {
    throw new Error("Recipe task reviewPolicy is invalid.");
  }
  if (
    value.discovery !== undefined &&
    (!isRecord(value.discovery) ||
      Object.keys(value.discovery).some((key) => key !== "allowedWritePaths") ||
      !Array.isArray(value.discovery.allowedWritePaths) ||
      value.discovery.allowedWritePaths.length < 1 ||
      !value.discovery.allowedWritePaths.every((path) => typeof path === "string"))
  ) {
    throw new Error("Recipe task discovery contract is invalid.");
  }
  return value as unknown as RecipeTask;
}

function resolveInput(
  definitions: Record<string, RecipeInput>,
  supplied: Record<string, RecipeInputValue>
): Record<string, RecipeInputValue> {
  for (const name of Object.keys(supplied)) {
    if (!Object.hasOwn(definitions, name)) throw new Error(`Unknown recipe input: ${name}`);
  }
  const resolved: Record<string, RecipeInputValue> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const value = supplied[name] ?? definition.default;
    if (value === undefined && definition.required)
      throw new Error(`Missing required recipe input: ${name}`);
    if (value !== undefined) resolved[name] = value;
  }
  return resolved;
}

function expandTask(task: RecipeTask, input: Record<string, RecipeInputValue>): RecipeTask {
  const expand = (value: string): string => {
    const expanded = value.replace(PLACEHOLDER, (_match, name: string) => {
      const replacement = input[name];
      if (replacement === undefined) throw new Error(`Missing recipe input used by task: ${name}`);
      return String(replacement);
    });
    if (expanded.includes("{{") || expanded.includes("}}")) {
      throw new Error("Recipe contains a malformed or unexpanded input placeholder.");
    }
    return expanded;
  };
  return {
    id: expand(task.id),
    title: expand(task.title),
    brief: expand(task.brief),
    tier: expand(task.tier),
    dependsOn: task.dependsOn.map(expand),
    writePaths: task.writePaths.map(expand),
    successCriteria: task.successCriteria.map(expand),
    ...(task.verificationProfile ? { verificationProfile: expand(task.verificationProfile) } : {}),
    ...(task.reviewPolicy ? { reviewPolicy: task.reviewPolicy } : {}),
    ...(task.commitMessage ? { commitMessage: expand(task.commitMessage) } : {}),
    ...(task.discovery
      ? { discovery: { allowedWritePaths: task.discovery.allowedWritePaths.map(expand) } }
      : {}),
  };
}

function userDirectory(scope: RecipeScope): string | undefined {
  return scope === "user" ? userDataDirectory() : undefined;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains unknown field "${unknown}".`);
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= maximum;
}

function isInputValue(value: unknown): value is RecipeInputValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
