import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  createTask,
  listStoredRecipeFiles,
  normalizeTaskContract,
  planValidationMessage,
  removeStoredRecipe,
  saveStoredRecipe,
  validatePlan,
} from "./board.js";
import { loadConfig } from "./config.js";
import {
  describeInvalid,
  RECIPE_INPUT_NAME,
  RECIPE_NAME,
  recipeInputValueValidator,
  recipeTaskValidator,
  workflowRecipeValidator,
} from "./schemas.js";
import {
  type Board,
  type RecipeInput,
  type RecipeInputValue,
  type RecipeScope,
  type RecipeTask,
  type ResolvedRecipe,
  type ReviewPolicy,
  type WorkflowRecipe,
} from "./types.js";

export const RECIPE_VERSION = 1;

const INPUT_NAME = new RegExp(RECIPE_INPUT_NAME);
const RECIPE_NAME_PATTERN = new RegExp(RECIPE_NAME);
const PLACEHOLDER = /\{\{\s*input\.([A-Za-z][A-Za-z0-9_-]{0,63})\s*\}\}/g;

export function parseRecipe(text: string): WorkflowRecipe {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Recipe is not valid JSON.");
  }
  if (!workflowRecipeValidator.check(value)) {
    throw new Error(`Recipe is invalid at ${describeInvalid(workflowRecipeValidator, value)}`);
  }
  const ids = value.tasks.map((task) => task.id.trim().toUpperCase());
  if (new Set(ids).size !== ids.length) throw new Error("Recipe task ids must be unique.");
  return value;
}

export interface RecipeListing {
  name: string;
  scope: RecipeScope;
  file: string;
  recipe?: WorkflowRecipe;
  error?: string;
}

/** List effective recipes, retaining malformed files as visible non-executable entries. */
export function loadRecipeListings(cwd: string): RecipeListing[] {
  return [...effectiveRecipeFiles(cwd).values()]
    .map((stored) => {
      try {
        return { ...stored, recipe: parseStoredRecipe(stored).recipe };
      } catch (error) {
        return {
          name: stored.name,
          scope: stored.scope,
          file: stored.file,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** List valid effective recipes. Project files shadow same-name user files before parsing. */
export function loadRecipes(cwd: string): ResolvedRecipe[] {
  return loadRecipeListings(cwd).flatMap((entry) =>
    entry.recipe ? [{ recipe: entry.recipe, scope: entry.scope, file: entry.file }] : []
  );
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
  if (!RECIPE_NAME_PATTERN.test(name)) throw new Error("Recipe has an invalid name.");
  if (board.tasks.length === 0) throw new Error("Cannot save an empty board as a recipe.");

  const tasks = board.tasks.map((task): RecipeTask => {
    const contract = normalizeTaskContract(task);
    return {
      id: task.id,
      title: task.title,
      brief: task.brief,
      ...(contract.kind ? { kind: contract.kind } : {}),
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
    config.maxPlanTasks,
    config.reviewPolicy
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
    if (!INPUT_NAME.test(name) || !recipeInputValueValidator.check(input)) {
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
  maxPlanTasks: number,
  /** The project's `reviewPolicy`, for tasks whose recipe states none. */
  defaultReviewPolicy: ReviewPolicy | undefined
): Board {
  const input = resolveInput(recipe.inputs ?? {}, suppliedInput);
  if (recipe.tasks.length > maxPlanTasks) {
    throw new Error(
      `Plan has ${recipe.tasks.length} tasks; configured maxPlanTasks is ${maxPlanTasks}.`
    );
  }
  const profiles = new Set(availableVerificationProfiles);
  const expandedTasks = recipe.tasks.map((task) => parseExpandedTask(expandTask(task, input)));
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
    const reviewPolicy = task.reviewPolicy ?? defaultReviewPolicy;
    createTask(board, {
      title: task.title,
      brief: task.brief,
      ...(task.kind ? { kind: task.kind } : {}),
      tier: task.tier,
      dependsOn: [],
      writePaths: task.writePaths,
      ...(task.successCriteria.length > 0 ? { successCriteria: task.successCriteria } : {}),
      ...(task.verificationProfile ? { verificationProfile: task.verificationProfile } : {}),
      ...(reviewPolicy ? { reviewPolicy } : {}),
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

function parseExpandedTask(expanded: RecipeTask): RecipeTask {
  const task: unknown = expanded;
  if (recipeTaskValidator.check(task)) return task;
  const problem = describeInvalid(recipeTaskValidator, task);
  throw new Error(`Recipe task "${expanded.id}" is invalid after expansion at ${problem}`);
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
    ...(task.kind ? { kind: task.kind } : {}),
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
  return scope === "user" ? getAgentDir() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
