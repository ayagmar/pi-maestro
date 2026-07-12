import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import maestro, {
  assertKnownTaskIds,
  maestroBoardCwd,
  previousBoardSession,
  sessionCanControlDrive,
  sessionSwitchBlocked,
} from "../src/index.js";
import { createTask, findTask, listArchivedBoards, loadBoard, saveBoard } from "../src/board.js";
import { DEFAULT_CONFIG, REVIEW_TOOLS, saveConfig } from "../src/config.js";
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

interface CommandCtx {
  cwd: string;
  hasUI: boolean;
  mode: "tui";
  modelRegistry: object;
  sessionManager: {
    getSessionFile: () => string;
    getSessionName: () => string | undefined;
  };
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
} {
  const notices: string[] = [];
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
    sendMessage: () => {},
  };
  const unusedExecutor: StartExecutor = () => {
    throw new Error("unexpected executor start");
  };
  maestro(pi as unknown as ExtensionAPI, { startExecutor: startExecutor ?? unusedExecutor });
  assert.ok(command, "maestro must register its command");
  return { ctx, notices, command, tools, events };
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
        "1 attempt · $0.0200 total · $0.0200 avg billed attempt · models: openai/gpt-5-mini · providers: openai"
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

test("maestro_status appends the cost report to its output", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      task.attempts.push(billedAttempt(0.02, "openai/gpt-5-mini"));
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const status = tools.get("maestro_status");
      assert.ok(status, "maestro_status must be registered");
      const result = await status.execute("call", {}, undefined, undefined, ctx);
      const text = result.content[0]?.text ?? "";
      assert.match(text, /Costs: 1 attempt · \$0\.0200 total/);
      assert.match(text, /models: openai\/gpt-5-mini · providers: openai/);
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
        () => findTask(loadBoard(cwd), "T1")?.status === "approved",
        "provider-blocked drive did not resume"
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

test("maestro_drive reserves background ownership before returning and preserves its status", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let finishExecutor!: (outcome: RunOutcome) => void;
      const executorOutcome = new Promise<RunOutcome>((resolve) => {
        finishExecutor = resolve;
      });
      const startExecutor: StartExecutor = (options) => {
        if (options.prompt.includes("adversarial code reviewer")) {
          return {
            attempt: executorAttempt(),
            outcome: Promise.resolve({
              exitCode: 0,
              usage: { input: 1, output: 1, cost: 0.01, turns: 1 },
              finalReport: "Verified.\nVERDICT: APPROVE",
              touchedFiles: [],
              aborted: false,
            }),
            steer: () => {},
            abort: () => {},
          };
        }
        queueMicrotask(() => {
          options.onUpdate?.({ turns: 2, cost: 0.25, lastActivity: "bash" });
        });
        return {
          attempt: executorAttempt(),
          outcome: executorOutcome,
          steer: () => {},
          abort: () => {},
        };
      };
      const { ctx, tools } = loadMaestro(cwd, startExecutor);
      const drive = tools.get("maestro_drive");
      const status = tools.get("maestro_status");
      assert.ok(drive && status);

      const firstStart = drive.execute("drive", {}, undefined, undefined, ctx);
      const duplicateStart = assert.rejects(
        drive.execute("duplicate", {}, undefined, undefined, ctx),
        /An autonomous drive is already active/
      );

      const started = await firstStart;
      await duplicateStart;
      assert.match(started.content[0]?.text ?? "", /Drive started/);
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "running",
        "drive did not start"
      );

      const pulse = await status.execute("status", { waitSeconds: 0 }, undefined, undefined, ctx);
      assert.match(pulse.content[0]?.text ?? "", /executing · 2 turns · \$0\.2500 · bash/);
      assert.match(pulse.content[0]?.text ?? "", /Drive still active/);

      finishExecutor({
        exitCode: 0,
        usage: { input: 1, output: 1, cost: 0.25, turns: 2 },
        finalReport: "Work completed",
        touchedFiles: [],
        aborted: false,
      });
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "approved",
        "background drive did not finish"
      );
      const completed = await status.execute(
        "status",
        { waitSeconds: 0 },
        undefined,
        undefined,
        ctx
      );
      assert.match(completed.content[0]?.text ?? "", /Drive completed after 1 round/);
    }
  );
});

test("maestro_drive keeps its AbortSignal cancellation lifecycle", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const controller = new AbortController();
      const startExecutor: StartExecutor = (options) => {
        const outcome = new Promise<RunOutcome>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              resolve({
                exitCode: 1,
                usage: { input: 0, output: 0, cost: 0, turns: 0 },
                finalReport: "",
                touchedFiles: [],
                aborted: true,
              });
            },
            { once: true }
          );
        });
        return { attempt: executorAttempt(), outcome, steer: () => {}, abort: () => {} };
      };
      const { ctx, tools } = loadMaestro(cwd, startExecutor);
      const drive = tools.get("maestro_drive");
      const status = tools.get("maestro_status");
      assert.ok(drive && status);

      await drive.execute("drive", {}, controller.signal, undefined, ctx);
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "running",
        "tool drive did not start"
      );
      controller.abort();
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "cancelled",
        "tool signal did not cancel the active executor"
      );

      const result = await status.execute("status", { waitSeconds: 1 }, undefined, undefined, ctx);
      assert.match(result.content[0]?.text ?? "", /Drive aborted after 1 round/);
    }
  );
});

test("tool drive pause and resume retain background status ownership", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let finishExecutor!: (outcome: RunOutcome) => void;
      const executorOutcome = new Promise<RunOutcome>((resolve) => {
        finishExecutor = resolve;
      });
      let reviewerStarted!: () => void;
      const reviewStarted = new Promise<void>((resolve) => {
        reviewerStarted = resolve;
      });
      let finishReviewer!: (outcome: RunOutcome) => void;
      const reviewerOutcome = new Promise<RunOutcome>((resolve) => {
        finishReviewer = resolve;
      });
      const startExecutor: StartExecutor = (options) => {
        if (options.prompt.includes("adversarial code reviewer")) {
          reviewerStarted();
          return {
            attempt: executorAttempt(),
            outcome: reviewerOutcome,
            steer: () => {},
            abort: () => {},
          };
        }
        return {
          attempt: executorAttempt(),
          outcome: executorOutcome,
          steer: () => {},
          abort: () => {},
        };
      };
      const { ctx, command, tools } = loadMaestro(cwd, startExecutor);
      const drive = tools.get("maestro_drive");
      const status = tools.get("maestro_status");
      assert.ok(drive && status);

      await drive.execute("drive", { taskIds: ["T1"] }, undefined, undefined, ctx);
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "running",
        "tool drive did not start"
      );
      await command.handler("pause", ctx);
      finishExecutor({
        exitCode: 0,
        usage: { input: 1, output: 1, cost: 0.01, turns: 1 },
        finalReport: "Work completed",
        touchedFiles: [],
        aborted: false,
      });
      await waitFor(() => loadBoard(cwd).pausedDrive !== undefined, "tool drive did not pause");

      await command.handler("resume", ctx);
      await reviewStarted;
      const resumed = await status.execute("status", { waitSeconds: 0 }, undefined, undefined, ctx);
      const resumedText = resumed.content[0]?.text ?? "";
      assert.match(resumedText, /reviewing/);
      assert.match(resumedText, /Drive still active with 1 live executor/);
      assert.doesNotMatch(resumedText, /Drive paused/);

      finishReviewer({
        exitCode: 0,
        usage: { input: 1, output: 1, cost: 0.01, turns: 1 },
        finalReport: "Verified.\nVERDICT: APPROVE",
        touchedFiles: [],
        aborted: false,
      });
      const completed = await status.execute(
        "status",
        { waitSeconds: 1 },
        undefined,
        undefined,
        ctx
      );
      assert.match(completed.content[0]?.text ?? "", /Drive completed after 1 round/);
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

function approvingReviewer(): RunOutcome {
  return {
    exitCode: 0,
    usage: { input: 1, output: 1, cost: 0, turns: 1 },
    finalReport: "Verified.\nVERDICT: APPROVE",
    touchedFiles: [],
    aborted: false,
  };
}

test("maestro_review reports one bounded retention warning and still approves", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, { title: "Review me", brief: "done", tier: "standard" });
      task.status = "ready_for_review";
      const completed = executorAttempt();
      completed.index = 1;
      completed.finalReport = "Implemented and verified";
      task.attempts.push(completed);
      saveBoard(cwd, board);

      const maestroDir = join(cwd, ".pi", "maestro");
      mkdirSync(maestroDir, { recursive: true });
      writeFileSync(join(maestroDir, "logs"), "temporarily not a directory");
    },
    async (cwd) => {
      const startExecutor: StartExecutor = () => ({
        attempt: executorAttempt(),
        outcome: Promise.resolve(approvingReviewer()),
        steer: () => {},
        abort: () => {},
      });
      const { ctx, notices, tools } = loadMaestro(cwd, startExecutor);
      const review = tools.get("maestro_review");
      assert.ok(review);

      const result = await review.execute("review", { taskIds: ["T1"] }, undefined, undefined, ctx);

      assert.equal(findTask(loadBoard(cwd), "T1")?.status, "approved");
      assert.match(result.content[0]?.text ?? "", /approved/i);
      const warnings = notices.filter((notice) => notice.startsWith("Log cleanup warning:"));
      assert.equal(warnings.length, 1);
      assert.ok((warnings[0]?.length ?? 0) <= 280);
      assert.equal(warnings[0]?.includes(cwd), false);
    }
  );
});

function altSession(ctx: CommandCtx, sessionFile: string): CommandCtx {
  return {
    ...ctx,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionName: () => undefined,
    },
  };
}

test("maestro_status honors the configured pulse wait for an active drive", async () => {
  await withBoard(
    (cwd) => {
      saveConfig("project", cwd, {
        ...DEFAULT_CONFIG,
        autoCommit: false,
        statusWaitSeconds: 0.05,
      });
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const startExecutor: StartExecutor = (options) => {
        const outcome = new Promise<RunOutcome>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                exitCode: 1,
                usage: { input: 0, output: 0, cost: 0, turns: 0 },
                finalReport: "",
                touchedFiles: [],
                aborted: true,
              }),
            { once: true }
          );
        });
        return { attempt: executorAttempt(), outcome, steer: () => {}, abort: () => {} };
      };
      const { ctx, command, tools } = loadMaestro(cwd, startExecutor);
      const status = tools.get("maestro_status");
      assert.ok(status);

      await command.handler("drive T1", ctx);
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "running",
        "drive did not start"
      );

      // No waitSeconds override: the pulse must fall back to the configured wait.
      const started = Date.now();
      const pulse = await status.execute("status", {}, undefined, undefined, ctx);
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed >= 40,
        `pulse returned too fast (${elapsed}ms) for a 0.05s configured wait`
      );
      assert.match(pulse.content[0]?.text ?? "", /Drive still active/);

      await command.handler("abort", ctx);
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "cancelled",
        "abort cleanup did not finish"
      );
    }
  );
});

test("maestro_status reports progress deltas and the settled completed summary", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let finishExecutor!: (outcome: RunOutcome) => void;
      const executorOutcome = new Promise<RunOutcome>((resolve) => {
        finishExecutor = resolve;
      });
      const startExecutor: StartExecutor = (options) => {
        if (options.prompt.includes("adversarial code reviewer")) {
          return {
            attempt: executorAttempt(),
            outcome: Promise.resolve(approvingReviewer()),
            steer: () => {},
            abort: () => {},
          };
        }
        return {
          attempt: executorAttempt(),
          outcome: executorOutcome,
          steer: () => {},
          abort: () => {},
        };
      };
      const { ctx, tools } = loadMaestro(cwd, startExecutor);
      const drive = tools.get("maestro_drive");
      const status = tools.get("maestro_status");
      assert.ok(drive && status);

      await drive.execute("drive", {}, undefined, undefined, ctx);
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "running",
        "drive did not start"
      );

      // First pulse: no baseline yet, so no delta line.
      const first = await status.execute("status", { waitSeconds: 0 }, undefined, undefined, ctx);
      assert.doesNotMatch(first.content[0]?.text ?? "", /Advanced since last pulse/);

      finishExecutor({
        exitCode: 0,
        usage: { input: 1, output: 1, cost: 0.02, turns: 2 },
        finalReport: "Work completed",
        touchedFiles: [],
        aborted: false,
      });
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "approved",
        "drive did not finish"
      );

      const second = await status.execute("status", { waitSeconds: 0 }, undefined, undefined, ctx);
      const text = second.content[0]?.text ?? "";
      assert.match(text, /Advanced since last pulse: T1 running \u2192 approved/);
      assert.match(text, /Drive completed after 1 round/);
    }
  );
});

test("maestro_status surfaces a provider block with a recovery decision", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const startExecutor: StartExecutor = () => ({
        attempt: executorAttempt(),
        outcome: Promise.resolve({
          exitCode: 1,
          usage: { input: 1, output: 0, cost: 0, turns: 1 },
          finalReport: "",
          touchedFiles: [],
          aborted: false,
          errorMessage: "HTTP 429 too many requests",
          failureCause: "provider" as const,
        }),
        steer: () => {},
        abort: () => {},
      });
      const { ctx, tools } = loadMaestro(cwd, startExecutor);
      const drive = tools.get("maestro_drive");
      const status = tools.get("maestro_status");
      assert.ok(drive && status);

      await drive.execute("drive", {}, undefined, undefined, ctx);
      await waitFor(() => loadBoard(cwd).pausedDrive !== undefined, "provider block was not saved");

      const pulse = await status.execute("status", { waitSeconds: 0 }, undefined, undefined, ctx);
      const text = pulse.content[0]?.text ?? "";
      assert.match(text, /Provider access blocked/);
      assert.match(text, /Failures: T1 \u2014/);
      assert.match(text, /configure another fallback/);
      assert.match(text, /Do not blindly retry/);
    }
  );
});

test("maestro_status surfaces a review escalation with an intervention decision", async () => {
  await withBoard(
    (cwd) => {
      saveConfig("project", cwd, {
        ...DEFAULT_CONFIG,
        autoCommit: false,
        maxAttempts: 5,
        tiers: {
          standard: { thinking: "medium" },
          complex: { thinking: "high" },
          review: { thinking: "high", tools: REVIEW_TOOLS },
        },
      });
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const startExecutor: StartExecutor = (options) => {
        if (options.prompt.includes("adversarial code reviewer")) {
          return {
            attempt: executorAttempt(),
            outcome: Promise.resolve({
              exitCode: 0,
              usage: { input: 1, output: 1, cost: 0, turns: 1 },
              finalReport: "VERDICT: REQUEST_CHANGES\n1. Still wrong in src/thing.ts.",
              touchedFiles: [],
              aborted: false,
            }),
            steer: () => {},
            abort: () => {},
          };
        }
        return {
          attempt: executorAttempt(),
          outcome: Promise.resolve({
            exitCode: 0,
            usage: { input: 1, output: 1, cost: 0, turns: 1 },
            finalReport: "done",
            touchedFiles: [],
            aborted: false,
          }),
          steer: () => {},
          abort: () => {},
        };
      };
      const { ctx, tools } = loadMaestro(cwd, startExecutor);
      const drive = tools.get("maestro_drive");
      const status = tools.get("maestro_status");
      assert.ok(drive && status);

      await drive.execute("drive", {}, undefined, undefined, ctx);
      await waitFor(
        () => (findTask(loadBoard(cwd), "T1")?.reviewRejections ?? 0) >= 2,
        "task was not rejected twice"
      );

      const pulse = await status.execute("status", { waitSeconds: 1 }, undefined, undefined, ctx);
      const text = pulse.content[0]?.text ?? "";
      assert.match(text, /Reviewer rejected the same work 2 times/);
      assert.match(text, /maestro_update to raise the tier or rewrite the brief/);
      assert.match(text, /Do not blindly retry or raise maxAttempts/);
    }
  );
});

test("a settled drive summary is owned by its session and cleared only after that session observes it", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Work", brief: "do it", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const startExecutor: StartExecutor = (options) => {
        if (options.prompt.includes("adversarial code reviewer")) {
          return {
            attempt: executorAttempt(),
            outcome: Promise.resolve(approvingReviewer()),
            steer: () => {},
            abort: () => {},
          };
        }
        return {
          attempt: executorAttempt(),
          outcome: Promise.resolve({
            exitCode: 0,
            usage: { input: 1, output: 1, cost: 0.02, turns: 1 },
            finalReport: "Work completed",
            touchedFiles: [],
            aborted: false,
          }),
          steer: () => {},
          abort: () => {},
        };
      };
      const { ctx, tools } = loadMaestro(cwd, startExecutor);
      const drive = tools.get("maestro_drive");
      const status = tools.get("maestro_status");
      assert.ok(drive && status);

      await drive.execute("drive", {}, undefined, undefined, ctx);
      await waitFor(
        () => findTask(loadBoard(cwd), "T1")?.status === "approved",
        "drive did not finish"
      );

      // Another session must not observe or clear the owner's settled summary.
      const stranger = altSession(ctx, other);
      const strangerPulse = await status.execute(
        "status",
        { waitSeconds: 0 },
        undefined,
        undefined,
        stranger
      );
      assert.match(strangerPulse.content[0]?.text ?? "", /owned by another session/);
      assert.doesNotMatch(strangerPulse.content[0]?.text ?? "", /Drive completed/);

      // The owner still sees the completed summary; a second owner pulse is clean.
      const ownerPulse = await status.execute(
        "status",
        { waitSeconds: 0 },
        undefined,
        undefined,
        ctx
      );
      assert.match(ownerPulse.content[0]?.text ?? "", /Drive completed after 1 round/);
      const afterObserved = await status.execute(
        "status",
        { waitSeconds: 0 },
        undefined,
        undefined,
        ctx
      );
      assert.match(afterObserved.content[0]?.text ?? "", /No background drive is active/);
    }
  );
});
