import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { taskFingerprint } from "../src/artifact-policy.js";
import {
  consumeQuarantineNotice,
  createTask,
  findTask,
  listArchivedBoards,
  loadBoard,
  saveBoard,
  saveStoredRecipe,
  updateBoard,
} from "../src/board.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";
import { deliverPendingDecision } from "../src/drive-controller.js";
import { exportPlan } from "../src/plan-serialization.js";
import maestro, {
  assertKnownTaskIds,
  maestroBoardCwd,
  previousBoardSession,
  scrollableTextOffset,
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
  assert.equal(sessionCanControlDrive(owner, undefined), false);
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
  parameters?: unknown;
  prepareArguments?: (args: unknown) => unknown;
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
    getEntries?: () => unknown[];
    getLeafId?: () => string | undefined;
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
    setWorkingMessage: (message?: string) => void;
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
  beforeConfirm?: () => void;
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
    setWorkingMessage: () => {},
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
    confirm: async (): Promise<boolean> => {
      uiScript?.beforeConfirm?.();
      return uiScript?.confirmations?.shift() ?? false;
    },
  };
  const ctx: CommandCtx = {
    cwd,
    hasUI: true,
    mode: "tui",
    modelRegistry: {},
    sessionManager: {
      getLeafId: () => "leaf-1",
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
    setLabel: () => {},
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

test("start warns when git is required but not ready", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-command-test-"));
  try {
    saveConfig("project", cwd, { ...DEFAULT_CONFIG, autoCommit: true });
    const loaded = loadMaestro(cwd);
    await loaded.command.handler("start test goal", loaded.ctx);
    assert.ok(loaded.notices.some((notice) => notice.includes("Git repo not ready")));
    assert.ok(loaded.notices.some((notice) => notice.includes("/maestro doctor")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unknown maestro subcommands identify the requested command", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const loaded = loadMaestro(cwd);
      await loaded.command.handler("wat", loaded.ctx);
      assert.match(loaded.notices.at(-1) ?? "", /^Unknown subcommand "wat"\. Available commands:/);
    }
  );
});

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
          { keys: select(1) },
          { keys: select(1) },
          {
            keys: [
              ...Array.from({ length: "Old title".length }, () => deleteForward),
              "New title",
              enter,
            ],
          },
          { keys: select(2) },
          { keys: [clearLine, "New self-contained brief", enter] },
          { keys: select(3) },
          { keys: select(2) },
          { keys: select(4) },
          { keys: [clearLine, "t2", enter] },
          { keys: select(10) },
          { keys: select(1) },
          { keys: select(9) },
          { keys: select(1) },
          {
            keys: select(11),
            before: () => {
              const unsaved = findTask(loadBoard(cwd), "T1");
              assert.equal(unsaved?.title, "Old title");
              assert.equal(unsaved?.brief, "Old brief");
              assert.equal(unsaved?.tier, "standard");
              assert.deepEqual(unsaved?.dependsOn, []);
              assert.equal(unsaved?.status, "todo");
              assert.equal(unsaved?.reviewPolicy, undefined);
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
      assert.equal(saved?.reviewPolicy, "confirm");
      assert.ok(notices.includes("T1 plan changes saved."));
      assert.equal(script.steps.length, 0);
    }
  );
});

test("gated plan editor persists a cleared commit message", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
      createTask(board, {
        title: "Task",
        brief: "Do work",
        tier: "standard",
        commitMessage: "fix: old message",
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const script: UiScript = {
        steps: [
          { keys: select(1) },
          { keys: select(7) },
          {
            keys: [
              ...Array.from({ length: "fix: old message".length }, () => deleteForward),
              enter,
            ],
          },
          { keys: select(11) },
          { keys: [escapeKey] },
        ],
      };
      const { ctx, command } = loadMaestro(cwd, undefined, owner, script);

      await command.handler("plan", ctx);

      assert.equal(findTask(loadBoard(cwd), "T1")?.commitMessage, undefined);
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
          { keys: select(1) },
          { keys: select(1) },
          { keys: [clearLine, "Discarded title", enter] },
          { keys: select(12) },
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
      const script: UiScript = { steps: [{ keys: select(3) }, { keys: [escapeKey] }] };
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

test("gated plan approval refuses a board changed during scale confirmation", async () => {
  await withBoard(
    (cwd) => {
      saveConfig("project", cwd, {
        ...DEFAULT_CONFIG,
        autoCommit: false,
        confirmationPlanTasks: 1,
      });
      const board: Board = { version: 1, nextTaskNumber: 1, planPending: true, tasks: [] };
      createTask(board, {
        title: "First",
        brief: "Implement first",
        tier: "standard",
        writePaths: ["src/first.ts"],
        successCriteria: ["First works"],
      });
      createTask(board, {
        title: "Second",
        brief: "Implement second",
        tier: "standard",
        writePaths: ["src/second.ts"],
        successCriteria: ["Second works"],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const script: UiScript = {
        steps: [{ keys: select(3) }],
        confirmations: [true],
        beforeConfirm: () => {
          updateBoard(cwd, (board) => {
            const task = findTask(board, "T1");
            assert.ok(task);
            task.title = "Concurrent edit";
            return true;
          });
        },
      };
      const { ctx, notices, command } = loadMaestro(cwd, undefined, owner, script);

      await command.handler("plan", ctx);

      const board = loadBoard(cwd);
      assert.equal(findTask(board, "T1")?.title, "Concurrent edit");
      assert.equal(board.planPending, true);
      assert.equal(board.scaleApproval, undefined);
      assert.match(notices.at(-1) ?? "", /changed after preflight confirmation/);
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
      const script: UiScript = { steps: [{ keys: select(3) }], confirmations: [true] };
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
        "run: 1 attempt · $0.0200 total · $0.0200 avg (billed)\nmodels: openai/gpt-5-mini\nproviders: openai\nspend: other $0.0200 · reconciled $0.0200"
      );
    }
  );
});

test("history command skips valid-JSON malformed rows and prints valid entries", async () => {
  await withBoard(
    (cwd) => {
      const directory = join(cwd, ".pi", "maestro");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "history.jsonl"),
        [
          JSON.stringify({
            ts: "2026-07-13T23:59:00.000Z",
            taskId: "T1",
            from: "todo",
            to: "running",
            revision: 1,
          }),
          JSON.stringify({
            ts: "2026-07-14T00:01:00.000Z",
            taskId: "T1",
            from: "running",
            to: "ready_for_review",
            revision: 2,
          }),
          "null",
          "{}",
          JSON.stringify({ ts: "now", taskId: "T1", from: "todo", to: "done" }),
        ].join("\n")
      );
    },
    async (cwd) => {
      const { command, ctx, notices } = loadMaestro(cwd);
      await command.handler("history", ctx);
      assert.match(notices[0] ?? "", /23:59:00.*T1.*todo.*running/);
      assert.match(notices[0] ?? "", /2026-07-13/);
      assert.match(notices[0] ?? "", /2026-07-14/);
      assert.match(notices[0] ?? "", /3 unreadable line\(s\) skipped/);
    }
  );
});

test("a command that quarantines a corrupt board warns in the same invocation", async () => {
  await withBoard(
    (cwd) => {
      const directory = join(cwd, ".pi", "maestro");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "board.json"), "{broken");
    },
    async (cwd) => {
      const { command, ctx, notices } = loadMaestro(cwd);
      await command.handler("costs", ctx);
      assert.ok(notices.some((notice) => /corrupt and quarantined/.test(notice)));
    }
  );
});

test("a stale ctx during quarantine notify does not crash the command and re-stashes the notice", async () => {
  await withBoard(
    (cwd) => {
      const directory = join(cwd, ".pi", "maestro");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "board.json"), "{broken");
    },
    async (cwd) => {
      const { command, ctx } = loadMaestro(cwd);
      const originalNotify = ctx.ui.notify;
      ctx.ui.notify = (message: string, level?: string) => {
        if (/corrupt and quarantined/.test(message)) throw new Error("stale ctx");
        originalNotify(message, level);
      };
      await assert.doesNotReject(command.handler("costs", ctx));
      assert.match(consumeQuarantineNotice() ?? "", /board\.json\.corrupt-/);
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

test("multi-word static and dynamic argument completions are combined", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { command } = loadMaestro(cwd);
      assert.ok(
        command.getArgumentCompletions?.("plan e")?.some((item) => item.value === "plan export")
      );
      assert.ok(
        command.getArgumentCompletions?.("doctor ")?.some((item) => item.value === "doctor cleanup")
      );
    }
  );
});

test("task-id argument completion includes board tasks", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Accepted task", brief: "work", tier: "standard" });
      createTask(board, { title: "Second task", brief: "work", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { command, ctx, events } = loadMaestro(cwd);
      events.get("session_start")?.({ reason: "startup" }, ctx);
      const completions = command.getArgumentCompletions?.("retry T");
      assert.deepEqual(completions, [
        { value: "retry T1", label: "T1", description: "Accepted task" },
        { value: "retry T2", label: "T2", description: "Second task" },
      ]);
      assert.equal(
        command.getArgumentCompletions?.("drive T1 T")?.find((item) => item.label === "T2")?.value,
        "drive T1 T2"
      );

      const afterSpace = command.getArgumentCompletions?.("drive T1 ");
      assert.ok(afterSpace?.some((item) => item.label === "T2"));
      assert.ok(!afterSpace?.some((item) => item.label === "T1"));
      assert.equal(afterSpace?.find((item) => item.label === "T2")?.value, "drive T1 T2");

      const afterComma = command.getArgumentCompletions?.("drive T1,T");
      assert.deepEqual(afterComma, [
        { value: "drive T1 T2", label: "T2", description: "Second task" },
      ]);

      const bothIds = command.getArgumentCompletions?.("drive T");
      assert.deepEqual(
        bothIds?.map((item) => item.label),
        ["T1", "T2"]
      );
    }
  );
});

test("scrollable text clamps to the last full page", () => {
  let offset = 0;
  for (let index = 0; index < 10; index += 1) {
    offset = scrollableTextOffset(offset, 10, 60);
  }
  assert.equal(offset, 42);
});

test("retry command completion and risky confirmation preserve approved work on refusal or race", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, {
        title: "Accepted",
        brief: "accepted work",
        tier: "standard",
      });
      task.status = "approved";
      task.approvalKind = "manual";
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const declinedScript: UiScript = { steps: [], confirmations: [false] };
      const declined = loadMaestro(cwd, undefined, owner, declinedScript);
      assert.deepEqual(declined.command.getArgumentCompletions?.("ret"), [
        { value: "retry", label: "retry" },
      ]);
      await declined.command.handler("retry T1", declined.ctx);
      assert.equal(findTask(loadBoard(cwd), "T1")?.status, "approved");
      assert.match(declined.notices.at(-1) ?? "", /Retry cancelled/);

      const noUi = loadMaestro(cwd);
      noUi.ctx.hasUI = false;
      await noUi.command.handler("retry T1", noUi.ctx);
      assert.equal(findTask(loadBoard(cwd), "T1")?.status, "approved");

      const raceScript: UiScript = {
        steps: [],
        confirmations: [true],
        beforeConfirm: () => {
          updateBoard(cwd, (board) => {
            const task = findTask(board, "T1");
            assert.ok(task);
            task.integratedCommit = "changed-during-confirmation";
            return true;
          });
        },
      };
      const raced = loadMaestro(cwd, undefined, owner, raceScript);
      await raced.command.handler("retry T1", raced.ctx);
      assert.match(raced.notices.at(-1) ?? "", /evidence changed during confirmation/);
      assert.equal(findTask(loadBoard(cwd), "T1")?.status, "approved");
      assert.equal(findTask(loadBoard(cwd), "T1")?.integratedCommit, "changed-during-confirmation");
    }
  );
});

test("retry risk evidence is rechecked after scale confirmation", async () => {
  await withBoard(
    (cwd) => {
      saveConfig("project", cwd, {
        ...DEFAULT_CONFIG,
        autoCommit: false,
        confirmationTotalLaunches: 1,
      });
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, { title: "Accepted", brief: "accepted", tier: "standard" });
      task.status = "failed";
      task.integratedCommit = "integrated-before-confirmation";
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let confirmations = 0;
      const script: UiScript = {
        steps: [],
        confirmations: [true, true],
        beforeConfirm: () => {
          confirmations += 1;
          if (confirmations !== 2) return;
          updateBoard(cwd, (board) => {
            const task = findTask(board, "T1");
            assert.ok(task);
            task.integratedCommit = "changed-during-scale-confirmation";
            return true;
          });
        },
      };
      const { ctx, notices, command } = loadMaestro(cwd, undefined, owner, script);

      await command.handler("retry T1", ctx);

      assert.equal(confirmations, 2);
      assert.equal(findTask(loadBoard(cwd), "T1")?.status, "failed");
      assert.match(notices.at(-1) ?? "", /evidence changed; confirm it again/);
    }
  );
});

test("a second runtime cannot retry work owned by another session", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, { title: "Failed", brief: "retry me", tier: "standard" });
      task.status = "failed";
      board.activeDrive = {
        id: "owner-drive",
        ownerSession: owner,
        taskIds: [task.id],
        startedAt: Date.now(),
      };
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let launches = 0;
      const startExecutor: StartExecutor = () => {
        launches += 1;
        throw new Error("foreign runtime launched work");
      };
      loadMaestro(cwd, startExecutor, owner);
      const foreign = loadMaestro(cwd, startExecutor, other);
      const before = readFileSync(join(cwd, ".pi", "maestro", "board.json"), "utf-8");

      await foreign.command.handler("retry T1", foreign.ctx);

      assert.equal(launches, 0);
      assert.match(foreign.notices.at(-1) ?? "", /another session/);
      assert.equal(readFileSync(join(cwd, ".pi", "maestro", "board.json"), "utf-8"), before);
    }
  );
});

test("manual acceptance rejects out-of-scope artifacts before recording versioned proof", async () => {
  await withBoard(
    (cwd) => {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
      execFileSync("git", ["config", "user.name", "Test"], { cwd });
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "allowed.ts"), "before\n");
      writeFileSync(join(cwd, "outside.ts"), "before\n");
      execFileSync("git", ["add", "."], { cwd });
      execFileSync("git", ["commit", "-qm", "base"], { cwd });
      writeFileSync(join(cwd, "src", "allowed.ts"), "after\n");
      writeFileSync(join(cwd, "outside.ts"), "after\n");

      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, {
        title: "Scoped acceptance",
        brief: "Change only the allowed file",
        tier: "standard",
        writePaths: ["src/allowed.ts"],
        successCriteria: ["Allowed behavior works"],
      });
      task.status = "ready_for_review";
      const completed = executorAttempt();
      completed.endedAt = Date.now();
      completed.finalReport = "Implemented the scoped change";
      completed.touchedFiles = ["outside.ts"];
      task.attempts.push(completed);
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const refusalScript: UiScript = {
        steps: [{ keys: select(0) }, { keys: select(4) }],
      };
      const refused = loadMaestro(cwd, undefined, owner, refusalScript);
      await refused.command.handler("list", refused.ctx);
      assert.match(refused.notices.at(-1) ?? "", /outside write scope/);
      assert.equal(findTask(loadBoard(cwd), "T1")?.status, "ready_for_review");

      updateBoard(cwd, (board) => {
        const task = findTask(board, "T1");
        assert.ok(task);
        const completed = task.attempts.at(-1);
        assert.ok(completed);
        completed.touchedFiles = ["src/allowed.ts"];
      });
      const approvalScript: UiScript = {
        steps: [{ keys: select(0) }, { keys: select(4) }],
      };
      const accepted = loadMaestro(cwd, undefined, owner, approvalScript);
      await accepted.command.handler("list", accepted.ctx);
      const approved = findTask(loadBoard(cwd), "T1");
      assert.equal(approved?.status, "approved");
      assert.equal(approved?.approvalKind, "manual");
      assert.ok(approved?.approvedProvenance);
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

test("plan diff and recipe preview are bounded read-only inspections", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, {
        title: "Current",
        brief: "Implement current behavior",
        tier: "standard",
        writePaths: ["src/current.ts"],
        successCriteria: ["Current works"],
      });
      saveBoard(cwd, board);
      const candidate = structuredClone(board);
      const first = candidate.tasks[0];
      assert.ok(first);
      first.brief = "Implement changed behavior";
      first.reviewPolicy = "confirm";
      writeFileSync(join(cwd, "candidate.json"), exportPlan(candidate));
      saveStoredRecipe(
        "project",
        cwd,
        "preview-safe",
        `${JSON.stringify({
          kind: "pi-maestro-recipe",
          version: 1,
          name: "preview-safe",
          tasks: [
            {
              id: "step",
              title: "Preview",
              brief: "Preview declarative work",
              tier: "standard",
              dependsOn: [],
              writePaths: ["src/preview.ts"],
              successCriteria: ["Preview works"],
            },
          ],
        })}\n`
      );
    },
    async (cwd) => {
      const { ctx, notices, command } = loadMaestro(cwd);
      const boardFile = join(cwd, ".pi", "maestro", "board.json");
      const beforeBoard = readFileSync(boardFile);
      const beforeArchives = listArchivedBoards(cwd);

      await command.handler("plan diff candidate.json", ctx);
      await command.handler("recipe preview preview-safe", ctx);

      assert.match(notices.join("\n"), /Plan comparison/);
      assert.match(notices.join("\n"), /fingerprint contract\+execution/);
      assert.deepEqual(readFileSync(boardFile), beforeBoard);
      assert.deepEqual(listArchivedBoards(cwd), beforeArchives);
      assert.equal(loadBoard(cwd).planPending, undefined);
    }
  );
});

test("recipe commands list, inspect, run through the plan gate, save, and remove", async () => {
  await withBoard(
    (cwd) => {
      saveStoredRecipe(
        "project",
        cwd,
        "safe",
        `${JSON.stringify({
          kind: "pi-maestro-recipe",
          version: 1,
          name: "safe",
          tasks: [
            {
              id: "step",
              title: "Build core",
              brief: "Implement core",
              tier: "standard",
              dependsOn: [],
              writePaths: ["src/core.ts"],
              successCriteria: ["Core works"],
            },
          ],
        })}\n`
      );
    },
    async (cwd) => {
      const script: UiScript = { steps: [], confirmations: [true] };
      const { ctx, notices, command } = loadMaestro(cwd, undefined, owner, script);

      await command.handler("recipe list", ctx);
      await command.handler("recipe inspect safe", ctx);
      await command.handler("recipe run safe", ctx);
      assert.match(notices.join("\n"), /safe \[project\]|\[project\].*safe/s);
      assert.equal(loadBoard(cwd).planPending, true);
      assert.equal(loadBoard(cwd).tasks[0]?.title, "Build core");

      await command.handler("recipe save snapshot project", ctx);
      assert.match(notices.at(-1) ?? "", /Saved project recipe/);
      await command.handler("recipe remove safe project", ctx);
      assert.match(notices.at(-1) ?? "", /Removed project recipe/);
    }
  );
});

function discoveryReport(title = "Generated task"): string {
  return JSON.stringify({
    kind: "pi-maestro-discovery",
    version: 1,
    items: [
      {
        key: "generated",
        title,
        brief: "Implement generated work",
        tier: "standard",
        writePaths: ["src/generated.ts"],
        successCriteria: ["Generated work passes"],
        dependsOn: [],
      },
    ],
  });
}

function addDiscoveryTask(board: Board, report = discoveryReport()): void {
  const task = createTask(board, {
    title: "Discover work",
    brief: "Read-only investigation with no-file changes",
    tier: "standard",
    writePaths: [],
    discovery: { allowedWritePaths: ["src/**"] },
  });
  task.attempts.push({
    index: 1,
    logFile: "discovery.jsonl",
    thinking: "medium",
    startedAt: 1,
    endedAt: 2,
    exitCode: 0,
    usage: { input: 1, output: 1, cost: 0, turns: 1 },
    finalReport: report,
    touchedFiles: [],
  });
  task.status = "ready_for_review";
}

test("maestro_plan creates only explicit scoped no-file discovery tasks", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const plan = tools.get("maestro_plan");
      assert.ok(plan);
      await assert.rejects(
        plan.execute(
          "writable-discovery",
          {
            tasks: [
              {
                title: "Discover",
                brief: "Read-only investigation",
                tier: "standard",
                writePaths: ["src/discovery.ts"],
                successCriteria: ["Done"],
                discovery: { allowedWritePaths: ["src/**"] },
              },
            ],
          },
          undefined,
          undefined,
          ctx
        ),
        /Discovery tasks must use writePaths/
      );
      await plan.execute(
        "discovery",
        {
          tasks: [
            {
              title: "Discover",
              brief: "Read-only investigation with no-file changes",
              tier: "standard",
              writePaths: [],
              discovery: { allowedWritePaths: ["src/**"] },
            },
          ],
        },
        undefined,
        undefined,
        ctx
      );
      assert.deepEqual(findTask(loadBoard(cwd), "T1")?.discovery?.allowedWritePaths, ["src/**"]);
    }
  );
});

test("discovery append requires confirmation and forces the plan gate", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      addDiscoveryTask(board);
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const script: UiScript = { steps: [], confirmations: [true] };
      const { ctx, notices, command } = loadMaestro(cwd, undefined, owner, script);
      await command.handler("discover T1 append", ctx);
      const board = loadBoard(cwd);
      assert.equal(board.planPending, true);
      assert.equal(board.tasks.length, 2);
      assert.equal(board.tasks[1]?.title, "Generated task");
      assert.match(notices[0] ?? "", /Discovery preview.*generated/s);
      assert.match(notices.at(-1) ?? "", /plan approval is required/);
      assert.equal(listArchivedBoards(cwd).length, 0);
    }
  );
});

test("discovery replace archives only after approval", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      addDiscoveryTask(board, discoveryReport("Replacement task"));
      createTask(board, {
        title: "Existing",
        brief: "Implement existing work",
        tier: "standard",
        writePaths: ["src/existing.ts"],
        successCriteria: ["Existing work passes"],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const script: UiScript = { steps: [], confirmations: [true] };
      const { ctx, command } = loadMaestro(cwd, undefined, owner, script);
      await command.handler("discover T1 replace", ctx);
      const board = loadBoard(cwd);
      assert.equal(board.planPending, true);
      assert.deepEqual(
        board.tasks.map(({ title }) => title),
        ["Replacement task"]
      );
      assert.equal(listArchivedBoards(cwd).length, 1);
    }
  );
});

test("rejected and non-interactive discovery previews do not mutate or archive", async () => {
  for (const interactive of [true, false]) {
    await withBoard(
      (cwd) => {
        const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
        addDiscoveryTask(board);
        saveBoard(cwd, board);
      },
      async (cwd) => {
        const script: UiScript = { steps: [], confirmations: [false] };
        const loaded = loadMaestro(cwd, undefined, owner, script);
        const ctx = interactive ? loaded.ctx : { ...loaded.ctx, hasUI: false };
        const boardFile = join(cwd, ".pi", "maestro", "board.json");
        const before = readFileSync(boardFile, "utf-8");
        await loaded.command.handler("discover T1 replace", ctx);
        assert.equal(readFileSync(boardFile, "utf-8"), before);
        assert.equal(listArchivedBoards(cwd).length, 0);
      }
    );
  }
});

test("discovery parses only the latest retained final report", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      addDiscoveryTask(board);
      const task = findTask(board, "T1");
      assert.ok(task);
      task.attempts.push({
        index: 2,
        logFile: "latest.jsonl",
        thinking: "medium",
        startedAt: 3,
        endedAt: 4,
        exitCode: 0,
        usage: { input: 1, output: 1, cost: 0, turns: 1 },
        finalReport: "not json",
        touchedFiles: [],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const boardFile = join(cwd, ".pi", "maestro", "board.json");
      const before = readFileSync(boardFile, "utf-8");
      const { ctx, notices, command } = loadMaestro(cwd);
      await command.handler("discover T1 append", ctx);
      assert.match(notices.at(-1) ?? "", /one valid JSON object/);
      assert.equal(readFileSync(boardFile, "utf-8"), before);
    }
  );
});

test("discovery refuses running tasks even when an older completed report exists", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      addDiscoveryTask(board);
      const task = findTask(board, "T1");
      assert.ok(task);
      task.status = "running";
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const boardFile = join(cwd, ".pi", "maestro", "board.json");
      const before = readFileSync(boardFile, "utf-8");
      const { ctx, notices, command } = loadMaestro(cwd);
      await command.handler("discover T1 append", ctx);
      assert.match(notices.at(-1) ?? "", /does not have a retained completed discovery result/);
      assert.equal(readFileSync(boardFile, "utf-8"), before);
    }
  );
});

test("discovery approval refuses a stale board instead of overwriting concurrent work", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      addDiscoveryTask(board);
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const script: UiScript = {
        steps: [],
        confirmations: [true],
        beforeConfirm: () => {
          updateBoard(cwd, (board) => {
            createTask(board, {
              title: "Concurrent task",
              brief: "Implement concurrent work",
              tier: "standard",
              writePaths: ["src/concurrent.ts"],
              successCriteria: ["Concurrent work passes"],
            });
            return true;
          });
        },
      };
      const { ctx, notices, command } = loadMaestro(cwd, undefined, owner, script);
      await command.handler("discover T1 replace", ctx);
      assert.deepEqual(
        loadBoard(cwd).tasks.map(({ title }) => title),
        ["Discover work", "Concurrent task"]
      );
      assert.match(notices.at(-1) ?? "", /board changed after preview/);
      assert.equal(listArchivedBoards(cwd).length, 0);
    }
  );
});

test("command parsing preserves spaces inside recipe JSON input", async () => {
  await withBoard(
    (cwd) => {
      saveStoredRecipe(
        "project",
        cwd,
        "spaced",
        JSON.stringify({
          kind: "pi-maestro-recipe",
          version: 1,
          name: "spaced",
          inputs: { target: { required: true } },
          tasks: [
            {
              id: "step",
              title: "Build {{input.target}}",
              brief: "Implement {{input.target}}",
              tier: "standard",
              dependsOn: [],
              writePaths: ["src/spaced.ts"],
              successCriteria: ["Spacing is preserved"],
            },
          ],
        })
      );
    },
    async (cwd) => {
      const { ctx, command } = loadMaestro(cwd);
      await command.handler('recipe run spaced {"target":"two  spaces"}', ctx);
      assert.equal(loadBoard(cwd).tasks[0]?.title, "Build two  spaces");
    }
  );
});

test("running a malformed effective recipe reports its file without changing the board", async () => {
  await withBoard(
    (cwd) => {
      const board = { version: 1 as const, nextTaskNumber: 1, tasks: [] };
      createTask(board, {
        title: "Existing",
        brief: "Keep existing work",
        tier: "standard",
        writePaths: ["src/existing.ts"],
        successCriteria: ["Existing work passes"],
      });
      saveBoard(cwd, board);
      saveStoredRecipe("project", cwd, "broken", "{malformed");
    },
    async (cwd) => {
      const boardFile = join(cwd, ".pi", "maestro", "board.json");
      const before = readFileSync(boardFile, "utf-8");
      const { ctx, notices, command } = loadMaestro(cwd);

      await command.handler("recipe run broken", ctx);

      assert.equal(readFileSync(boardFile, "utf-8"), before);
      assert.match(notices.at(-1) ?? "", /Invalid project recipe.*broken.*maestro-recipes/s);
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
      assert.match(notices[0] ?? "", /\/maestro recipe/);
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

test("maestro_plan and maestro_update expose review convergence policy", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      await tools.get("maestro_plan")?.execute(
        "review-policy-plan",
        {
          tasks: [
            {
              title: "Reviewed work",
              brief: "Implement reviewed work",
              tier: "standard",
              writePaths: ["src/reviewed.ts"],
              successCriteria: ["Reviewed behavior works"],
              reviewPolicy: "confirm",
            },
          ],
        },
        undefined,
        undefined,
        ctx
      );
      assert.equal(findTask(loadBoard(cwd), "T1")?.reviewPolicy, "confirm");

      await tools
        .get("maestro_update")
        ?.execute(
          "review-policy-update",
          { taskId: "T1", reviewPolicy: "find-and-refute" },
          undefined,
          undefined,
          ctx
        );
      assert.equal(findTask(loadBoard(cwd), "T1")?.reviewPolicy, "find-and-refute");
    }
  );
});

test("maestro_update cannot mutate a task owned by a persisted dispatch", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, {
        title: "Reviewing",
        brief: "work under review",
        tier: "standard",
        writePaths: ["src/reviewed.ts"],
        successCriteria: ["Reviewed behavior works"],
      });
      task.status = "ready_for_review";
      task.dispatchClaim = {
        id: "review-claim",
        kind: "review",
        claimedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const boardFile = join(cwd, ".pi", "maestro", "board.json");
      const before = readFileSync(boardFile, "utf-8");
      const { ctx, tools } = loadMaestro(cwd);
      const update = tools.get("maestro_update");
      assert.ok(update);

      await assert.rejects(
        update.execute(
          "mutate-reviewing-task",
          { taskId: "T1", title: "Raced title" },
          undefined,
          undefined,
          ctx
        ),
        /owned by an active review dispatch/
      );
      assert.equal(readFileSync(boardFile, "utf-8"), before);
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

test("maestro_plan enforces maxPlanTasks without partial board mutation", async () => {
  await withBoard(
    (cwd) => {
      saveConfig("project", cwd, {
        ...DEFAULT_CONFIG,
        autoCommit: false,
        maxPlanTasks: 1,
        maxDiscoveryGeneratedTasks: 1,
        confirmationPlanTasks: 1,
      });
    },
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const tasks = ["one", "two"].map((name) => ({
        title: name,
        brief: `Implement ${name}`,
        tier: "standard",
        writePaths: [`src/${name}.ts`],
        successCriteria: [`${name} works`],
      }));
      await assert.rejects(
        tools
          .get("maestro_plan")
          ?.execute("too-many", { tasks }, undefined, undefined, ctx) as Promise<unknown>,
        /2 tasks.*maxPlanTasks is 1/
      );
      assert.equal(loadBoard(cwd).tasks.length, 0);
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

test("maestro_plan atomically supersedes a stopped task and rewires its dependents", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const predecessor = createTask(board, {
        title: "Original",
        brief: "change shared file",
        tier: "standard",
        writePaths: ["src/shared.ts"],
        successCriteria: ["original works"],
      });
      predecessor.status = "changes_requested";
      createTask(board, {
        title: "Dependent",
        brief: "continue after replacement",
        tier: "standard",
        dependsOn: [predecessor.id],
        writePaths: ["src/dependent.ts"],
        successCriteria: ["dependent works"],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const result = await tools.get("maestro_plan")?.execute(
        "successor",
        {
          tasks: [
            {
              title: "Replacement",
              brief: "replace the rejected implementation",
              tier: "standard",
              supersedesTaskId: "T1",
              writePaths: ["src/shared.ts"],
              successCriteria: ["replacement works"],
            },
          ],
        },
        undefined,
        undefined,
        ctx
      );

      assert.match(result?.content[0]?.text ?? "", /Superseded atomically: T1 → T3/);
      const board = loadBoard(cwd);
      assert.equal(findTask(board, "T1")?.status, "cancelled");
      assert.deepEqual(findTask(board, "T2")?.dependsOn, ["T3"]);
      assert.equal(findTask(board, "T3")?.status, "todo");
    }
  );
});

test("maestro_update can transactionally adopt an existing successor", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const predecessor = createTask(board, {
        title: "Rejected predecessor",
        brief: "old implementation",
        tier: "standard",
        writePaths: ["src/shared.ts"],
        successCriteria: ["old works"],
      });
      predecessor.status = "changes_requested";
      createTask(board, {
        title: "Dependent",
        brief: "wait for replacement",
        tier: "standard",
        dependsOn: [predecessor.id],
        writePaths: ["src/dependent.ts"],
        successCriteria: ["dependent works"],
      });
      createTask(board, {
        title: "Existing successor",
        brief: "new implementation",
        tier: "standard",
        writePaths: ["src/shared.ts"],
        successCriteria: ["new works"],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      await tools
        .get("maestro_update")
        ?.execute(
          "adopt-successor",
          { taskId: "T3", supersedesTaskId: "T1" },
          undefined,
          undefined,
          ctx
        );
      const board = loadBoard(cwd);
      assert.equal(findTask(board, "T1")?.status, "cancelled");
      assert.deepEqual(findTask(board, "T2")?.dependsOn, ["T3"]);
    }
  );
});

test("maestro_plan does not mutate the board when supersession is invalid", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, {
        title: "Still active",
        brief: "not replaceable",
        tier: "standard",
        writePaths: ["src/active.ts"],
        successCriteria: ["active works"],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const before = readFileSync(join(cwd, ".pi", "maestro", "board.json"), "utf8");
      const { ctx, tools } = loadMaestro(cwd);
      const plan = tools.get("maestro_plan");
      assert.ok(plan);
      await assert.rejects(
        plan.execute(
          "invalid-successor",
          {
            tasks: [
              {
                title: "Invalid replacement",
                brief: "must not persist",
                tier: "standard",
                supersedesTaskId: "T1",
                writePaths: ["src/active.ts"],
                successCriteria: ["replacement works"],
              },
            ],
          },
          undefined,
          undefined,
          ctx
        ),
        /cannot be superseded while todo/
      );
      assert.equal(readFileSync(join(cwd, ".pi", "maestro", "board.json"), "utf8"), before);
    }
  );
});

test("maestro_drive inspect returns bounded scoped board state without starting work", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, { title: "Inspect me", brief: "stay idle", tier: "standard" });
      createTask(board, { title: "Hide me", brief: "stay idle", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const drive = tools.get("maestro_drive");
      assert.ok(drive);
      const result = await drive.execute(
        "inspect",
        { action: "inspect", taskIds: ["T1"] },
        undefined,
        undefined,
        ctx
      );
      assert.match(result.content[0]?.text ?? "", /0\/1 approved/);
      assert.match(result.content[0]?.text ?? "", /No live executors/);
      assert.equal(findTask(loadBoard(cwd), "T1")?.status, "todo");
    }
  );
});

test("maestro_drive normalizes common action aliases before schema validation", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const drive = loadMaestro(cwd).tools.get("maestro_drive");
      assert.ok(drive?.prepareArguments);
      assert.deepEqual(drive.prepareArguments({}), { action: "start" });
      assert.deepEqual(drive.prepareArguments({ action: "resume", taskIds: ["T1"] }), {
        action: "start",
        taskIds: ["T1"],
      });
      assert.deepEqual(drive.prepareArguments({ action: "status" }), { action: "inspect" });
      assert.deepEqual(drive.prepareArguments({ action: "abort", taskIds: ["T1"] }), {
        action: "intervene",
        intervention: "abort",
        taskIds: ["T1"],
      });
      assert.deepEqual(drive.prepareArguments({ intervention: "handoff" }), {
        action: "intervene",
        intervention: "handoff",
      });
    }
  );
});

test("maestro_drive keeps a provider-compatible object schema with strict runtime actions", async () => {
  await withBoard(
    () => {},
    async (cwd) => {
      const drive = loadMaestro(cwd).tools.get("maestro_drive");
      assert.ok(drive?.parameters);
      const schema = drive.parameters as {
        type?: string;
        properties?: { action?: { enum?: string[] } };
      };
      assert.equal(schema.type, "object");
      assert.deepEqual(schema.properties?.action?.enum, ["start", "inspect", "intervene"]);
      assert.doesNotMatch(JSON.stringify(schema), /"(?:anyOf|oneOf)"/);
      assert.deepEqual(
        drive.prepareArguments?.({ action: "steer", taskIds: ["t1"], instruction: "stop" }),
        {
          action: "intervene",
          taskIds: ["t1"],
          instruction: "stop",
          intervention: "steer",
        }
      );
    }
  );
});

const invalidDriveInputs = [
  [{ action: "inspect", intervention: "abort" }, /inspect does not accept/],
  [{ action: "intervene" }, /intervention is required/],
  [{ action: "intervene", intervention: "steer" }, /steer requires an instruction/],
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
      const result = await tools.get("maestro_drive")?.execute(
        "handoff",
        {
          action: "intervene",
          intervention: "handoff",
          instruction: "Continue from the persisted board state",
        },
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

test("maestro_drive start reports invalid plans synchronously instead of silently stopping", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, {
        title: "First",
        brief: "change shared file",
        tier: "standard",
        writePaths: ["src/shared.ts"],
        successCriteria: ["first works"],
      });
      createTask(board, {
        title: "Second",
        brief: "also change shared file",
        tier: "standard",
        writePaths: ["src/shared.ts"],
        successCriteria: ["second works"],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, tools, messages } = loadMaestro(cwd);
      const drive = tools.get("maestro_drive");
      assert.ok(drive);
      await assert.rejects(
        drive.execute("start", { action: "start" }, undefined, undefined, ctx),
        /Invalid plan.*write/s
      );
      assert.equal(messages.length, 0);
      assert.equal(loadBoard(cwd).pausedDrive, undefined);
    }
  );
});

test("slash drive preflight refuses invalid plans before announcing progress", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, {
        title: "First",
        brief: "change shared file",
        tier: "standard",
        writePaths: ["src/shared.ts"],
        successCriteria: ["first works"],
      });
      createTask(board, {
        title: "Second",
        brief: "also change shared file",
        tier: "standard",
        writePaths: ["src/shared.ts"],
        successCriteria: ["second works"],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, command, notices } = loadMaestro(cwd);
      await command.handler("drive", ctx);
      assert.ok(notices.some((notice) => notice.includes("Drive not started")));
      assert.equal(
        notices.some((notice) => notice.startsWith("Driving ")),
        false
      );
      assert.equal(loadBoard(cwd).activeDrive, undefined);
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
      await waitFor(() => {
        const resumed = loadBoard(cwd);
        return (
          findTask(resumed, "T1")?.status === "approved" ||
          (resumed.tasks.length === 0 && starts === 2)
        );
      }, "resumed drive did not review fresh board state");
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
      const { ctx, tools, events, messages, notices } = loadMaestro(cwd, startExecutor);
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
      assert.ok(notices.some((notice) => notice.includes("Run complete — board archived to")));

      events.get("session_start")?.({ previousSessionFile: owner }, ctx);
      assert.equal(messages.length, 1, "a delivered decision must not wake the owner twice");
    }
  );
});

test("post-persist completion UI failures do not replace the successful decision", async () => {
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
      const { ctx, tools } = loadMaestro(cwd, startExecutor);
      ctx.ui.notify = () => {
        throw new Error("stale session context");
      };
      await tools
        .get("maestro_drive")
        ?.execute("drive", { action: "start" }, undefined, undefined, ctx);
      await waitFor(() => loadBoard(cwd).activeDecision !== undefined, "drive decision");
      assert.equal(loadBoard(cwd).activeDecision?.kind, "completed");
    }
  );
});

test("production recovery sequence supersedes, launches, clears stale status, and wakes once", async () => {
  await withBoard(
    (cwd) => {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
      execFileSync("git", ["config", "user.name", "Test"], { cwd });
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "shared.ts"), "export const shared = true;\n");
      writeFileSync(join(cwd, "src", "downstream.ts"), "export const downstream = true;\n");
      execFileSync("git", ["add", "src"], { cwd });
      execFileSync("git", ["commit", "-qm", "initial"], { cwd });
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const predecessor = createTask(board, {
        title: "Capped predecessor",
        brief: "old implementation",
        tier: "standard",
        writePaths: ["src/shared.ts"],
        successCriteria: ["old behavior"],
      });
      predecessor.status = "changes_requested";
      createTask(board, {
        title: "Downstream",
        brief: "use the corrected implementation",
        tier: "standard",
        dependsOn: [predecessor.id],
        writePaths: ["src/downstream.ts"],
        successCriteria: ["downstream works"],
      });
      board.activeDecision = {
        id: "stale-t1-decision",
        ownerSession: owner,
        kind: "escalation_required",
        taskIds: [predecessor.id],
        evidence: "Old T1 escalation must not control the successor run",
        allowedInterventions: ["handoff", "abort"],
        createdAt: Date.now(),
        deliveredAt: Date.now(),
      };
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const launched: string[] = [];
      const startExecutor: StartExecutor = (options) => {
        launched.push(options.runId);
        const isReview = options.runId.includes("-review-");
        return {
          attempt: executorAttempt(),
          outcome: Promise.resolve({
            exitCode: 0,
            usage: { input: 1, output: 1, cost: 0, turns: 1 },
            finalReport: isReview ? "VERDICT: APPROVE" : "done",
            touchedFiles: isReview
              ? []
              : [options.runId.startsWith("T3-") ? "src/shared.ts" : "src/downstream.ts"],
            aborted: false,
          }),
          steer: () => {},
          abort: () => {},
        };
      };
      const { ctx, tools, events, messages } = loadMaestro(cwd, startExecutor);
      const plan = tools.get("maestro_plan");
      const drive = tools.get("maestro_drive");
      assert.ok(plan && drive);

      await plan.execute(
        "successor",
        {
          tasks: [
            {
              title: "Corrected successor",
              brief: "replace the capped implementation",
              tier: "standard",
              supersedesTaskId: "T1",
              writePaths: ["src/shared.ts"],
              successCriteria: ["corrected behavior"],
            },
          ],
        },
        undefined,
        undefined,
        ctx
      );

      const inspected = await drive.execute(
        "inspect-successor",
        { action: "inspect", taskIds: ["t3"] },
        undefined,
        undefined,
        ctx
      );
      assert.doesNotMatch(inspected.content[0]?.text ?? "", /Old T1 escalation/);

      const started = await drive.execute(
        "start-recovery",
        { action: "start", taskIds: ["t3", "t2", "T3"] },
        undefined,
        undefined,
        ctx
      );
      assert.match(started.content[0]?.text ?? "", /Drive started/);
      const claimedOrSettled = loadBoard(cwd);
      assert.ok(claimedOrSettled.activeDrive || claimedOrSettled.activeDecision);
      if (claimedOrSettled.activeDrive) {
        assert.deepEqual(claimedOrSettled.activeDrive.taskIds, ["T3", "T2"]);
      }
      if (claimedOrSettled.activeDecision?.id === "stale-t1-decision") {
        assert.equal(claimedOrSettled.activeDecision.resolution?.intervention, "resume");
      } else {
        assert.notEqual(claimedOrSettled.activeDecision?.id, "stale-t1-decision");
      }
      await waitFor(
        () => launched.some((runId) => runId.startsWith("T3-")),
        "successor did not launch"
      );

      await waitFor(
        () => loadBoard(cwd).activeDecision?.kind === "completed",
        "drive started but stopped without a terminal decision"
      );
      assert.ok(launched.some((runId) => runId.startsWith("T2-")));
      assert.equal(loadBoard(cwd).activeDrive, undefined);
      assert.equal(messages.length, 1);

      events.get("session_start")?.({ previousSessionFile: owner }, ctx);
      assert.equal(messages.length, 1, "owner must not receive a duplicate wakeup");
      const foreign = loadMaestro(cwd, undefined, other);
      foreign.events.get("session_start")?.({ previousSessionFile: owner }, foreign.ctx);
      assert.equal(foreign.messages.length, 0, "foreign session must not consume the wakeup");
    }
  );
});

test("review disagreement wakes only its owner once and is not redispatched", async () => {
  await withBoard(
    (cwd) => {
      saveConfig("project", cwd, {
        ...DEFAULT_CONFIG,
        autoCommit: false,
        cleanupCompletedTasks: false,
      });
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      const task = createTask(board, {
        title: "Contested review",
        brief: "Review the contested result",
        tier: "standard",
        writePaths: ["src/contested.ts"],
        successCriteria: ["The contested result works"],
        reviewPolicy: "find-and-refute",
      });
      task.status = "ready_for_review";
      const completed = executorAttempt();
      completed.finalReport = "executor completed contested result";
      completed.touchedFiles = ["src/contested.ts"];
      completed.diff = "+contested result";
      task.attempts.push(completed);
      const fingerprint = taskFingerprint(board, task, {
        ...DEFAULT_CONFIG,
        autoCommit: false,
        cleanupCompletedTasks: false,
      });
      assert.ok(fingerprint);
      completed.executionFingerprint = fingerprint.fingerprint;
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let reviewerStarts = 0;
      const startExecutor: StartExecutor = () => {
        reviewerStarts += 1;
        const approved = reviewerStarts === 1;
        return {
          attempt: executorAttempt(),
          outcome: Promise.resolve({
            exitCode: 0,
            usage: { input: 1, output: 1, cost: 0, turns: 1 },
            finalReport: approved
              ? "CRITERION 1: PASS — finder verified it\nVERDICT: APPROVE"
              : "CRITERION 1: FAIL — refuter found a gap\nVERDICT: REQUEST_CHANGES\nCriterion 1: gap remains",
            touchedFiles: [],
            aborted: false,
          }),
          steer: () => {},
          abort: () => {},
        };
      };
      const ownerRuntime = loadMaestro(cwd, startExecutor, owner);
      await ownerRuntime.tools
        .get("maestro_drive")
        ?.execute("disagreement", { action: "start" }, undefined, undefined, ownerRuntime.ctx);
      await waitFor(
        () => loadBoard(cwd).activeDecision !== undefined,
        "review disagreement produced no durable decision"
      );

      assert.equal(
        loadBoard(cwd).activeDecision?.kind,
        "review_disagreement",
        findTask(loadBoard(cwd), "T1")?.attempts.at(-1)?.reviewConvergence?.summary
      );
      assert.equal(reviewerStarts, 2);
      assert.equal(ownerRuntime.messages.length, 1);
      assert.equal(loadBoard(cwd).activeDecision?.ownerSession, owner);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(reviewerStarts, 2, "terminal disagreement must not hot-loop reviewers");

      ownerRuntime.events.get("session_start")?.({ reason: "resume" }, ownerRuntime.ctx);
      assert.equal(ownerRuntime.messages.length, 1, "owner wakeup must be exactly once");
      const foreign = loadMaestro(cwd, undefined, other);
      foreign.events.get("session_start")?.({ reason: "resume" }, foreign.ctx);
      assert.equal(foreign.messages.length, 0, "foreign session must not receive the decision");
    }
  );
});

test("active drive shutdown persists owner-scoped internal error for reload delivery", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, {
        title: "Interrupted work",
        brief: "remain active until reload",
        tier: "standard",
        writePaths: ["src/interrupted.ts"],
        successCriteria: ["work completes"],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      let finish!: (outcome: RunOutcome) => void;
      const outcome = new Promise<RunOutcome>((resolve) => {
        finish = resolve;
      });
      const first = loadMaestro(cwd, () => ({
        attempt: executorAttempt(),
        outcome,
        steer: () => {},
        abort: () =>
          finish({
            exitCode: 1,
            usage: { input: 0, output: 0, cost: 0, turns: 0 },
            finalReport: "",
            touchedFiles: [],
            aborted: true,
          }),
      }));
      const drive = first.tools.get("maestro_drive");
      assert.ok(drive);
      await drive.execute("start", { action: "start" }, undefined, undefined, first.ctx);
      await waitFor(
        () => loadBoard(cwd).activeDrive !== undefined,
        "drive claim was not persisted"
      );

      first.events.get("session_shutdown")?.({ reason: "reload" }, first.ctx);
      const stopped = loadBoard(cwd);
      assert.equal(stopped.activeDrive, undefined);
      assert.equal(stopped.activeDecision?.ownerSession, owner);
      assert.equal(stopped.activeDecision?.kind, "error");
      assert.match(stopped.activeDecision?.evidence ?? "", /internal error/i);
      assert.equal(first.messages.length, 0, "shutdown must not use the stale runtime to notify");

      const reloaded = loadMaestro(cwd, undefined, owner);
      reloaded.events.get("session_start")?.({ reason: "reload" }, reloaded.ctx);
      assert.equal(reloaded.messages.length, 1);
      assert.ok(loadBoard(cwd).activeDecision?.deliveredAt);

      const foreign = loadMaestro(cwd, undefined, other);
      foreign.events.get("session_start")?.({ reason: "resume" }, foreign.ctx);
      assert.equal(foreign.messages.length, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(loadBoard(cwd).activeDecision?.kind, "error");
    }
  );
});

test("asynchronous drive setup failure cannot leave a silent stopped state", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
      createTask(board, {
        title: "Cannot launch",
        brief: "exercise launch failure",
        tier: "standard",
        writePaths: ["src/failure.ts"],
        successCriteria: ["failure is durable"],
      });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const runtime = loadMaestro(cwd, () => {
        throw new Error("spawn failed before executor launch");
      });
      const drive = runtime.tools.get("maestro_drive");
      assert.ok(drive);
      const result = await drive.execute(
        "start-failure",
        { action: "start" },
        undefined,
        undefined,
        runtime.ctx
      );
      assert.match(result.content[0]?.text ?? "", /Drive started/);
      await waitFor(
        () => loadBoard(cwd).activeDecision !== undefined,
        "claimed drive failure produced no durable decision"
      );
      const board = loadBoard(cwd);
      assert.equal(board.activeDrive, undefined);
      assert.ok(board.activeDecision?.kind);
      assert.equal(runtime.messages.length, 1);
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

test("a synchronous drive startup failure restores the decision resolution", async () => {
  await withBoard(
    (cwd) => {
      const board: Board = {
        version: 1,
        nextTaskNumber: 1,
        planPending: true,
        tasks: [],
        activeDecision: {
          id: "decision-resume-fails",
          ownerSession: owner,
          kind: "escalation_required",
          taskIds: [],
          evidence: "Correct the plan",
          allowedInterventions: ["handoff", "abort"],
          createdAt: Date.now(),
          deliveredAt: Date.now(),
        },
      };
      createTask(board, { title: "Pending", brief: "work", tier: "standard" });
      saveBoard(cwd, board);
    },
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const drive = tools.get("maestro_drive");
      assert.ok(drive);
      await assert.rejects(
        drive.execute(
          "resume-fails",
          {
            action: "intervene",
            intervention: "steer",
            decisionId: "decision-resume-fails",
            instruction: "The plan has been corrected.",
          },
          undefined,
          undefined,
          ctx
        ),
        /Plan approval is pending/
      );
      assert.equal(loadBoard(cwd).activeDecision?.resolution, undefined);
    }
  );
});

test("steering a settled decision resumes the requested scope after board fixes", async () => {
  await withBoard(
    (cwd) => {
      saveBoard(cwd, {
        version: 1,
        nextTaskNumber: 1,
        tasks: [],
        activeDecision: {
          id: "decision-resume",
          ownerSession: owner,
          kind: "escalation_required",
          taskIds: [],
          evidence: "Rewrite or split the task",
          allowedInterventions: ["handoff", "abort"],
          createdAt: Date.now(),
          deliveredAt: Date.now(),
        },
      });
    },
    async (cwd) => {
      const { ctx, tools } = loadMaestro(cwd);
      const result = await tools.get("maestro_drive")?.execute(
        "resume-decision",
        {
          action: "intervene",
          intervention: "steer",
          decisionId: "decision-resume",
          instruction: "The board has been corrected; continue.",
          taskIds: [],
        },
        undefined,
        undefined,
        ctx
      );
      assert.match(result?.content[0]?.text ?? "", /decision-resume addressed; drive resumed/);
      await waitFor(
        () => loadBoard(cwd).activeDecision?.kind === "completed",
        "resumed decision did not complete"
      );
    }
  );
});

test("failed decision delivery remains pending and retries exactly once", async () => {
  await withBoard(
    (cwd) => {
      saveBoard(cwd, {
        version: 1,
        nextTaskNumber: 1,
        tasks: [],
        activeDecision: {
          id: "retry-delivery",
          ownerSession: owner,
          kind: "blocked",
          taskIds: [],
          evidence: "Drive failed before dispatch",
          allowedInterventions: ["handoff"],
          createdAt: Date.now(),
        },
      });
    },
    async (cwd) => {
      assert.doesNotThrow(() =>
        deliverPendingDecision(cwd, owner, () => {
          throw new Error("session temporarily unavailable");
        })
      );
      assert.equal(loadBoard(cwd).activeDecision?.deliveredAt, undefined);

      const delivered: string[] = [];
      deliverPendingDecision(cwd, owner, (evidence) => delivered.push(evidence));
      deliverPendingDecision(cwd, owner, (evidence) => delivered.push(evidence));
      assert.deepEqual(delivered, ["Drive failed before dispatch"]);
      assert.ok(loadBoard(cwd).activeDecision?.deliveredAt);
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

test("reload acknowledges a decision already appended to the owner session without redelivery", async () => {
  await withBoard(
    (cwd) => {
      saveBoard(cwd, {
        version: 1,
        nextTaskNumber: 1,
        tasks: [],
        activeDecision: {
          id: "appended-before-reload",
          ownerSession: owner,
          kind: "blocked",
          taskIds: [],
          evidence: "Already persisted in the session",
          allowedInterventions: ["handoff"],
          createdAt: Date.now(),
          deliveryClaim: { id: "interrupted-delivery", claimedAt: Date.now() },
        },
      });
    },
    async (cwd) => {
      const { ctx, events, messages } = loadMaestro(cwd);
      ctx.sessionManager.getEntries = () => [
        {
          type: "custom_message",
          details: { decisionId: "appended-before-reload" },
        },
      ];

      events.get("session_start")?.({ reason: "reload" }, ctx);

      assert.equal(messages.length, 0);
      assert.ok(loadBoard(cwd).activeDecision?.deliveredAt);
      assert.equal(loadBoard(cwd).activeDecision?.deliveryClaim, undefined);
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
