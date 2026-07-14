import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTask, loadBoard, saveBoard, saveStoredRecipe } from "../src/board.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";
import {
  expandRecipe,
  loadRecipes,
  parseRecipe,
  resolveRecipe,
  saveRecipeFromBoard,
} from "../src/recipes.js";
import { type Board, type RecipeTask, type Task, type WorkflowRecipe } from "../src/types.js";

function withRecipeStorage(run: (cwd: string, agentDir: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-recipe-project-"));
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-recipe-user-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    saveConfig("project", cwd, { ...DEFAULT_CONFIG, autoCommit: false });
    run(cwd, agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function validBoard(): Board {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  createTask(board, {
    title: "Implement feature",
    brief: "Implement the feature",
    tier: "standard",
    writePaths: ["src/feature.ts"],
    successCriteria: ["The feature works"],
  });
  return board;
}

function firstTask(board: Board): Task {
  const task = board.tasks[0];
  assert.ok(task);
  return task;
}

function firstRecipeTask(value: WorkflowRecipe): RecipeTask {
  const task = value.tasks[0];
  assert.ok(task);
  return task;
}

function recipe(name: string, title = "Work"): WorkflowRecipe {
  return {
    kind: "pi-maestro-recipe",
    version: 1,
    name,
    tasks: [
      {
        id: "first",
        title,
        brief: "Implement work",
        tier: "standard",
        dependsOn: [],
        writePaths: ["src/work.ts"],
        successCriteria: ["Work passes"],
      },
    ],
  };
}

test("recipe schema rejects executable fields", () => {
  for (const field of ["javascript", "shell", "hooks", "command"]) {
    assert.throws(
      () => parseRecipe(JSON.stringify({ ...recipe("unsafe"), [field]: "touch owned" })),
      /unknown field/i
    );
  }
  const value = recipe("unsafe-task") as unknown as { tasks: Array<Record<string, unknown>> };
  const task = value.tasks[0];
  assert.ok(task);
  task.command = "pnpm test";
  assert.throws(() => parseRecipe(JSON.stringify(value)), /unknown field/i);
});

test("failed saves create no recipe file and leave board bytes unchanged", () => {
  withRecipeStorage((cwd) => {
    const cases: Array<{ name: string; mutate: (board: Board) => void; error: RegExp }> = [
      {
        name: "missing-scope",
        mutate: (board) => delete firstTask(board).writePaths,
        error: /writePaths is required/,
      },
      {
        name: "empty-executable-scope",
        mutate: (board) => {
          firstTask(board).writePaths = [];
        },
        error: /empty writePaths requires/,
      },
      {
        name: "missing-criteria",
        mutate: (board) => delete firstTask(board).successCriteria,
        error: /successCriteria is required/,
      },
      {
        name: "empty-criteria",
        mutate: (board) => {
          firstTask(board).successCriteria = [];
        },
        error: /successCriteria must contain 1-12 items/,
      },
      {
        name: "unknown-tier",
        mutate: (board) => {
          firstTask(board).tier = "imaginary";
        },
        error: /unknown tier/i,
      },
      {
        name: "unknown-profile",
        mutate: (board) => {
          firstTask(board).verificationProfile = "untrusted";
        },
        error: /Unknown verification profile/,
      },
      {
        name: "invalid-dependency",
        mutate: (board) => {
          firstTask(board).dependsOn = ["T9"];
        },
        error: /undeclared dependency/,
      },
      {
        name: "dependency-cycle",
        mutate: (board) => {
          firstTask(board).dependsOn = ["T2"];
          createTask(board, {
            title: "Second",
            brief: "Implement second",
            tier: "standard",
            dependsOn: ["T1"],
            writePaths: ["src/second.ts"],
            successCriteria: ["Second works"],
          });
        },
        error: /dependency cycle/,
      },
      {
        name: "invalid-path",
        mutate: (board) => {
          firstTask(board).writePaths = ["../outside"];
        },
        error: /Invalid repository-relative write path/,
      },
    ];

    for (const item of cases) {
      const board = validBoard();
      item.mutate(board);
      saveBoard(cwd, board);
      const boardFile = join(cwd, ".pi", "maestro", "board.json");
      const before = readFileSync(boardFile, "utf-8");
      assert.throws(
        () => saveRecipeFromBoard("project", cwd, item.name, loadBoard(cwd)),
        item.error
      );
      assert.equal(existsSync(join(cwd, ".pi", "maestro-recipes", `${item.name}.json`)), false);
      assert.equal(readFileSync(boardFile, "utf-8"), before);
    }
  });
});

test("valid no-file recipe saves and configured project tiers are effective", () => {
  withRecipeStorage((cwd) => {
    const standardTier = DEFAULT_CONFIG.tiers.standard;
    assert.ok(standardTier);
    saveConfig("project", cwd, {
      ...DEFAULT_CONFIG,
      tiers: { ...DEFAULT_CONFIG.tiers, specialist: standardTier },
    });
    const board = validBoard();
    const task = firstTask(board);
    task.brief = "Read-only investigation with no-file changes";
    task.tier = "specialist";
    task.writePaths = [];
    delete task.successCriteria;

    const file = saveRecipeFromBoard("project", cwd, "investigate", board);
    assert.equal(existsSync(file), true);
    assert.deepEqual(resolveRecipe(cwd, "investigate").recipe.tasks[0]?.writePaths, []);
  });
});

test("only trusted user verification profiles can be saved", () => {
  withRecipeStorage((cwd) => {
    saveConfig("user", cwd, {
      ...DEFAULT_CONFIG,
      verificationProfiles: { trusted: { command: "pnpm test", timeoutSeconds: 60 } },
    });
    const trusted = validBoard();
    firstTask(trusted).verificationProfile = "trusted";
    assert.doesNotThrow(() => saveRecipeFromBoard("project", cwd, "trusted", trusted));

    saveConfig("project", cwd, {
      ...DEFAULT_CONFIG,
      verificationProfiles: { projectCommand: { command: "touch owned", timeoutSeconds: 60 } },
    });
    const projectOnly = validBoard();
    firstTask(projectOnly).verificationProfile = "projectCommand";
    assert.throws(
      () => saveRecipeFromBoard("project", cwd, "project-command", projectOnly),
      /Unknown verification profile/
    );
  });
});

test("project filename precedence is selected before parsing", () => {
  withRecipeStorage((cwd, agentDir) => {
    saveStoredRecipe("user", cwd, "shared", "{malformed", agentDir);
    saveStoredRecipe("project", cwd, "shared", `${JSON.stringify(recipe("shared", "Project"))}\n`);
    saveStoredRecipe("user", cwd, "unrelated-bad", "{malformed", agentDir);
    saveStoredRecipe(
      "user",
      cwd,
      "other",
      `${JSON.stringify(recipe("other", "Other"))}\n`,
      agentDir
    );

    assert.equal(resolveRecipe(cwd, "shared").recipe.tasks[0]?.title, "Project");
    assert.deepEqual(
      loadRecipes(cwd).map(({ recipe: value }) => value.name),
      ["other", "shared"]
    );
  });
});

test("malformed effective recipes fail with scoped file context", () => {
  withRecipeStorage((cwd) => {
    saveStoredRecipe("project", cwd, "broken", "{malformed");
    assert.throws(
      () => resolveRecipe(cwd, "broken"),
      new RegExp(
        `Invalid project recipe.*broken.*${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "s"
      )
    );
  });
});

test("recipe expansion creates an ordinary gated plan and validates dependencies", () => {
  const parsed = parseRecipe(JSON.stringify(recipe("run")));
  const board = expandRecipe(parsed, {}, ["standard"], []);
  assert.equal(board.planPending, true);
  assert.equal(board.tasks[0]?.status, "todo");
  assert.throws(
    () =>
      expandRecipe(
        { ...parsed, tasks: [{ ...firstRecipeTask(parsed), dependsOn: ["missing"] }] },
        {},
        ["standard"],
        []
      ),
    /undeclared dependency/
  );
});

test("recipe save and expansion preserve strict discovery contracts", () => {
  withRecipeStorage((cwd) => {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    createTask(board, {
      title: "Discover",
      brief: "Read-only investigation with no-file changes",
      tier: "standard",
      writePaths: [],
      discovery: { allowedWritePaths: ["src/**"] },
      reviewPolicy: "confirm",
    });

    saveRecipeFromBoard("project", cwd, "discovery", board);
    const saved = resolveRecipe(cwd, "discovery").recipe;
    assert.deepEqual(saved.tasks[0]?.discovery?.allowedWritePaths, ["src/**"]);
    const expanded = expandRecipe(saved, {}, ["standard"], []);
    assert.deepEqual(expanded.tasks[0]?.discovery?.allowedWritePaths, ["src/**"]);
    assert.equal(expanded.tasks[0]?.reviewPolicy, "confirm");

    const unsafe = structuredClone(saved) as unknown as { tasks: Array<Record<string, unknown>> };
    const first = unsafe.tasks[0];
    assert.ok(first);
    first.discovery = { allowedWritePaths: ["src/**"], shell: "touch owned" };
    assert.throws(() => parseRecipe(JSON.stringify(unsafe)), /discovery contract is invalid/);
  });
});
