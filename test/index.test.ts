import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { createTask, findTask, listArchivedBoards, loadBoard, saveBoard } from "../src/board.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";
import maestro, {
  assertKnownTaskIds,
  maestroBoardCwd,
  previousBoardSession,
  sessionCanControlDrive,
  sessionSwitchBlocked,
} from "../src/index.js";
import { type RunOutcome } from "../src/runner.js";
import { type Attempt, type Board } from "../src/types.js";
import { type StartExecutor } from "../src/workflow.js";

const owner = "/sessions/orchestrator.jsonl";
const executor = "/sessions/executor.jsonl";
const other = "/sessions/other.jsonl";

test("restores owner → worktree executor → owner navigation", () => {
  const boardCwd = maestroBoardCwd("/repo/.pi/maestro/worktrees/t7-attempt-1");
  assert.equal(boardCwd, "/repo");

  assert.equal(previousBoardSession(owner, executor, [owner], [executor]), owner);
  assert.equal(previousBoardSession(executor, owner, [owner], [executor]), executor);
});

test("supports repeated back toggling between a board owner and executor", () => {
  let current = executor;
  let previous = previousBoardSession(owner, current, [owner], [executor]);

  for (const expected of [owner, executor, owner, executor]) {
    assert.equal(previous, expected);
    const nextCurrent = previous;
    previous = previousBoardSession(current, nextCurrent, [owner], [executor]);
    current = nextCurrent;
  }
});

test("drive controls stay with their owning session", () => {
  assert.equal(sessionCanControlDrive(owner, owner), true);
  assert.equal(sessionCanControlDrive(owner, other), false);
  assert.equal(sessionCanControlDrive(undefined, other), true);
  assert.equal(sessionCanControlDrive(owner, undefined), true);
});

test("session switches are blocked for active drive ownership or live executors", () => {
  assert.equal(sessionSwitchBlocked(true, 0), true);
  assert.equal(sessionSwitchBlocked(false, 1), true);
  assert.equal(sessionSwitchBlocked(true, 2), true);
  assert.equal(sessionSwitchBlocked(false, 0), false);
});

test("explicit dispatch rejects unknown task ids", () => {
  const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
  createTask(board, { title: "Known", brief: "work", tier: "standard" });

  assert.doesNotThrow(() => assertKnownTaskIds(board, ["t1"]));
  assert.throws(() => assertKnownTaskIds(board, ["T1", "T99"]), /Unknown task id.*T99/);
});

test("does not restore unrelated sessions or cross executor boundaries", () => {
  assert.equal(previousBoardSession(other, owner, [owner], [executor]), undefined);
  assert.equal(previousBoardSession(executor, other, [owner], [executor]), undefined);
  assert.equal(
    previousBoardSession(executor, "/sessions/reviewer.jsonl", [owner], [executor]),
    undefined
  );
  assert.equal(previousBoardSession(owner, executor, undefined, [executor]), undefined);
});

// --------------------------------------------------------- command harness

interface RegisteredCommand {
  getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
  handler: (args: string, ctx: CommandCtx) => Promise<void>;
}

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: CommandCtx
  ) => Promise<{ content: { type: string; text?: string }[] }>;
  renderResult?: (
    result: { content: { type: string; text?: string }[]; details?: unknown },
    options: { expanded: boolean },
    theme: Theme
  ) => { render: (width: number) => string[] };
}

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

interface TestTui {
  requestRender: () => void;
  terminal: { rows: number };
}

interface TestComponent {
  handleInput: (data: string) => void;
}

interface NewSessionOptions {
  parentSession?: string;
  setup?: (sessionManager: { appendSessionInfo: (name: string) => string }) => Promise<void>;
  withSession?: (ctx: FreshCtx) => Promise<void>;
}

interface FreshCtx extends CommandCtx {
  sendMessage: (message: unknown, options?: { triggerTurn?: boolean }) => Promise<void>;
}

interface CommandCtx {
  cwd: string;
  hasUI: boolean;
  mode: "tui";
  modelRegistry: object;
  sessionManager: {
    getSessionFile: () => string;
    getSessionName: () => string | undefined;
  };
  waitForIdle?: () => Promise<void>;
  newSession?: (options: NewSessionOptions) => Promise<{ cancelled: boolean }>;
  ui: {
    theme: typeof fakeTheme;
    notify: (message: string, level?: string) => void;
    setStatus: () => void;
    setWidget: () => void;
    custom?: <T>(
      factory: (
        tui: TestTui,
        theme: Theme,
        keybindings: object,
        done: (value: T) => void
      ) => TestComponent
    ) => Promise<T>;
    confirm?: (title: string, message: string) => Promise<boolean>;
  };
}

type EventHandler = (event: unknown, ctx: CommandCtx) => unknown;

interface TuiStep {
  keys: string[];
  before?: () => void;
}

interface UiScript {
  steps: TuiStep[];
  confirmations?: boolean[];
}

const enter = "\r";
const escapeKey = "\x1b";
const down = "\x1b[B";
const clearLine = "\x15";
const deleteForward = "\x1b[3~";

function select(index: number): string[] {
  return [...Array.from({ length: index }, () => down), enter];
}

function loadMaestro(
  cwd: string,
  startExecutor?: StartExecutor,
  sessionFile = owner,
  uiScript?: UiScript
): {
  ctx: CommandCtx;
  notices: string[];
  command: RegisteredCommand;
  tools: Map<string, RegisteredTool>;
  events: Map<string, EventHandler>;
  userMessages: Array<{ message: string; options?: { deliverAs?: string } }>;
  messages: Array<{ message: unknown; options?: { triggerTurn?: boolean; deliverAs?: string } }>;
} {
  const notices: string[] = [];
  const userMessages: Array<{ message: string; options?: { deliverAs?: string } }> = [];
  const messages: Array<{
    message: unknown;
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }> = [];
  const ui = {
    theme: fakeTheme,
    notify: (message: string) => {
      notices.push(message);
    },
    setStatus: () => {},
    setWidget: () => {},
    custom: async <T>(
      factory: (
        tui: TestTui,
        theme: Theme,
        keybindings: object,
        done: (value: T) => void
      ) => TestComponent
    ): Promise<T> => {
      const step = uiScript?.steps.shift();
      assert.ok(step, "unexpected TUI modal");
      return await new Promise<T>((resolve) => {
        const component = factory(
          { requestRender: () => {}, terminal: { rows: 40 } },
          fakeTheme,
          {},
          resolve
        );
        step.before?.();
        for (const key of step.keys) component.handleInput(key);
      });
    },
    confirm: async (): Promise<boolean> => uiScript?.confirmations?.shift() ?? false,
  };
  const ctx: CommandCtx = {
    cwd,
    hasUI: true,
    mode: "tui",
    modelRegistry: {},
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionName: () => undefined,
    },
    ui,
  };
  let command: RegisteredCommand | undefined;
  const tools = new Map<string, RegisteredTool>();
  const events = new Map<string, EventHandler>();
  // The maestro extension is inert inside a spawned executor; clear the flag so
  // the command and tools register when the test suite inherits it.
  delete process.env.PI_MAESTRO_EXECUTOR;
  const pi = {
    on: (name: string, handler: EventHandler) => events.set(name, handler),
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: (_name: string, options: RegisteredCommand) => {
      command = options;
    },
    registerShortcut: () => {},
    registerMessageRenderer: () => {},
    setSessionName: () => {},
    sendMessage: (message: unknown, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
      messages.push({ message, ...(options ? { options } : {}) });
    },
    sendUserMessage: (message: string, options?: { deliverAs?: string }) => {
      userMessages.push({ message, ...(options ? { options } : {}) });
    },
  };
  const unusedExecutor: StartExecutor = () => {
    throw new Error("unexpected executor start");
  };
  maestro(pi as unknown as ExtensionAPI, { startExecutor: startExecutor ?? unusedExecutor });
  assert.ok(command, "maestro must register its command");
  return { ctx, notices, command, tools, events, userMessages, messages };
}

test("session startup preserves a running task with an active dispatch lease", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-startup-recovery-test-"));
  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    const task = createTask(board, { title: "Running", brief: "work", tier: "standard" });
    task.status = "running";
    task.dispatchClaim = {
      id: "live-owner",
      kind: "execute",
      claimedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    saveBoard(cwd, board);

    const { ctx, events } = loadMaestro(cwd);
    events.get("session_start")?.({ previousSessionFile: undefined }, ctx);

    const recovered = findTask(loadBoard(cwd), task.id);
    assert.equal(recovered?.status, "running");
    assert.equal(recovered?.dispatchClaim?.id, "live-owner");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function billedAttempt(cost: number, model: string): Attempt {
  return {
    index: 1,
    logFile: "x.jsonl",
    thinking: "low",
    startedAt: 0,
    usage: { input: 100, output: 50, cost, turns: 1 },
    touchedFiles: [],
    model,
  };
}

async function withBoard(
  setup: (cwd: string) => void,
  run: (cwd: string) => Promise<void>
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-command-test-"));
  try {
    saveConfig("project", cwd, { ...DEFAULT_CONFIG, autoCommit: false });
    setup(cwd);
    await run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("gated plan editor saves title, brief, tier, dependencies, and cancellation explicitly", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
      createTask(board, { title: "Old title", brief: "Old brief", tier: "standard" });
      createTask(board, { title: "Dependency", brief: "Prepare work", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const script: UiScript = {
        steps: [
          { keys: [enter] },
          { keys: [enter] },
          {
            keys: [
              ...Array.from({ length: "Old title".length }, () => deleteForward),
              "New title",
              enter,
            ],
          },
          { keys: select(1) },
          { keys: [clearLine, "New self-contained brief", enter] },
          { keys: select(2) },
          { keys: select(2) },
          { keys: select(3) },
          { keys: [clearLine, "t2", enter] },
          { keys: select(4) },
          { keys: select(1) },
          {
            keys: select(5),
            before: () => {
              const unsaved = findTask(loadBoard(cwd), "T1");
              assert.equal(unsaved?.title, "Old title");
              assert.equal(unsaved?.brief, "Old brief");
              assert.equal(unsaved?.tier, "standard");
              assert.deepEqual(unsaved?.dependsOn, []);
              assert.equal(unsaved?.status, "todo");
            },
          },
          { keys: [escapeKey] },
        ],
      };
      const { ctx, notices, command } = loadMaestro(cwd, undefined, owner, script);

      await command.handler("plan", ctx);

      const saved = findTask(loadBoard(cwd), "T1");
      assert.equal(saved?.title, "New title");
      assert.equal(saved?.brief, "New self-contained brief");
      assert.equal(saved?.tier, "complex");
      assert.deepEqual(saved?.dependsOn, ["T2"]);
      assert.equal(saved?.status, "cancelled");
      assert.ok(notices.includes("T1 plan changes saved."));
      assert.equal(script.steps.length, 0);
    }
  );
});

test("gated plan editor cancel discards draft changes", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
      createTask(board, { title: "Original", brief: "Keep this", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const script: UiScript = {
        steps: [
          { keys: [enter] },
          { keys: [enter] },
          { keys: [clearLine, "Discarded title", enter] },
          { keys: select(6) },
          { keys: [escapeKey] },
        ],
      };
      const before = loadBoard(cwd);
      const { ctx, notices, command } = loadMaestro(cwd, undefined, owner, script);

      await command.handler("plan", ctx);

      assert.deepEqual(loadBoard(cwd), before);
      assert.equal(
        notices.some((notice) => notice.includes("changes saved")),
        false
      );
      assert.equal(script.steps.length, 0);
    }
  );
});

test("gated plan approval reports invalid references and cycles without changing the board", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
      createTask(board, {
        title: "First",
        brief: "First work",
        tier: "standard",
        dependsOn: ["T2", "T99"],
      });
      createTask(board, {
        title: "Second",
        brief: "Second work",
        tier: "standard",
        dependsOn: ["T1"],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const script: UiScript = { steps: [{ keys: select(2) }, { keys: [escapeKey] }] };
      const before = loadBoard(cwd);
      const { ctx, notices, command } = loadMaestro(cwd, undefined, owner, script);

      await command.handler("plan", ctx);

      assert.deepEqual(loadBoard(cwd), before);
      assert.match(notices[0] ?? "", /T1 references unknown dependency "T99"/);
      assert.match(notices[0] ?? "", /dependency cycle: T1 → T2 → T1/);
      assert.match(notices[0] ?? "", /Edit the listed tasks before approving/);
      assert.equal(script.steps.length, 0);
    }
  );
});

test("gated plan rejection confirmation archives and clears the board", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
      createTask(board, { title: "Reject me", brief: "Work", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const script: UiScript = { steps: [{ keys: select(2) }], confirmations: [true] };
      const { ctx, notices, command } = loadMaestro(cwd, undefined, owner, script);

      await command.handler("plan", ctx);

      assert.deepEqual(loadBoard(cwd).tasks, []);
      assert.equal(listArchivedBoards(cwd).length, 1);
      assert.match(notices[0] ?? "", /Plan rejected\. Board archived at/);
      assert.equal(script.steps.length, 0);
      assert.deepEqual(script.confirmations, []);
    }
  );
});

test("/maestro costs reports the empty board plainly", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { ctx, notices, command } = loadMaestro(cwd);
      await command.handler("costs", ctx);
      assert.deepEqual(notices, ["No recorded costs; the board is empty."]);
    }
  );
});

test("/maestro costs summarizes attempts, cost, and identities", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      task.attempts.push(billedAttempt(0.02, "openai/gpt-5-mini"));
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, notices, command } = loadMaestro(cwd);
      await command.handler("costs", ctx);
      assert.equal(
        notices[0],
        "1 attempt · $0.0200 total · $0.0200 avg billed attempt · models: openai/gpt-5-mini · providers: openai · other spend: $0.0200 · reconciled: $0.0200"
      );
    }
  );
});

test("/maestro costs is offered by argument completion and dispatches case-insensitively", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { ctx, notices, command } = loadMaestro(cwd);
      const completions = command.getArgumentCompletions?.("co");
      assert.ok(completions?.some((item) => item.value === "costs"));
      await command.handler("COSTS", ctx);
      assert.deepEqual(notices, ["No recorded costs; the board is empty."]);
    }
  );
});

test("/maestro simulate is deterministic and starts no executors or board writes", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let starts = 0;
      const { ctx, notices, command } = loadMaestro(cwd, () => {
        starts += 1;
        throw new Error("simulation must not start an executor");
      });
      const before = JSON.stringify(loadBoard(cwd));
      await command.handler("simulate T1", ctx);
      assert.match(notices[0] ?? "", /Mechanical simulation/);
      assert.equal(starts, 0);
      assert.equal(JSON.stringify(loadBoard(cwd)), before);
    }
  );
});

test("/maestro help lists the costs command", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { ctx, notices, command } = loadMaestro(cwd);
      await command.handler("", ctx);
      assert.match(notices[0] ?? "", /\/maestro costs/);
    }
  );
});

test("registers exactly the three public model tools", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { tools } = loadMaestro(cwd);
      assert.deepEqual([...tools.keys()].sort(), [
        "maestro_drive",
        "maestro_plan",
        "maestro_update",
      ]);
    }
  );
});

test("maestro_plan requires bounded write scope except explicit no-file work", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const plan = tools.get("maestro_plan");
      assert.ok(plan);
      await assert.rejects(
        plan.execute(
          "missing-scope",
          { tasks: [{ title: "Code", brief: "Change code", tier: "standard" }] },
          undefined,
          undefined,
          ctx
        ),
        /writePaths is required/
      );
      await assert.rejects(
        plan.execute(
          "missing-criteria",
          {
            tasks: [
              {
                title: "Code",
                brief: "Change code",
                tier: "standard",
                writePaths: ["src/code.ts"],
              },
            ],
          },
          undefined,
          undefined,
          ctx
        ),
        /successCriteria is required/
      );
      await plan.execute(
        "investigation",
        {
          tasks: [
            {
              title: "Investigate",
              brief: "Read-only investigation with no-file changes",
              tier: "standard",
              writePaths: [],
            },
          ],
        },
        undefined,
        undefined,
        ctx
      );
      assert.deepEqual(findTask(loadBoard(cwd), "T1")?.writePaths, []);
    }
  );
});

test("incremental recovery planning does not reopen the initial plan gate", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, { title: "Capped", brief: "Old work", tier: "standard" });
      task.status = "failed";
      task.attempts.push({
        index: 1,
        logFile: "attempt.jsonl",
        thinking: "medium",
        startedAt: 1,
        endedAt: 2,
        exitCode: 1,
        usage: { input: 0, output: 0, cost: 0, turns: 1 },
        touchedFiles: [],
      });
      saveBoard(cwd, board);
      saveConfig("project", cwd, { ...DEFAULT_CONFIG, planGate: true });
    },
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const plan = tools.get("maestro_plan");
      assert.ok(plan);
      await plan.execute(
        "successor",
        {
          tasks: [
            {
              title: "Successor for T1",
              brief: "Continue the approved goal after capped T1",
              tier: "standard",
              writePaths: ["src/fix.ts"],
              successCriteria: ["The replacement work passes"],
            },
          ],
        },
        undefined,
        undefined,
        ctx
      );
      assert.equal(loadBoard(cwd).planPending, undefined);
    }
  );
});

test("maestro_drive inspect returns bounded board state without starting work", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Inspect me", brief: "stay idle", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const drive = tools.get("maestro_drive");
      assert.ok(drive);
      const result = await drive.execute(
        "inspect",
        { action: "inspect" },
        undefined,
        undefined,
        ctx
      );
      assert.match(result.content[0]?.text ?? "", /No live executors/);
      assert.equal(findTask(loadBoard(cwd), "T1")?.status, "todo");
    }
  );
});

const invalidDriveInputs = [
  [{ action: "inspect", taskIds: ["T1"] }, /inspect does not accept/],
  [{ action: "inspect", intervention: "abort" }, /inspect does not accept/],
  [{ action: "intervene" }, /intervention is required/],
  [{ action: "intervene", intervention: "abort", taskIds: ["T1"] }, /does not accept taskIds/],
  [{ action: "intervene", intervention: "steer" }, /steer requires an instruction/],
  [{ action: "intervene", intervention: "abort", instruction: "wrong" }, /only valid for steer/],
  [{ action: "start", intervention: "abort" }, /start does not accept/],
] as const;

for (const [input, expected] of invalidDriveInputs) {
  test(`maestro_drive rejects incompatible input ${JSON.stringify(input)}`, async () => {
    await withBoard(
      () => {},
      async (cwd) => {
        const { ctx, tools } = loadMaestro(cwd);
        const drive = tools.get("maestro_drive");
        assert.ok(drive);
        await assert.rejects(drive.execute("invalid", input, undefined, undefined, ctx), expected);
      }
    );
  });
}

test("maestro_drive handoff routes through the human command", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { ctx, tools, userMessages } = loadMaestro(cwd);
      const result = await tools
        .get("maestro_drive")
        ?.execute(
          "handoff",
          { action: "intervene", intervention: "handoff" },
          undefined,
          undefined,
          ctx
        );
      assert.deepEqual(userMessages, [
        { message: "/maestro handoff", options: { deliverAs: "followUp" } },
      ]);
      assert.match(result?.content[0]?.text ?? "", /handoff queued/);
    }
  );
});

test("maestro_drive start rejects unknown scoped task ids before reserving ownership", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const drive = tools.get("maestro_drive");
      assert.ok(drive);
      await assert.rejects(
        drive.execute("start", { action: "start", taskIds: ["T404"] }, undefined, undefined, ctx),
        /Unknown task id/
      );
      assert.equal(loadBoard(cwd).pausedDrive, undefined);
    }
  );
});

function executorAttempt(): Attempt {
  return {
    index: 0,
    logFile: "test.jsonl",
    thinking: "low",
    startedAt: Date.now(),
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("slash drive can pause live work without aborting it, persist ownership, and resume fresh", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let started!: () => void;
      const executorStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finishExecutor!: (outcome: RunOutcome) => void;
      const executorOutcome = new Promise<RunOutcome>((resolve) => {
        finishExecutor = resolve;
      });
      let abortCalls = 0;
      let starts = 0;
      const startExecutor: StartExecutor = (options) => {
        starts += 1;
        if (options.prompt.includes("adversarial code reviewer")) {
          return {
            attempt: executorAttempt(),
            outcome: Promise.resolve({
              exitCode: 0,
              usage: { input: 1, output: 1, cost: 0, turns: 1 },
              finalReport: "Verified.\nVERDICT: APPROVE",
              touchedFiles: [],
              aborted: false,
            }),
            steer: () => {},
            abort: () => {
              abortCalls += 1;
            },
          };
        }
        started();
        return {
          attempt: executorAttempt(),
          outcome: executorOutcome,
          steer: () => {},
          abort: () => {
            abortCalls += 1;
          },
        };
      };
      const { ctx, command } = loadMaestro(cwd, startExecutor);

      await command.handler("drive T1", ctx);
      await executorStarted;
      await command.handler("pause", ctx);
      assert.equal(abortCalls, 0, "pause must not abort the active executor");

      finishExecutor({
        exitCode: 0,
        usage: { input: 1, output: 1, cost: 0, turns: 1 },
        finalReport: "Work completed",
        touchedFiles: [],
        aborted: false,
      });
      await waitFor(() => loadBoard(cwd).pausedDrive !== undefined, "drive did not pause");

      const pausedBoard = loadBoard(cwd);
      assert.deepEqual(pausedBoard.pausedDrive, { taskIds: ["T1"], ownerSession: owner });
      assert.equal(findTask(pausedBoard, "T1")?.status, "ready_for_review");
      assert.equal(abortCalls, 0);

      await command.handler("resume", ctx);
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "approved",
        "resumed drive did not review fresh board state"
      );
      assert.equal(loadBoard(cwd).pausedDrive, undefined);
      assert.equal(starts, 2, "resume should review the persisted attempt, not rerun it");
    }
  );
});

test("provider-blocked slash drive persists resumable state without hot-looping", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let blocked = true;
      let starts = 0;
      const startExecutor: StartExecutor = (options) => {
        starts += 1;
        if (options.prompt.includes("adversarial code reviewer")) {
          return {
            attempt: executorAttempt(),
            outcome: Promise.resolve({
              exitCode: 0,
              usage: { input: 1, output: 1, cost: 0, turns: 1 },
              finalReport: "Verified.\nVERDICT: APPROVE",
              touchedFiles: [],
              aborted: false,
            }),
            steer: () => {},
            abort: () => {},
          };
        }
        return {
          attempt: executorAttempt(),
          outcome: Promise.resolve(
            blocked
              ? {
                  exitCode: 1,
                  usage: { input: 1, output: 0, cost: 0, turns: 1 },
                  finalReport: "",
                  touchedFiles: [],
                  aborted: false,
                  errorMessage: "HTTP 429 too many requests",
                  failureCause: "provider" as const,
                }
              : {
                  exitCode: 0,
                  usage: { input: 1, output: 1, cost: 0, turns: 1 },
                  finalReport: "Work completed",
                  touchedFiles: [],
                  aborted: false,
                }
          ),
          steer: () => {},
          abort: () => {},
        };
      };
      const { ctx, command } = loadMaestro(cwd, startExecutor);

      await command.handler("drive T1", ctx);
      await waitFor(() => loadBoard(cwd).pausedDrive !== undefined, "provider block was not saved");
      assert.equal(starts, 1, "blocked provider must not be retried in the background");
      assert.equal(findTask(loadBoard(cwd), "T1")?.status, "failed");

      blocked = false;
      await command.handler("resume", ctx);
      await waitFor(
        () => loadBoard(cwd).tasks.length === 0,
        "provider-blocked drive did not resume and clean the completed board"
      );
      assert.equal(loadBoard(cwd).pausedDrive, undefined);
      assert.equal(starts, 3);
    }
  );
});

test("paused drive ownership blocks resume and abort from another session", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = {
        version: 1,
        nextTaskNumber: 1,
        pausedDrive: { taskIds: ["T1"], ownerSession: owner },
        tasks: [],
      };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, notices, command } = loadMaestro(cwd, undefined, other);

      await command.handler("resume", ctx);
      await command.handler("abort", ctx);

      assert.deepEqual(loadBoard(cwd).pausedDrive, {
        taskIds: ["T1"],
        ownerSession: owner,
      });
      assert.match(notices[0] ?? "", /Only the session that paused this drive may resume/);
      assert.match(notices[1] ?? "", /Only the session that paused this drive may abort/);
    }
  );
});

test("slash abort cancels an active drive and its executor", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let started!: () => void;
      const executorStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const startExecutor: StartExecutor = (options) => {
        started();
        const outcome = new Promise<RunOutcome>((resolve) => {
          options.signal?.addEventListener("abort", () => {
            resolve({
              exitCode: 1,
              usage: { input: 0, output: 0, cost: 0, turns: 0 },
              finalReport: "",
              touchedFiles: [],
              aborted: true,
            });
          });
        });
        return { attempt: executorAttempt(), outcome, steer: () => {}, abort: () => {} };
      };
      const { ctx, command } = loadMaestro(cwd, startExecutor);

      await command.handler("drive", ctx);
      await executorStarted;
      await command.handler("abort", ctx);
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "cancelled",
        "abort did not cancel the active executor"
      );
      assert.equal(loadBoard(cwd).pausedDrive, undefined);
    }
  );
});

test("handoff replaces the session once and briefs the fresh supervisor context", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, goal: "Ship reliably", tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, command } = loadMaestro(cwd, undefined, owner, {
        steps: [],
        confirmations: [true],
      });
      const sent: Array<{ message: unknown; options?: { triggerTurn?: boolean } }> = [];
      let calls = 0;
      let receivedOptions: NewSessionOptions | undefined;
      const sessionNames: string[] = [];
      ctx.waitForIdle = async () => {};
      ctx.newSession = async (options) => {
        calls++;
        receivedOptions = options;
        await options.setup?.({
          appendSessionInfo: (name) => {
            sessionNames.push(name);
            return "session-info-id";
          },
        });
        const fresh: FreshCtx = {
          ...ctx,
          sessionManager: {
            getSessionFile: () => "/sessions/fresh.jsonl",
            getSessionName: () => undefined,
          },
          sendMessage: async (message, sendOptions) => {
            sent.push({ message, ...(sendOptions ? { options: sendOptions } : {}) });
          },
        };
        await options.withSession?.(fresh);
        return { cancelled: false };
      };

      await command.handler("handoff", ctx);

      assert.equal(calls, 1);
      assert.equal(receivedOptions?.parentSession, owner);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0]?.options, { triggerTurn: true });
      assert.match(JSON.stringify(sent[0]?.message), /Ship reliably/);
      assert.deepEqual(sessionNames, ["supervisor: Ship reliably"]);
      assert.ok(loadBoard(cwd).ownerSessions?.includes("/sessions/fresh.jsonl"));
    }
  );
});

test("handoff does not access an invalidated command context during replacement failure", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, command, notices } = loadMaestro(cwd, undefined, owner, {
        steps: [],
        confirmations: [true],
      });
      ctx.waitForIdle = async () => {};
      ctx.newSession = async () => {
        Object.defineProperties(ctx, {
          hasUI: {
            get: () => {
              throw new Error("stale command context");
            },
          },
          ui: {
            get: () => {
              throw new Error("stale command context");
            },
          },
          sessionManager: {
            get: () => {
              throw new Error("stale command context");
            },
          },
        });
        throw new Error("replacement failed before callback");
      };

      await assert.doesNotReject(command.handler("handoff", ctx));
      assert.ok(notices.some((notice) => notice.includes("Could not start maestro handoff")));
      assert.ok(notices.some((notice) => notice.includes("replacement failed before callback")));
    }
  );
});

test("handoff guards a captured notification that becomes stale during replacement", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, command } = loadMaestro(cwd, undefined, owner, {
        steps: [],
        confirmations: [true],
      });
      ctx.waitForIdle = async () => {};
      let notificationIsStale = false;
      const notify = ctx.ui.notify;
      ctx.ui.notify = (message, level) => {
        if (notificationIsStale) {
          throw new Error("stale notification");
        }
        notify(message, level);
      };
      ctx.newSession = async () => {
        notificationIsStale = true;
        throw new Error("replacement failed");
      };

      await assert.doesNotReject(command.handler("handoff", ctx));
    }
  );
});

test("handoff reports fresh-session callback failures without rejecting", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, command, notices } = loadMaestro(cwd, undefined, owner, {
        steps: [],
        confirmations: [true],
      });
      ctx.waitForIdle = async () => {};
      ctx.newSession = async (options) => {
        const fresh: FreshCtx = {
          ...ctx,
          sendMessage: async () => {
            throw new Error("send failed");
          },
        };
        await options.withSession?.(fresh);
        return { cancelled: false };
      };

      await assert.doesNotReject(command.handler("handoff", ctx));
      assert.ok(notices.some((notice) => notice.includes("Could not complete maestro handoff")));
      assert.ok(notices.some((notice) => notice.includes("send failed")));
    }
  );
});

test("idle session switches are allowed by the maestro guard", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-idle-switch-test-"));
  try {
    const { ctx, events } = loadMaestro(cwd);
    const beforeSwitch = events.get("session_before_switch");
    assert.ok(beforeSwitch);
    assert.equal(beforeSwitch({ reason: "new" }, ctx), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("handoff refuses an empty board or live executors", async () => {
  await withBoard(
    (cwd) => saveBoard(cwd, { version: 1, nextTaskNumber: 1, tasks: [] }),
    async (cwd) => {
      const { ctx, command, notices } = loadMaestro(cwd);
      await command.handler("handoff", ctx);
      assert.ok(notices.some((notice) => notice.includes("board is empty")));
    }
  );

  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let started!: () => void;
      const executorStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const startExecutor: StartExecutor = (options) => {
        started();
        return {
          attempt: executorAttempt(),
          outcome: new Promise<RunOutcome>((resolve) => {
            options.signal?.addEventListener("abort", () =>
              resolve({
                exitCode: 1,
                usage: { input: 0, output: 0, cost: 0, turns: 0 },
                finalReport: "",
                touchedFiles: [],
                aborted: true,
              })
            );
          }),
          steer: () => {},
          abort: () => {},
        };
      };
      const { ctx, command, notices } = loadMaestro(cwd, startExecutor);
      await command.handler("drive", ctx);
      await executorStarted;
      await command.handler("handoff", ctx);
      assert.ok(notices.some((notice) => notice.includes("executor(s) still running")));
      await command.handler("abort", ctx);
    }
  );
});

test("session switches are cancelled while a slash drive owns active work", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let started!: () => void;
      const executorStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const startExecutor: StartExecutor = (options) => {
        started();
        const outcome = new Promise<RunOutcome>((resolve) => {
          options.signal?.addEventListener("abort", () => {
            resolve({
              exitCode: 1,
              usage: { input: 0, output: 0, cost: 0, turns: 0 },
              finalReport: "",
              touchedFiles: [],
              aborted: true,
            });
          });
        });
        return { attempt: executorAttempt(), outcome, steer: () => {}, abort: () => {} };
      };
      const { ctx, command, events } = loadMaestro(cwd, startExecutor);

      await command.handler("drive", ctx);
      await executorStarted;
      const beforeSwitch = events.get("session_before_switch");
      assert.ok(beforeSwitch);
      assert.deepEqual(beforeSwitch({}, ctx), { cancel: true });

      await command.handler("abort", ctx);
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "cancelled",
        "cleanup abort did not finish"
      );
    }
  );
});

test("drive results render the completed summary even with task details present", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { tools } = loadMaestro(cwd);
      const drive = tools.get("maestro_drive");
      assert.ok(drive?.renderResult, "maestro_drive must render its result");
      const rendered = drive.renderResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: {
            action: "drive",
            rounds: 2,
            tasks: [
              {
                id: "T1",
                title: "Work",
                status: "approved",
                tier: "standard",
                attempts: 1,
                cost: 0.02,
                turns: 1,
                history: [],
              },
            ],
            stoppedBecause: { code: "completed", message: "all selected tasks are approved" },
          },
        },
        { expanded: false },
        fakeTheme
      );
      const text = rendered.render(200).join("\n");
      assert.match(text, /T1 Work approved/);
      assert.match(text, /Drive completed after 2 round\(s\): 1 approved/);
    }
  );
});

function _approvingReviewer(): RunOutcome {
  return {
    exitCode: 0,
    usage: { input: 1, output: 1, cost: 0, turns: 1 },
    finalReport: "Verified.\nVERDICT: APPROVE",
    touchedFiles: [],
    aborted: false,
  };
}

function _altSession(ctx: CommandCtx, sessionFile: string): CommandCtx {
  return {
    ...ctx,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionName: () => undefined,
    },
  };
}

test("completed drives archive and clear tasks by default", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Finish", brief: "complete work", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const startExecutor: StartExecutor = (options) => ({
        attempt: executorAttempt(),
        outcome: Promise.resolve({
          exitCode: 0,
          usage: { input: 1, output: 1, cost: 0, turns: 1 },
          finalReport: options.runId.includes("-review-") ? "VERDICT: APPROVE" : "done",
          touchedFiles: [],
          aborted: false,
        }),
        steer: () => {},
        abort: () => {},
      });
      const { ctx, tools, events, messages } = loadMaestro(cwd, startExecutor);
      const drive = tools.get("maestro_drive");
      assert.ok(drive);
      await drive.execute("drive", { action: "start" }, undefined, undefined, ctx);
      await waitFor(() => loadBoard(cwd).tasks.length === 0, "completed board cleanup");
      assert.equal(listArchivedBoards(cwd).length, 1);
      const decision = loadBoard(cwd).activeDecision;
      assert.equal(decision?.kind, "completed");
      assert.ok(decision?.deliveredAt);
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0]?.options, { triggerTurn: true, deliverAs: "followUp" });

      events.get("session_start")?.({ previousSessionFile: owner }, ctx);
      assert.equal(messages.length, 1, "a delivered decision must not wake the owner twice");
    }
  );
});

test("settled decisions are owner-scoped, inspectable, and resolve exactly once", async () => {
  await withBoard(
    (cwd) => {
      saveBoard(cwd, {
        version: 1,
        nextTaskNumber: 1,
        tasks: [],
        activeDecision: {
          id: "decision-1",
          ownerSession: owner,
          kind: "provider_blocked",
          taskIds: ["T1"],
          evidence: "Provider quota exhausted",
          allowedInterventions: ["handoff"],
          createdAt: Date.now(),
          deliveredAt: Date.now(),
        },
      });
    },
    async (cwd) => {
      const { ctx, tools, userMessages } = loadMaestro(cwd);
      const drive = tools.get("maestro_drive");
      assert.ok(drive);
      const inspected = await drive.execute(
        "inspect",
        { action: "inspect" },
        undefined,
        undefined,
        ctx
      );
      assert.match(inspected.content[0]?.text ?? "", /decision-1.*Provider quota exhausted/);

      await drive.execute(
        "resolve",
        { action: "intervene", intervention: "handoff", decisionId: "decision-1" },
        undefined,
        undefined,
        ctx
      );
      assert.equal(loadBoard(cwd).activeDecision?.resolution?.intervention, "handoff");
      assert.equal(userMessages.length, 1);
      await assert.rejects(
        drive.execute(
          "stale",
          { action: "intervene", intervention: "handoff", decisionId: "decision-1" },
          undefined,
          undefined,
          ctx
        ),
        /stale or already resolved/
      );
    }
  );
});

test("an undelivered decision is not delivered to a foreign session", async () => {
  await withBoard(
    (cwd) => {
      saveBoard(cwd, {
        version: 1,
        nextTaskNumber: 1,
        tasks: [],
        activeDecision: {
          id: "owner-only",
          ownerSession: owner,
          kind: "blocked",
          taskIds: [],
          evidence: "Needs owner judgment",
          allowedInterventions: ["handoff"],
          createdAt: Date.now(),
        },
      });
    },
    async (cwd) => {
      const { ctx, events, messages } = loadMaestro(cwd, undefined, other);
      events.get("session_start")?.({ previousSessionFile: owner }, ctx);
      assert.equal(messages.length, 0);
      assert.equal(loadBoard(cwd).activeDecision?.deliveredAt, undefined);
    }
  );
});

test("completed task cleanup can be disabled", async () => {
  await withBoard(
    (cwd) => {
      saveConfig("project", cwd, { ...DEFAULT_CONFIG, cleanupCompletedTasks: false });
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, { title: "Keep", brief: "keep report", tier: "standard" });
      task.status = "approved";
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const drive = tools.get("maestro_drive");
      assert.ok(drive);
      await drive.execute("drive", { action: "start" }, undefined, undefined, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(loadBoard(cwd).tasks.length, 1);
    }
  );
});
