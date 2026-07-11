import { sep } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  type EditorTheme,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyPlanTaskEdits,
  approvePlan,
  archiveBoard,
  blockedReason,
  createTask,
  findTask,
  forceStatus,
  isRunnable,
  listArchivedBoards,
  loadBoard,
  loadStatusHistory,
  planValidationMessage,
  rejectPlan,
  restoreArchivedBoard,
  saveBoard,
  transition,
  updateTask,
  validatePlan,
} from "./board.js";
import {
  describeConfig,
  describeTiersForPlanning,
  loadConfig,
  resolveTierModel,
} from "./config.js";
import { COMMAND, CONTEXT_NUDGE_PERCENT, MESSAGE_TYPE, REPORT_PREVIEW_LINES } from "./constants.js";
import { Dashboard, type DashboardTaskAction } from "./dashboard.js";
import { buildDoctorReport } from "./diagnostics.js";
import {
  boardUsage,
  formatBoardProgress,
  formatCostSummary,
  formatUsage,
  runBudgetWarning,
  STATUS_GLYPHS,
  STATUS_LABELS,
  taskLine,
  truncateText,
} from "./format.js";
import { buildOrchestratorBriefing, buildSupervisorBriefing } from "./prompts.js";
import {
  findSessionFile,
  mapWithConcurrencyLimit,
  type RunUpdate,
  startExecutor as defaultStartExecutor,
} from "./runner.js";
import { showSettings } from "./settings-ui.js";
import {
  type Board,
  type PausedDriveState,
  type Task,
  type TaskStatus,
  type TierConfig,
} from "./types.js";
import {
  type DriveSummary,
  driveBoard,
  executeTask,
  formatDriveSummary,
  lastReport,
  preflightTaskTiers,
  reviewTask,
  snapshot,
  type TaskSnapshot,
  type WorkflowRun,
} from "./workflow.js";
import {
  cleanupManagedWorktrees,
  createWorktree,
  inspectManagedWorktrees,
  removeWorktree,
  sweepWorktrees,
  type WorktreeRef,
  worktreeExists,
} from "./worktree.js";

interface MaestroDetails {
  action: string;
  tasks: TaskSnapshot[];
  rounds?: number;
  stoppedBecause?: DriveSummary["stoppedBecause"];
}

interface ActiveDriveControl {
  cwd: string;
  ownerSession?: string;
  taskIds?: string[];
  pauseRequested: boolean;
  abortController: AbortController;
}

interface BackgroundDrive {
  promise: Promise<void>;
  summary?: DriveSummary;
  error?: string;
}

export function maestroBoardCwd(cwd: string): string {
  const marker = `${sep}.pi${sep}maestro${sep}worktrees${sep}`;
  const worktreeIndex = cwd.indexOf(marker);
  return worktreeIndex === -1 ? cwd : cwd.slice(0, worktreeIndex);
}

export function sessionCanControlDrive(
  ownerSession: string | undefined,
  currentSession: string | undefined
): boolean {
  return (
    ownerSession === undefined || currentSession === undefined || ownerSession === currentSession
  );
}

export function sessionSwitchBlocked(activeDrive: boolean, liveRunCount: number): boolean {
  return activeDrive || liveRunCount > 0;
}

export function assertKnownTaskIds(board: Board, taskIds: string[] | undefined): void {
  if (!taskIds) return;
  const unknown = taskIds.filter((id) => !findTask(board, id));
  if (unknown.length > 0) throw new Error(`Unknown task id(s): ${unknown.join(", ")}`);
}

export function previousBoardSession(
  previousSessionFile: string | undefined,
  currentSessionFile: string | undefined,
  ownerSessions: string[] | undefined,
  executorSessions: string[]
): string | undefined {
  if (!previousSessionFile || !currentSessionFile || !ownerSessions) return undefined;

  const previousIsOwner = ownerSessions.includes(previousSessionFile);
  const currentIsOwner = ownerSessions.includes(currentSessionFile);
  const previousIsExecutor = executorSessions.includes(previousSessionFile);
  const currentIsExecutor = executorSessions.includes(currentSessionFile);

  if (previousIsOwner && currentIsExecutor) return previousSessionFile;
  if (previousIsExecutor && currentIsOwner) return previousSessionFile;
  return undefined;
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info"
): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.log(message);
  } catch {
    console.log(message); // stale ctx after session switch
  }
}

export interface MaestroDependencies {
  startExecutor: typeof defaultStartExecutor;
}

export default function maestro(
  pi: ExtensionAPI,
  dependencies: MaestroDependencies = { startExecutor: defaultStartExecutor }
) {
  // Inside a spawned executor the extension must be inert: no recursive
  // orchestration, and no session_start crash-recovery fighting the parent
  // over the shared board file.
  if (process.env.PI_MAESTRO_EXECUTOR === "1") return;

  const liveRuns = new Map<string, WorkflowRun>();
  let activeDrive: ActiveDriveControl | undefined;
  let backgroundDrive: BackgroundDrive | undefined;
  let contextNudgeShown = false;
  /** Session we switched away from when opening an executor session (for /maestro back). */
  let previousSession: string | undefined;

  function sessionOwnsBoard(ctx: ExtensionContext, board: Board): boolean {
    if (!board.ownerSessions || board.ownerSessions.length === 0) return true; // legacy board
    const current = ctx.sessionManager.getSessionFile();
    if (!current) return true; // print/RPC mode: no session identity to scope by
    return board.ownerSessions.includes(current);
  }

  /**
   * Orchestrator sessions otherwise show up as "(no messages)" in the
   * session picker: their first entry is a custom briefing, not a user
   * message pi can derive a title from.
   */
  function nameSessionAfterGoal(ctx: ExtensionContext, goal: string, role: string): void {
    if (ctx.sessionManager.getSessionName()) return; // don't overwrite a user-chosen name
    const summary = goal.length > 48 ? `${goal.slice(0, 48)}…` : goal;
    pi.setSessionName(`${role}: ${summary}`);
  }

  /** Record the current session as an owner of the board (idempotent). */
  function adoptBoard(ctx: ExtensionContext): void {
    const current = ctx.sessionManager.getSessionFile();
    if (!current) return;
    const board = loadBoard(ctx.cwd);
    if (board.ownerSessions?.includes(current)) return;
    board.ownerSessions = [...(board.ownerSessions ?? []), current];
    saveBoard(ctx.cwd, board);
  }

  function refreshUI(ctx: ExtensionContext): void {
    // Executor stdout events outlive session switches; any access on a stale
    // ctx throws. Skip — the next session's events arrive with a live ctx.
    try {
      if (!ctx.hasUI) return;
    } catch {
      return;
    }
    const board = loadBoard(ctx.cwd);

    // Sessions that never touched this board (fresh /maestro-less chats in
    // the same repo) don't get its status bar. Live runs always show:
    // this process owns them regardless of which session spawned them.
    const showBoard = sessionOwnsBoard(ctx, board) || liveRuns.size > 0;
    if (board.tasks.length === 0 || !showBoard) {
      ctx.ui.setStatus(COMMAND, undefined);
      ctx.ui.setWidget(COMMAND, undefined);
      return;
    }

    const progress = formatBoardProgress(board.tasks);
    const running = liveRuns.size;
    const usage = boardUsage(board.tasks);
    const runningPart = running > 0 ? ` · ${running} running` : "";
    const pausedPart = board.pausedDrive ? " · paused" : "";
    ctx.ui.setStatus(
      COMMAND,
      ctx.ui.theme.fg(
        running > 0 || board.pausedDrive ? "warning" : "muted",
        `⚡ maestro ${progress}${runningPart}${pausedPart} · $${usage.cost.toFixed(4)}`
      )
    );

    if (running === 0) {
      ctx.ui.setWidget(COMMAND, undefined);
      return;
    }
    ctx.ui.setWidget(COMMAND, (_tui, theme) => {
      const lines = [...liveRuns.values()].map((run) => {
        const task = findTask(board, run.taskId);
        const title = task ? task.title : run.taskId;
        const label = run.kind === "review" ? "reviewing" : "running";
        return (
          theme.fg("warning", "◐ ") +
          theme.fg("accent", `${run.taskId} `) +
          title +
          theme.fg(
            "dim",
            ` · ${label} · ${run.turns} turns · $${run.cost.toFixed(4)} · ${run.lastActivity}`
          )
        );
      });
      return { render: () => lines, invalidate: () => {} };
    });
  }

  function applyUpdate(
    ctx: ExtensionContext,
    taskId: string,
    update: RunUpdate,
    onProgress: () => void
  ): void {
    const live = liveRuns.get(taskId);
    if (live) {
      live.turns = update.turns;
      live.cost = update.cost;
      live.lastActivity = update.lastActivity;
    }
    refreshUI(ctx);
    onProgress();
  }

  function trackRun(ctx: ExtensionContext, run: WorkflowRun): () => void {
    liveRuns.set(run.taskId, run);
    refreshUI(ctx);
    // The workflow persists the running state immediately after registration.
    // Refresh again once that synchronous mutation has completed.
    queueMicrotask(() => refreshUI(ctx));
    return () => {
      liveRuns.delete(run.taskId);
      refreshUI(ctx);
    };
  }

  async function runDriveWorkflow(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    signal: AbortSignal | undefined,
    reportProgress: (message: string) => void,
    shouldPause?: () => boolean
  ): Promise<DriveSummary> {
    const config = loadConfig(ctx.cwd);
    const board = loadBoard(ctx.cwd);
    const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
    if (validationError) throw new Error(validationError);
    assertKnownTaskIds(board, taskIds);
    adoptBoard(ctx);

    const selected = taskIds
      ? taskIds.map((id) => findTask(board, id)).filter((task): task is Task => task !== undefined)
      : board.tasks;
    const unresolved = selected.filter((task) => task.status !== "approved");
    const resolvedTiers = board.planPending
      ? new Map<string, TierConfig>()
      : preflightTaskTiers(unresolved, config, ctx.modelRegistry, ctx.model?.provider);

    if (!board.planPending && unresolved.length > 0) {
      const reviewTier: TierConfig = {
        ...(config.tiers.review ?? { thinking: "high", tools: "read,bash,grep,find,ls" }),
      };
      const resolution = resolveTierModel(
        "review",
        reviewTier,
        ctx.modelRegistry,
        ctx.model?.provider
      );
      if (!resolution.ok) throw new Error(resolution.error);
      if (resolution.modelArg === undefined) delete reviewTier.model;
      else reviewTier.model = resolution.modelArg;
      resolvedTiers.set("review", reviewTier);
    }

    const driveOptions: Parameters<typeof driveBoard>[0] = {
      cwd: ctx.cwd,
      config,
      resolvedTiers,
      startExecutor: dependencies.startExecutor,
      onUpdate: (taskId, update) => applyUpdate(ctx, taskId, update, () => {}),
      onRoundUpdate: (round, phase, ids) => {
        reportProgress(`Round ${round}: ${phase} ${ids.join(", ")}`);
      },
      trackRun: (run) => trackRun(ctx, run),
    };
    if (taskIds) driveOptions.taskIds = taskIds;
    if (signal) driveOptions.signal = signal;
    if (shouldPause) driveOptions.shouldPause = shouldPause;
    return driveBoard(driveOptions);
  }

  function startBackgroundDrive(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    signal?: AbortSignal,
    reportProgress: (message: string) => void = () => {}
  ): BackgroundDrive {
    if (activeDrive) throw new Error("An autonomous drive is already active.");

    const operation: BackgroundDrive = { promise: Promise.resolve() };
    backgroundDrive = operation;
    operation.promise = runControlledDrive(ctx, taskIds, signal, reportProgress)
      .then((summary) => {
        operation.summary = summary;
      })
      .catch((error) => {
        operation.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => refreshUI(ctx));
    return operation;
  }

  function savePausedDrive(cwd: string, pausedDrive: PausedDriveState | undefined): void {
    const board = loadBoard(cwd);
    if (pausedDrive) board.pausedDrive = pausedDrive;
    else delete board.pausedDrive;
    saveBoard(cwd, board);
  }

  async function runControlledDrive(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    signal: AbortSignal | undefined,
    reportProgress: (message: string) => void
  ): Promise<DriveSummary> {
    if (activeDrive) throw new Error("An autonomous drive is already active.");
    const board = loadBoard(ctx.cwd);
    const config = loadConfig(ctx.cwd);
    const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
    if (validationError) throw new Error(validationError);
    assertKnownTaskIds(board, taskIds);

    const ownerSession = ctx.sessionManager.getSessionFile();
    const control: ActiveDriveControl = {
      cwd: ctx.cwd,
      pauseRequested: false,
      abortController: new AbortController(),
    };
    if (ownerSession) control.ownerSession = ownerSession;
    if (taskIds) control.taskIds = taskIds;
    activeDrive = control;
    savePausedDrive(ctx.cwd, undefined);

    const combinedSignal = signal
      ? AbortSignal.any([signal, control.abortController.signal])
      : control.abortController.signal;
    let summary: DriveSummary;
    try {
      summary = await runDriveWorkflow(
        ctx,
        taskIds,
        combinedSignal,
        reportProgress,
        () => control.pauseRequested
      );
    } finally {
      if (activeDrive === control) activeDrive = undefined;
    }

    if (summary.stoppedBecause.code === "paused") {
      const paused: PausedDriveState = {};
      if (taskIds) paused.taskIds = taskIds;
      if (ownerSession) paused.ownerSession = ownerSession;
      savePausedDrive(ctx.cwd, paused);
    }
    return summary;
  }

  function launchCommandDrive(ctx: ExtensionCommandContext, taskIds: string[] | undefined): void {
    const operation = startBackgroundDrive(ctx, taskIds, undefined, (message) =>
      notify(ctx, message)
    );
    void operation.promise.then(() => {
      refreshUI(ctx);
      if (operation.summary) {
        notify(
          ctx,
          formatDriveSummary(operation.summary),
          operation.summary.stoppedBecause.code === "completed" ? "info" : "warning"
        );
        return;
      }
      if (operation.error) notify(ctx, operation.error, "error");
    });
  }

  // ---------------------------------------------------------------- tools

  pi.registerTool<ReturnType<typeof Type.Object>, MaestroDetails>({
    name: "maestro_plan",
    label: "Maestro Plan",
    description:
      "Create tasks on the maestro board. Each brief must be fully self-contained: executors run with a fresh context and see only the brief plus approved dependency reports. Tiers control executor model and thinking level (trivial, standard, complex).",
    promptSnippet: "Plan tasks for fresh-context executor agents (maestro board)",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          title: Type.String({ description: "Short task title" }),
          brief: Type.String({
            description:
              "Self-contained instructions: goal, relevant file paths, constraints, acceptance criteria, verification command",
          }),
          tier: Type.String({ description: "Complexity tier: trivial, standard, or complex" }),
          commitMessage: Type.Optional(
            Type.String({
              description:
                "Conventional commit message (e.g. 'fix: handle empty board') used when this task's approved work is committed. Defaults to 'feat: <title>'.",
            })
          ),
          dependsOn: Type.Optional(
            Type.Array(Type.String({ description: "Task id like T1" }), {
              description:
                "Tasks that must be approved before this one runs. Also chain tasks that would edit the same files: parallel executors on one working tree conflict.",
            })
          ),
        }),
        { description: "Tasks to add to the board" }
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      adoptBoard(ctx);
      const config = loadConfig(ctx.cwd);
      const board = loadBoard(ctx.cwd);
      const created: Task[] = [];
      for (const input of params.tasks as {
        title: string;
        brief: string;
        tier: string;
        commitMessage?: string;
        dependsOn?: string[];
      }[]) {
        if (!config.tiers[input.tier]) {
          throw new Error(
            `Unknown tier "${input.tier}". Available tiers: ${Object.keys(config.tiers).join(", ")}`
          );
        }
        const taskInput: Parameters<typeof createTask>[1] = {
          title: input.title,
          brief: input.brief,
          tier: input.tier,
        };
        if (input.commitMessage) taskInput.commitMessage = input.commitMessage;
        if (input.dependsOn) taskInput.dependsOn = input.dependsOn;
        created.push(createTask(board, taskInput));
      }
      if (config.planGate && created.length > 0) board.planPending = true;
      saveBoard(ctx.cwd, board);
      refreshUI(ctx);

      const lines = created.map((task) => `${task.id}: ${task.title} (${task.tier})`);
      const approval = config.planGate
        ? `\n\nPlan awaits user approval via /${COMMAND} plan. Do not call maestro_run yet.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Created ${created.length} task(s):\n${lines.join("\n")}${approval}`,
          },
        ],
        details: { action: "plan", tasks: created.map((task) => snapshot(task)) },
      };
    },
    renderCall(args, theme) {
      const tasks = (args.tasks ?? []) as { title?: string; tier?: string }[];
      let text =
        theme.fg("toolTitle", theme.bold("maestro plan ")) +
        theme.fg("accent", `${tasks.length} task(s)`);
      for (const task of tasks.slice(0, 6)) {
        text += `\n  ${theme.fg("muted", "•")} ${task.title ?? "…"}${theme.fg("dim", ` [${task.tier ?? "?"}]`)}`;
      }
      if (tasks.length > 6) text += `\n  ${theme.fg("muted", `… +${tasks.length - 6} more`)}`;
      return new Text(text, 0, 0);
    },
    renderResult: renderTaskListResult,
  });

  pi.registerTool<ReturnType<typeof Type.Object>, MaestroDetails>({
    name: "maestro_run",
    label: "Maestro Run",
    description:
      "Execute runnable tasks from the maestro board in fresh-context executor agents. Independent tasks run in parallel. Tasks with changes_requested are retried with the review notes. Pass taskIds to run a subset; explicitly named failed or cancelled tasks are retried too.",
    promptSnippet: "Run planned tasks in parallel fresh-context executors (maestro board)",
    parameters: Type.Object({
      taskIds: Type.Optional(
        Type.Array(Type.String(), {
          description: "Specific task ids to run. Omit to run all runnable tasks.",
        })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const board = loadBoard(ctx.cwd);
      const requestedIds = params.taskIds as string[] | undefined;
      const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
      if (validationError) {
        return {
          content: [{ type: "text", text: validationError }],
          details: { action: "run", tasks: [] },
        };
      }
      assertKnownTaskIds(board, requestedIds);
      adoptBoard(ctx);

      if (board.planPending) {
        return {
          content: [
            {
              type: "text",
              text: `Plan approval is pending. Ask the user to review it with /${COMMAND} plan before running executors.`,
            },
          ],
          details: { action: "run", tasks: [] },
        };
      }

      // Explicitly named tasks may also retry failed/cancelled ones.
      const explicit = requestedIds !== undefined;
      const candidates = explicit
        ? requestedIds.map((id) => findTask(board, id)).filter((t): t is Task => t !== undefined)
        : board.tasks;
      const runnable = candidates.filter((task) => isRunnable(board, task, explicit));
      const blocked = candidates
        .filter(
          (task) =>
            !isRunnable(board, task, explicit) &&
            (task.status === "todo" || task.status === "changes_requested")
        )
        .map((task) => snapshot(task, blockedReason(board, task)));

      if (runnable.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No runnable tasks. Check dependencies and statuses with maestro_status.",
            },
          ],
          details: { action: "run", tasks: blocked },
        };
      }

      const budgetWarning = runBudgetWarning(board.tasks, config.maxRunCost);
      if (budgetWarning) {
        const budgetBlocked = runnable.map((task) => snapshot(task, budgetWarning));
        return {
          content: [{ type: "text", text: budgetWarning }],
          details: { action: "run", tasks: [...budgetBlocked, ...blocked] },
        };
      }

      // Preflight tier models before spawning anything: a bad pattern or
      // missing API key should fail with an actionable message, not N dead runs.
      const resolvedTiers = preflightTaskTiers(
        runnable,
        config,
        ctx.modelRegistry,
        ctx.model?.provider
      );

      const taskWorktrees = new Map<string, WorktreeRef>();
      const isolateBatch = config.useWorktrees && runnable.length > 1;
      const created: WorktreeRef[] = [];
      try {
        for (const task of runnable) {
          const previous = task.attempts.at(-1);
          const retained =
            task.status === "changes_requested" &&
            previous?.worktreePath &&
            previous.branch &&
            worktreeExists({ worktreePath: previous.worktreePath, branch: previous.branch })
              ? { worktreePath: previous.worktreePath, branch: previous.branch }
              : undefined;
          if (retained) {
            taskWorktrees.set(task.id, retained);
          } else if (isolateBatch) {
            const ref = createWorktree(ctx.cwd, task.id, task.attempts.length + 1);
            created.push(ref);
            taskWorktrees.set(task.id, ref);
          }
        }
      } catch (error) {
        for (const ref of created) removeWorktree(ctx.cwd, ref);
        throw error;
      }

      const emitProgress = () => {
        onUpdate?.({
          content: [{ type: "text", text: `Running ${liveRuns.size} executor(s)…` }],
          details: { action: "run", tasks: runnable.map((task) => snapshot(task)) },
        });
      };

      const results = await mapWithConcurrencyLimit(runnable, config.maxParallel, (task) => {
        const tier = resolvedTiers.get(task.tier);
        if (!tier) throw new Error(`No tier config for "${task.tier}"`);
        const workflowOptions: Parameters<typeof executeTask>[0] = {
          cwd: ctx.cwd,
          board,
          task,
          tier,
          config,
          startExecutor: dependencies.startExecutor,
          onUpdate: (taskId, update) => applyUpdate(ctx, taskId, update, emitProgress),
          trackRun: (run) => trackRun(ctx, run),
        };
        const worktree = taskWorktrees.get(task.id);
        if (worktree) workflowOptions.worktree = worktree;
        if (signal) workflowOptions.signal = signal;
        return executeTask(workflowOptions);
      });

      // Reports were written by executors after our board copy was loaded.
      const freshBoard = loadBoard(ctx.cwd);
      refreshUI(ctx);
      const all = [...results, ...blocked];
      const summary = all
        .map((snap) => {
          const detail = snap.note ? ` — ${snap.note}` : "";
          const report =
            snap.status === "ready_for_review" ? getReportPreview(freshBoard, snap.id) : "";
          return `${snap.id} (${snap.title}): ${STATUS_LABELS[snap.status]}${detail}${report}`;
        })
        .join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `${results.length} executor(s) finished.\n\n${summary}\n\nNext: call maestro_review for tasks that are ready for review.`,
          },
        ],
        details: { action: "run", tasks: all },
      };
    },
    renderCall(args, theme) {
      const ids = args.taskIds as string[] | undefined;
      const scope = ids && ids.length > 0 ? ids.join(", ") : "all runnable tasks";
      return new Text(
        theme.fg("toolTitle", theme.bold("maestro run ")) + theme.fg("accent", scope),
        0,
        0
      );
    },
    renderResult: renderTaskListResult,
  });

  pi.registerTool<ReturnType<typeof Type.Object>, MaestroDetails>({
    name: "maestro_review",
    label: "Maestro Review",
    description:
      "Run adversarial fresh-context reviewers over tasks that are ready for review. Reviewers have read-only tools, independently verify the executor's claims, and either approve the task or request changes (stored as review notes for the next run).",
    promptSnippet:
      "Adversarially review executor work and approve or request changes (maestro board)",
    parameters: Type.Object({
      taskIds: Type.Optional(
        Type.Array(Type.String(), {
          description: "Task ids to review. Omit to review everything that is ready for review.",
        })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const board = loadBoard(ctx.cwd);
      const requestedIds = params.taskIds as string[] | undefined;
      const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
      if (validationError) {
        return {
          content: [{ type: "text", text: validationError }],
          details: { action: "review", tasks: [] },
        };
      }
      assertKnownTaskIds(board, requestedIds);
      if (board.planPending) {
        return {
          content: [
            {
              type: "text",
              text: `Plan approval is pending. Review it with /${COMMAND} plan before starting reviewers.`,
            },
          ],
          details: { action: "review", tasks: [] },
        };
      }

      const candidates = requestedIds
        ? requestedIds.map((id) => findTask(board, id)).filter((t): t is Task => t !== undefined)
        : board.tasks;
      const reviewable = candidates.filter((task) => task.status === "ready_for_review");

      if (reviewable.length === 0) {
        return {
          content: [{ type: "text", text: "No tasks are ready for review." }],
          details: { action: "review", tasks: [] },
        };
      }

      const reviewTier: TierConfig = {
        ...(config.tiers.review ?? { thinking: "high", tools: "read,bash,grep,find,ls" }),
      };
      const resolution = resolveTierModel(
        "review",
        reviewTier,
        ctx.modelRegistry,
        ctx.model?.provider
      );
      if (!resolution.ok) throw new Error(resolution.error);
      if (resolution.modelArg === undefined) delete reviewTier.model;
      else reviewTier.model = resolution.modelArg;
      const emitProgress = () => {
        onUpdate?.({
          content: [{ type: "text", text: `Reviewing ${liveRuns.size} task(s)…` }],
          details: { action: "review", tasks: reviewable.map((task) => snapshot(task)) },
        });
      };

      const results = await mapWithConcurrencyLimit(reviewable, config.maxParallel, (task) => {
        const workflowOptions: Parameters<typeof reviewTask>[0] = {
          cwd: ctx.cwd,
          task,
          tier: reviewTier,
          startExecutor: dependencies.startExecutor,
          autoCommit: config.autoCommit,
          availableTiers: Object.keys(config.tiers),
          onUpdate: (taskId, update) => applyUpdate(ctx, taskId, update, emitProgress),
          trackRun: (run) => trackRun(ctx, run),
        };
        if (signal) workflowOptions.signal = signal;
        return reviewTask(workflowOptions);
      });

      refreshUI(ctx);
      const summary = results
        .map(
          (snap) =>
            `${snap.id} (${snap.title}): ${STATUS_LABELS[snap.status]}${snap.note ? `\n${snap.note}` : ""}`
        )
        .join("\n\n");
      const needsRerun = results.some((snap) => snap.status === "changes_requested");
      const next = needsRerun
        ? "\n\nNext: call maestro_run to retry tasks with requested changes."
        : "";
      return {
        content: [{ type: "text", text: `${summary}${next}` }],
        details: { action: "review", tasks: results },
      };
    },
    renderCall(args, theme) {
      const ids = args.taskIds as string[] | undefined;
      const scope = ids && ids.length > 0 ? ids.join(", ") : "all ready tasks";
      return new Text(
        theme.fg("toolTitle", theme.bold("maestro review ")) + theme.fg("accent", scope),
        0,
        0
      );
    },
    renderResult: renderTaskListResult,
  });

  pi.registerTool<ReturnType<typeof Type.Object>, MaestroDetails>({
    name: "maestro_drive",
    label: "Maestro Drive",
    description:
      "Start an autonomous background drive that runs, reviews, and retries maestro tasks. Returns immediately. While it is active, call maestro_status repeatedly; each status pulse waits for progress and lets you keep the user informed.",
    promptSnippet: "Drive mechanical run/review/retry cycles to completion (maestro board)",
    parameters: Type.Object({
      taskIds: Type.Optional(
        Type.Array(Type.String(), {
          description: "Specific task ids to drive. Omit to drive the whole board.",
        })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const taskIds = params.taskIds as string[] | undefined;
      if (activeDrive) throw new Error("An autonomous drive is already active.");
      assertKnownTaskIds(loadBoard(ctx.cwd), taskIds);
      startBackgroundDrive(ctx, taskIds, signal);
      return {
        content: [
          {
            type: "text",
            text: `Drive started for ${taskIds?.join(", ") ?? "the whole board"}. Call maestro_status now and repeat until the drive finishes. Briefly tell the user what changed after each pulse.`,
          },
        ],
        details: {
          action: "drive",
          tasks: loadBoard(ctx.cwd)
            .tasks.filter((task) => !taskIds || taskIds.includes(task.id))
            .map((task) => snapshot(task)),
        },
      };
    },
    renderCall(args, theme) {
      const ids = args.taskIds as string[] | undefined;
      const scope = ids && ids.length > 0 ? ids.join(", ") : "whole board";
      return new Text(
        theme.fg("toolTitle", theme.bold("maestro drive ")) + theme.fg("accent", scope),
        0,
        0
      );
    },
    renderResult: renderTaskListResult,
  });

  pi.registerTool<ReturnType<typeof Type.Object>, MaestroDetails>({
    name: "maestro_update",
    label: "Maestro Update",
    description:
      "Update a planned task: refine its brief, retitle it, change its tier or dependencies, cancel it, or reactivate it. Use when a task failed twice with the same root cause or the plan needs adjusting. Running tasks cannot be updated.",
    promptSnippet: "Refine a task's brief/tier or cancel it (maestro board)",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id like T1" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      brief: Type.Optional(Type.String({ description: "New self-contained brief" })),
      tier: Type.Optional(Type.String({ description: "New complexity tier" })),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), { description: "Replacement dependency task ids" })
      ),
      cancel: Type.Optional(
        Type.Boolean({ description: "Set true to cancel, or false to reactivate a cancelled task" })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { taskId, title, brief, tier, dependsOn, cancel } = params as {
        taskId: string;
        title?: string;
        brief?: string;
        tier?: string;
        dependsOn?: string[];
        cancel?: boolean;
      };
      const config = loadConfig(ctx.cwd);
      if (liveRuns.has(taskId.trim().toUpperCase())) {
        throw new Error(`${taskId} is running. Abort it first or wait for it to finish.`);
      }
      const updated = updateTask(ctx.cwd, taskId, (fresh) => {
        applyPlanTaskEdits(
          fresh,
          {
            ...(title !== undefined ? { title } : {}),
            ...(brief !== undefined ? { brief } : {}),
            ...(tier !== undefined ? { tier } : {}),
            ...(dependsOn !== undefined ? { dependsOn } : {}),
            ...(cancel !== undefined ? { cancelled: cancel } : {}),
          },
          Object.keys(config.tiers)
        );
      });
      if (!updated) throw new Error(`Unknown task: ${taskId}`);
      refreshUI(ctx);
      return {
        content: [{ type: "text", text: `Updated: ${taskLine(updated)}` }],
        details: { action: "update", tasks: [snapshot(updated)] },
      };
    },
    renderCall(args, theme) {
      const changes = [
        args.title ? "title" : null,
        args.brief ? "brief" : null,
        args.tier ? `tier→${args.tier}` : null,
        args.dependsOn ? "dependencies" : null,
        args.cancel === true ? "cancel" : null,
        args.cancel === false ? "reactivate" : null,
      ]
        .filter((part) => part !== null)
        .join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("maestro update ")) +
          theme.fg("accent", `${args.taskId} (${changes || "no changes"})`),
        0,
        0
      );
    },
    renderResult: renderTaskListResult,
  });

  pi.registerTool<ReturnType<typeof Type.Object>, MaestroDetails>({
    name: "maestro_status",
    label: "Maestro Status",
    description:
      "Wait for the active background drive to finish or reach the next progress pulse, then return task status plus live executor turns, cost, and activity. Default wait is configurable (60s). While a drive is active, briefly update the user after every pulse and call maestro_status again until completion.",
    promptSnippet: "Wait for and report live maestro executor progress",
    parameters: Type.Object({
      waitSeconds: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 240,
          description:
            "Seconds to wait for drive completion before returning progress. Omit for the configured default; use 0 for an immediate snapshot.",
        })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const requestedWait = (params as { waitSeconds?: number }).waitSeconds;
      const configuredWait = loadConfig(ctx.cwd).statusWaitSeconds;
      const waitSeconds = Math.min(240, Math.max(0, requestedWait ?? configuredWait));
      const operation = backgroundDrive;
      const driveRunning =
        operation && operation.summary === undefined && operation.error === undefined;

      if (driveRunning && waitSeconds > 0) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, waitSeconds * 1000);
          void operation.promise.then(finish);
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted) finish();
        });
      }

      const board = loadBoard(ctx.cwd);
      if (board.tasks.length === 0) {
        return {
          content: [{ type: "text", text: "Board is empty. Plan tasks with maestro_plan." }],
          details: { action: "status", tasks: [] },
        };
      }

      const lines = board.tasks.map((task) => {
        const blocked = blockedReason(board, task);
        const live = liveRuns.get(task.id);
        const activity = live
          ? ` · ${live.kind === "review" ? "reviewing" : "executing"} · ${live.turns} turns · $${live.cost.toFixed(4)} · ${live.lastActivity}`
          : "";
        return taskLine(task) + activity + (blocked ? ` (${blocked})` : "");
      });
      const usage = boardUsage(board.tasks);
      const settled = backgroundDrive;
      let driveState = "No background drive is active.";
      if (settled?.summary) {
        driveState = formatDriveSummary(settled.summary);
        backgroundDrive = undefined;
      } else if (settled?.error) {
        driveState = `Drive failed: ${settled.error}`;
        backgroundDrive = undefined;
      } else if (activeDrive || liveRuns.size > 0) {
        driveState = `Drive still active with ${liveRuns.size} live executor(s). Briefly report this progress to the user, then call maestro_status again.`;
      }

      return {
        content: [
          {
            type: "text",
            text: `${lines.join("\n")}\n\n${driveState}\n\nTotal: ${formatUsage(usage)}\nCosts: ${formatCostSummary(board.tasks)}`,
          },
        ],
        details: { action: "status", tasks: board.tasks.map((task) => snapshot(task)) },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("maestro status")), 0, 0);
    },
    renderResult: renderTaskListResult,
  });

  function getReportPreview(board: Board, taskId: string): string {
    const task = findTask(board, taskId);
    const report = task ? lastReport(task) : undefined;
    if (!report) return "";
    return `\nReport:\n${truncateText(report, REPORT_PREVIEW_LINES)}`;
  }

  function renderTaskListResult(
    result: { content: { type: string; text?: string }[]; details?: MaestroDetails },
    { expanded }: { expanded: boolean },
    theme: Theme
  ) {
    const details = result.details;
    if (!details || details.tasks.length === 0) {
      const text = result.content[0];
      return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
    }

    const statusColor = (
      status: TaskStatus
    ): "success" | "error" | "warning" | "accent" | "muted" => {
      if (status === "approved") return "success";
      if (status === "failed" || status === "cancelled") return "error";
      if (status === "running" || status === "changes_requested") return "warning";
      if (status === "ready_for_review") return "accent";
      return "muted";
    };

    let text = "";
    for (const snap of details.tasks) {
      const glyph = theme.fg(statusColor(snap.status), STATUS_GLYPHS[snap.status]);
      const cost = snap.cost
        ? theme.fg("dim", ` · ${snap.turns} turns · $${snap.cost.toFixed(4)}`)
        : "";
      text += `${glyph} ${theme.fg("accent", snap.id)} ${snap.title} ${theme.fg(statusColor(snap.status), STATUS_LABELS[snap.status])}${theme.fg("dim", ` [${snap.tier}]`)}${cost}\n`;
      if (
        snap.note &&
        (expanded || snap.status === "failed" || snap.status === "changes_requested")
      ) {
        const note = expanded ? snap.note : truncateText(snap.note, 3);
        text += `${theme.fg("dim", note.replace(/^/gm, "    "))}\n`;
      }
    }
    if (details.stoppedBecause) {
      const summary = formatDriveSummary({
        rounds: details.rounds ?? 0,
        tasks: details.tasks,
        stoppedBecause: details.stoppedBecause,
      });
      text += `\n${theme.fg("dim", summary)}\n`;
    }
    return new Text(text.trimEnd(), 0, 0);
  }

  // ------------------------------------------------------------- commands

  pi.registerCommand(COMMAND, {
    description:
      "Orchestrator/executor workflows: start <goal> | drive [taskIds] | pause | resume | abort | plan | board | costs | open <taskId> | history [n] | replay [file] | config | doctor [cleanup] | reset",
    getArgumentCompletions: (prefix) => {
      const options = [
        "start",
        "handoff",
        "back",
        "drive",
        "pause",
        "resume",
        "abort",
        "board",
        "plan",
        "list",
        "costs",
        "open",
        "config",
        "config project",
        "config show",
        "doctor",
        "doctor cleanup",
        "doctor cleanup confirm",
        "history",
        "replay",
        "reset",
      ];
      const matches = options.filter((option) => option.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const [sub, ...restParts] = args.trim().split(/\s+/);
      const rest = restParts.join(" ");

      switch ((sub ?? "").toLowerCase()) {
        case "start": {
          if (!rest) {
            notify(ctx, "Usage: /maestro start <goal>", "warning");
            return;
          }
          if (liveRuns.size > 0) {
            notify(
              ctx,
              "Executors are still running. Abort them before starting a new goal.",
              "warning"
            );
            return;
          }
          let board = loadBoard(ctx.cwd);
          // A new goal is a new run: archive the previous board instead of
          // piling tasks from different goals onto one endless list.
          if (board.tasks.length > 0) {
            const archivePath = archiveBoard(ctx.cwd);
            board = { version: 1, nextTaskNumber: 1, tasks: [] };
            if (archivePath) notify(ctx, `Previous board archived: ${archivePath}`);
          }
          board.goal = rest;
          saveBoard(ctx.cwd, board);
          adoptBoard(ctx);
          refreshUI(ctx);
          nameSessionAfterGoal(ctx, rest, "maestro");
          pi.sendMessage(
            {
              customType: MESSAGE_TYPE,
              content: buildOrchestratorBriefing(
                rest,
                describeTiersForPlanning(loadConfig(ctx.cwd))
              ),
              display: true,
            },
            { triggerTurn: true }
          );
          return;
        }
        case "back": {
          if (!previousSession) {
            notify(ctx, "No session to go back to. Use /resume to pick one.", "warning");
            return;
          }
          const target = previousSession;
          previousSession = ctx.sessionManager.getSessionFile();
          await ctx.switchSession(target);
          return;
        }
        case "drive": {
          if (activeDrive || liveRuns.size > 0) {
            notify(ctx, "An autonomous drive or executor batch is already running.", "warning");
            return;
          }
          const taskIds = rest ? rest.split(/[\s,]+/).filter(Boolean) : undefined;
          notify(ctx, `Driving ${taskIds?.join(", ") ?? "the whole board"}…`);
          launchCommandDrive(ctx, taskIds);
          return;
        }
        case "pause": {
          const currentSession = ctx.sessionManager.getSessionFile();
          if (!activeDrive) {
            const paused = loadBoard(ctx.cwd).pausedDrive;
            notify(
              ctx,
              paused ? "Autonomous drive is already paused." : "No autonomous drive is active.",
              "warning"
            );
            return;
          }
          if (
            activeDrive.cwd !== ctx.cwd ||
            !sessionCanControlDrive(activeDrive.ownerSession, currentSession)
          ) {
            notify(ctx, "Only the session that started this drive may pause it.", "warning");
            return;
          }
          activeDrive.pauseRequested = true;
          notify(ctx, "Pause requested. Active executors will finish; no new batch will start.");
          return;
        }
        case "resume": {
          const board = loadBoard(ctx.cwd);
          const paused = board.pausedDrive;
          if (!paused) {
            notify(ctx, "No paused autonomous drive to resume.", "warning");
            return;
          }
          if (activeDrive || liveRuns.size > 0) {
            notify(ctx, "Executors are already running.", "warning");
            return;
          }
          if (!sessionCanControlDrive(paused.ownerSession, ctx.sessionManager.getSessionFile())) {
            notify(ctx, "Only the session that paused this drive may resume it.", "warning");
            return;
          }
          notify(ctx, `Resuming ${paused.taskIds?.join(", ") ?? "the whole board"}…`);
          launchCommandDrive(ctx, paused.taskIds);
          return;
        }
        case "abort": {
          const currentSession = ctx.sessionManager.getSessionFile();
          if (activeDrive) {
            if (
              activeDrive.cwd !== ctx.cwd ||
              !sessionCanControlDrive(activeDrive.ownerSession, currentSession)
            ) {
              notify(ctx, "Only the session that started this drive may abort it.", "warning");
              return;
            }
            activeDrive.abortController.abort();
            notify(ctx, "Abort requested for the drive and its active executors.", "warning");
            return;
          }
          const paused = loadBoard(ctx.cwd).pausedDrive;
          if (!paused) {
            notify(ctx, "No active or paused autonomous drive to abort.", "warning");
            return;
          }
          if (!sessionCanControlDrive(paused.ownerSession, currentSession)) {
            notify(ctx, "Only the session that paused this drive may abort it.", "warning");
            return;
          }
          savePausedDrive(ctx.cwd, undefined);
          notify(ctx, "Paused autonomous drive aborted. No executors were running.", "warning");
          return;
        }
        case "plan":
          await showPlan(ctx);
          return;
        case "board":
        case "dash":
        case "dashboard":
          await showDashboard(ctx);
          return;
        case "list":
          await showBoard(ctx);
          return;
        case "open": {
          if (!rest) {
            notify(ctx, "Usage: /maestro open <taskId>", "warning");
            return;
          }
          await openTaskSession(ctx, rest);
          return;
        }
        case "config": {
          if (ctx.mode !== "tui" || rest === "show") {
            notify(ctx, describeConfig(loadConfig(ctx.cwd)));
            return;
          }
          const scope = rest === "project" ? "project" : "user";
          await showSettings(ctx, scope);
          refreshUI(ctx);
          return;
        }
        case "costs": {
          const board = loadBoard(ctx.cwd);
          notify(
            ctx,
            board.tasks.length === 0
              ? "No recorded costs; the board is empty."
              : formatCostSummary(board.tasks)
          );
          return;
        }
        case "doctor": {
          const liveTaskIds = new Set(liveRuns.keys());
          if (restParts[0]?.toLowerCase() !== "cleanup") {
            notify(ctx, buildDoctorReport(ctx.cwd, ctx.modelRegistry, ctx.model, liveTaskIds));
            return;
          }

          const candidates = inspectManagedWorktrees(
            ctx.cwd,
            loadBoard(ctx.cwd),
            liveTaskIds
          ).filter((entry) => entry.state === "orphaned" || entry.state === "stale");
          if (candidates.length === 0) {
            notify(ctx, "No stale or orphaned managed worktrees to clean.");
            return;
          }

          let confirmed = restParts[1]?.toLowerCase() === "confirm";
          if (ctx.hasUI && !confirmed) {
            confirmed = await ctx.ui.confirm(
              "Clean stale maestro worktrees?",
              `Remove ${candidates.length} stale/orphaned checkout(s)? Active, recoverable, and retained-conflict worktrees will be rechecked and preserved.`
            );
          }
          if (!ctx.hasUI && !confirmed) {
            notify(
              ctx,
              `Cleanup cancelled. Run /${COMMAND} doctor cleanup confirm to explicitly confirm in non-interactive mode.`,
              "warning"
            );
            return;
          }
          if (!confirmed) {
            notify(ctx, "Worktree cleanup cancelled.");
            return;
          }

          const confirmedPaths = new Set(candidates.map((entry) => entry.ref.worktreePath));
          const result = cleanupManagedWorktrees(
            ctx.cwd,
            confirmedPaths,
            () => loadBoard(ctx.cwd),
            (taskId) => liveRuns.has(taskId)
          );
          const preserved = result.preserved.filter(
            (entry) =>
              entry.state === "active" ||
              entry.state === "recoverable" ||
              entry.state === "retained-conflict"
          ).length;
          notify(
            ctx,
            `Removed ${result.removed.length} stale/orphaned worktree(s). Preserved ${preserved} active or recoverable worktree(s).`
          );
          return;
        }
        case "handoff": {
          const board = loadBoard(ctx.cwd);
          if (board.tasks.length === 0) {
            notify(ctx, "Nothing to hand off — the board is empty.", "warning");
            return;
          }
          if (liveRuns.size > 0) {
            notify(
              ctx,
              `${liveRuns.size} executor(s) still running — switching sessions would abort them. Wait or abort them first.`,
              "warning"
            );
            return;
          }
          if (ctx.hasUI) {
            const ok = await ctx.ui.confirm(
              "Hand off to a fresh orchestrator?",
              "Starts a new session where a supervisor drives run/review from the board alone, without this session's planning context. The current session stays on disk (/resume to revisit)."
            );
            if (!ok) return;
          }
          await ctx.waitForIdle();
          const briefing = buildSupervisorBriefing(
            board.goal,
            board.tasks,
            describeTiersForPlanning(loadConfig(ctx.cwd))
          );
          const parentSession = ctx.sessionManager.getSessionFile();
          // Post-switch work must use the fresh ctx from withSession; the
          // captured ctx is stale after session replacement.
          await ctx.newSession({
            ...(parentSession ? { parentSession } : {}),
            withSession: async (fresh) => {
              adoptBoard(fresh);
              nameSessionAfterGoal(fresh, board.goal ?? "maestro run", "supervisor");
              await fresh.sendMessage(
                { customType: MESSAGE_TYPE, content: briefing, display: true },
                { triggerTurn: true }
              );
            },
          });
          return;
        }
        case "history": {
          const history = loadStatusHistory(ctx.cwd);
          if (!history) {
            notify(ctx, "No history yet.");
            return;
          }
          const requestedCount = Number.parseInt(rest, 10);
          const count =
            Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : 20;
          const lines = history
            .slice(-count)
            .map((entry) => `${entry.ts} ${entry.taskId} ${entry.from} → ${entry.to}`);
          notify(ctx, lines.join("\n"));
          return;
        }
        case "replay": {
          if (liveRuns.size > 0) {
            notify(
              ctx,
              "Executors are still running. Abort them before replaying a board.",
              "warning"
            );
            return;
          }

          let selectedFile = rest;
          if (!selectedFile) {
            const archives = listArchivedBoards(ctx.cwd);
            if (archives.length === 0) {
              notify(ctx, "No archived boards found.");
              return;
            }
            const choice = await pickFromList(
              ctx,
              "Maestro Archives · newest first",
              archives.map((archive) => ({
                value: archive.file,
                label: `${archive.timestamp} · ${archive.taskCount} task(s)`,
                description: archive.file,
              }))
            );
            if (!choice) return;
            selectedFile = choice;
          }

          // Selection is asynchronous, so an executor may have started while
          // the archive picker was open. Check again immediately before restore.
          if (liveRuns.size > 0) {
            notify(
              ctx,
              "Executors are still running. Abort them before replaying a board.",
              "warning"
            );
            return;
          }

          try {
            const restored = restoreArchivedBoard(ctx.cwd, selectedFile);
            refreshUI(ctx);
            const previous = restored.archivedCurrent
              ? ` Current board archived at ${restored.archivedCurrent}.`
              : "";
            notify(ctx, `Board restored from ${restored.selectedFile}.${previous}`);
          } catch (error) {
            notify(ctx, error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        case "reset": {
          const board = loadBoard(ctx.cwd);
          if (board.tasks.length === 0) {
            notify(ctx, "Board is already empty.");
            return;
          }
          if (liveRuns.size > 0) {
            notify(ctx, "Executors are still running. Abort them before resetting.", "warning");
            return;
          }
          const archivePath = archiveBoard(ctx.cwd);
          if (!archivePath) {
            notify(ctx, "Could not archive the board; reset cancelled.", "error");
            return;
          }
          if (ctx.hasUI) {
            const ok = await ctx.ui.confirm(
              "Reset board?",
              `Delete all ${board.tasks.length} task(s) from the board? Archived at ${archivePath}`
            );
            if (!ok) return;
          }
          saveBoard(ctx.cwd, { version: 1, nextTaskNumber: 1, tasks: [] }); // also drops goal
          refreshUI(ctx);
          notify(ctx, `Board reset. Archived at ${archivePath}`);
          return;
        }
        default:
          notify(
            ctx,
            [
              `/${COMMAND} start <goal>   plan + delegate a goal with the orchestrator`,
              `/${COMMAND} handoff        continue run/review in a fresh session (drops planning context)`,
              `/${COMMAND} drive [ids]    autonomously run, review, and retry tasks`,
              `/${COMMAND} pause          stop the drive after active executors finish`,
              `/${COMMAND} resume         continue a paused drive from fresh board state`,
              `/${COMMAND} abort          abort a drive and its active executors`,
              `/${COMMAND} plan           review, approve, or reject a gated plan`,
              `/${COMMAND} board          full-screen live dashboard (steer/abort/inspect executors)`,
              `/${COMMAND} list           compact task picker`,
              `/${COMMAND} open <taskId>  switch into an executor session`,
              `/${COMMAND} back           switch back to the previous session`,
              `/${COMMAND} config         interactive settings editor (add "project" for repo scope, "show" to print)`,
              `/${COMMAND} costs          show attempts, total/average cost, models, and providers`,
              `/${COMMAND} doctor         diagnose config, models, authentication, git, and managed worktrees`,
              `/${COMMAND} doctor cleanup remove rechecked stale/orphaned worktrees after confirmation`,
              `/${COMMAND} history [n]    show recent task status changes (default 20)`,
              `/${COMMAND} replay [file]  restore an archived board (picker when omitted)`,
              `/${COMMAND} reset          archive and clear the board`,
            ].join("\n")
          );
      }
    },
  });

  pi.registerShortcut("ctrl+alt+b", {
    description: "Open the maestro dashboard",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await showDashboard(ctx);
    },
  });

  /**
   * Works from both the command handler and the shortcut. Shortcut handlers
   * only get ExtensionContext, so session actions are hidden when the host
   * cannot switch sessions.
   */
  async function showDashboard(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      if (isCommandContext(ctx)) await showBoard(ctx);
      return;
    }
    const board = loadBoard(ctx.cwd);
    if (board.tasks.length === 0) {
      notify(ctx, "Board is empty. Use /maestro start <goal> or ask the model to plan tasks.");
      return;
    }

    const selection = await ctx.ui.custom<{ taskId: string; action: DashboardTaskAction } | null>(
      (tui, theme, _keybindings, done) => {
        const dashboard = new Dashboard(theme, {
          getBoard: () => loadBoard(ctx.cwd),
          isLive: (taskId) => liveRuns.has(taskId),
          liveActivity: (taskId) => {
            const live = liveRuns.get(taskId);
            if (!live) return undefined;
            const label = live.kind === "review" ? "reviewing" : "running";
            return `${label} · ${live.turns} turns · ${live.lastActivity}`;
          },
          steer: (taskId, message) => {
            liveRuns.get(taskId)?.handle.steer(message);
          },
          abort: (taskId) => {
            liveRuns.get(taskId)?.handle.abort();
          },
          setTaskStatus: (taskId, status) => {
            updateTask(ctx.cwd, taskId, (fresh) => {
              forceStatus(fresh, status);
            });
            refreshUI(ctx);
          },
          hasExecutorSession: (taskId) => {
            const task = findTask(loadBoard(ctx.cwd), taskId);
            const attempt = task?.attempts.at(-1);
            return isCommandContext(ctx) && attempt
              ? findSessionFile(attempt) !== undefined
              : false;
          },
          hasReviewerSession: (taskId) => {
            const task = findTask(loadBoard(ctx.cwd), taskId);
            return isCommandContext(ctx) && task?.attempts.at(-1)?.reviewSessionFile !== undefined;
          },
          selectTaskAction: (taskId, action) => done({ taskId, action }),
          close: () => done(null),
          requestRender: () => tui.requestRender(),
        });
        return {
          render: (width: number) => dashboard.render(width),
          invalidate: () => dashboard.invalidate(),
          handleInput: (data: string) => dashboard.handleInput(data),
          dispose: () => dashboard.dispose(),
        };
      }
    );

    if (!selection) return;
    if (selection.action === "view_report") {
      showTaskReport(ctx.cwd, selection.taskId);
      return;
    }
    if (selection.action === "view_review") {
      showTaskReview(ctx.cwd, selection.taskId);
      return;
    }
    if (!isCommandContext(ctx)) {
      notify(ctx, `Run /${COMMAND} open ${selection.taskId} to switch sessions.`);
      return;
    }
    if (selection.action === "open_executor") {
      await openTaskSession(ctx, selection.taskId);
      return;
    }
    await openReviewerSession(ctx, selection.taskId);
  }

  function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
    return "switchSession" in ctx;
  }

  async function showPlan(ctx: ExtensionCommandContext): Promise<void> {
    if (liveRuns.size > 0) {
      notify(
        ctx,
        "Executors are still running. Finish or abort them before reviewing a plan.",
        "warning"
      );
      return;
    }

    while (true) {
      const board = loadBoard(ctx.cwd);
      if (board.tasks.length === 0) {
        notify(ctx, "Board is empty. Plan tasks with maestro_plan.", "warning");
        return;
      }
      if (!board.planPending) {
        notify(ctx, "No plan is awaiting approval.");
        return;
      }

      const editable = board.tasks.filter(
        (task) => task.status === "todo" || task.status === "cancelled"
      );
      const items: SelectItem[] = editable.map((task) => ({
        value: `task:${task.id}`,
        label: `${task.id} ${task.title} [${task.tier}]${task.status === "cancelled" ? " · CANCELLED" : ""}`,
        description: `dependsOn: ${task.dependsOn.join(", ") || "none"} · ${truncateText(task.brief, 1)}`,
      }));
      items.push(
        {
          value: "approve",
          label: "Approve plan",
          description: "Validate the complete plan, then allow execution",
        },
        {
          value: "reject",
          label: "Reject plan",
          description: "Archive and clear this board",
        }
      );

      const choice = await pickFromList(ctx, "Maestro Plan · awaiting approval", items);
      if (!choice) return;
      if (choice.startsWith("task:")) {
        await editPlanTask(ctx, choice.slice("task:".length));
        continue;
      }
      if (choice === "approve") {
        const fresh = loadBoard(ctx.cwd);
        const config = loadConfig(ctx.cwd);
        const validationError = planValidationMessage(
          approvePlan(fresh, Object.keys(config.tiers))
        );
        if (validationError) {
          notify(ctx, `${validationError}\nEdit the listed tasks before approving.`, "error");
          continue;
        }
        saveBoard(ctx.cwd, fresh);
        refreshUI(ctx);
        notify(ctx, "Plan approved. Executors may now be started with maestro_run.");
        return;
      }

      const ok =
        !ctx.hasUI ||
        (await ctx.ui.confirm(
          "Reject plan?",
          `Archive and clear all ${board.tasks.length} task(s)?`
        ));
      if (!ok) continue;
      const archivePath = rejectPlan(ctx.cwd);
      if (!archivePath) {
        notify(ctx, "Could not archive the board; rejection cancelled.", "error");
        return;
      }
      refreshUI(ctx);
      notify(ctx, `Plan rejected. Board archived at ${archivePath}`);
      return;
    }
  }

  async function editPlanTask(ctx: ExtensionCommandContext, taskId: string): Promise<void> {
    const task = findTask(loadBoard(ctx.cwd), taskId);
    if (!task) return;
    const draft = structuredClone(task);
    const tiers = Object.keys(loadConfig(ctx.cwd).tiers);

    while (true) {
      const action = await pickFromList(ctx, `${draft.id} · edit planned task`, [
        { value: "title", label: `Title · ${draft.title}` },
        { value: "brief", label: "Brief", description: truncateText(draft.brief, 3) },
        { value: "tier", label: `Tier · ${draft.tier}` },
        {
          value: "dependencies",
          label: `Dependencies · ${draft.dependsOn.join(", ") || "none"}`,
          description: "Comma- or space-separated task ids",
        },
        {
          value: "cancellation",
          label: `Cancellation · ${draft.status === "cancelled" ? "cancelled" : "active"}`,
        },
        { value: "save", label: "Save changes", description: "Validate and update the board" },
        { value: "cancel", label: "Cancel editing", description: "Discard all draft changes" },
      ]);
      if (!action || action === "cancel") return;

      if (action === "title") {
        const value = await editPlanText(ctx, "Task title", draft.title, false);
        if (value !== null) {
          try {
            applyPlanTaskEdits(draft, { title: value }, tiers);
          } catch (error) {
            notify(ctx, error instanceof Error ? error.message : String(error), "error");
          }
        }
        continue;
      }
      if (action === "brief") {
        const value = await editPlanText(ctx, "Task brief", draft.brief, true);
        if (value !== null) {
          try {
            applyPlanTaskEdits(draft, { brief: value }, tiers);
          } catch (error) {
            notify(ctx, error instanceof Error ? error.message : String(error), "error");
          }
        }
        continue;
      }
      if (action === "tier") {
        const tier = await pickFromList(
          ctx,
          "Task tier",
          tiers.map((name) => ({ value: name, label: name }))
        );
        if (tier) applyPlanTaskEdits(draft, { tier }, tiers);
        continue;
      }
      if (action === "dependencies") {
        const value = await editPlanText(ctx, "Dependencies", draft.dependsOn.join(", "), false);
        if (value !== null) {
          applyPlanTaskEdits(draft, { dependsOn: value.split(/[\s,]+/) }, tiers);
        }
        continue;
      }
      if (action === "cancellation") {
        const state = await pickFromList(ctx, "Cancellation state", [
          { value: "active", label: "Active" },
          { value: "cancelled", label: "Cancelled" },
        ]);
        if (state) applyPlanTaskEdits(draft, { cancelled: state === "cancelled" }, tiers);
        continue;
      }

      const candidate = structuredClone(loadBoard(ctx.cwd));
      const candidateTask = findTask(candidate, draft.id);
      if (!candidateTask) return;
      applyPlanTaskEdits(
        candidateTask,
        {
          title: draft.title,
          brief: draft.brief,
          tier: draft.tier,
          dependsOn: draft.dependsOn,
          cancelled: draft.status === "cancelled",
        },
        tiers
      );
      const validation = validatePlan(candidate, tiers);
      const validationError = planValidationMessage({
        missingDependencies: validation.missingDependencies.filter(
          (missing) => missing.taskId === draft.id
        ),
        dependencyCycles: validation.dependencyCycles.filter((cycle) => cycle.includes(draft.id)),
        invalidTiers: validation.invalidTiers.filter((invalid) => invalid.taskId === draft.id),
      });
      if (validationError) {
        notify(ctx, `${validationError}\nChanges were not saved.`, "error");
        continue;
      }
      updateTask(ctx.cwd, draft.id, (fresh) => {
        applyPlanTaskEdits(
          fresh,
          {
            title: draft.title,
            brief: draft.brief,
            tier: draft.tier,
            dependsOn: draft.dependsOn,
            cancelled: draft.status === "cancelled",
          },
          tiers
        );
      });
      refreshUI(ctx);
      notify(ctx, `${draft.id} plan changes saved.`);
      return;
    }
  }

  async function editPlanText(
    ctx: ExtensionCommandContext,
    title: string,
    value: string,
    multiline: boolean
  ): Promise<string | null> {
    return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
      const hint = new Text(
        theme.fg(
          "dim",
          multiline
            ? "enter save · esc cancel · use \\ + enter for newline"
            : "enter save · esc cancel"
        ),
        1,
        0
      );
      const heading = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
      const editorTheme: EditorTheme = {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      };
      const field = multiline ? new Editor(tui, editorTheme) : new Input();
      if (field instanceof Editor) field.setText(value);
      else field.setValue(value);
      field.onSubmit = (next) => done(next);
      if (field instanceof Input) field.onEscape = () => done(null);

      return {
        render: (width: number) => [
          ...heading.render(width),
          ...field.render(width),
          ...hint.render(width),
        ],
        invalidate: () => {
          heading.invalidate();
          field.invalidate();
          hint.invalidate();
        },
        handleInput: (data: string) => {
          if (field instanceof Editor && matchesKey(data, Key.escape)) {
            done(null);
            return;
          }
          field.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  async function showBoard(ctx: ExtensionCommandContext): Promise<void> {
    const board = loadBoard(ctx.cwd);
    if (board.tasks.length === 0) {
      notify(ctx, "Board is empty. Use /maestro start <goal> or ask the model to plan tasks.");
      return;
    }

    const items: SelectItem[] = board.tasks.map((task) => ({
      value: task.id,
      label: taskLine(task),
      description: truncateText(task.brief, 1),
    }));

    const taskId = await pickFromList(
      ctx,
      `Maestro Board · ${formatUsage(boardUsage(board.tasks))}`,
      items
    );
    if (!taskId) return;
    await showTaskActions(ctx, taskId);
  }

  async function showTaskActions(ctx: ExtensionCommandContext, taskId: string): Promise<void> {
    const board = loadBoard(ctx.cwd);
    const task = findTask(board, taskId);
    if (!task) return;

    const actions: SelectItem[] = [{ value: "report", label: "View last report" }];
    if (task.attempts.at(-1)?.reviewReport) {
      actions.push({ value: "review", label: "View review verdict" });
    }
    if (task.attempts.length > 0) {
      actions.push({
        value: "open",
        label: "Open executor session",
        description: "Switch this TUI into the executor's session",
      });
    }
    if (task.attempts.at(-1)?.reviewSessionFile) {
      actions.push({
        value: "open-review",
        label: "Open reviewer session",
        description: "Switch this TUI into the reviewer's session",
      });
    }
    for (const status of [
      "todo",
      "ready_for_review",
      "changes_requested",
      "approved",
      "cancelled",
    ] as TaskStatus[]) {
      if (status !== task.status) {
        actions.push({ value: `status:${status}`, label: `Mark as ${STATUS_LABELS[status]}` });
      }
    }

    const action = await pickFromList(
      ctx,
      `${task.id} ${task.title} · ${STATUS_LABELS[task.status]}`,
      actions
    );
    if (!action) return;

    if (action === "report") {
      showTaskReport(ctx.cwd, task.id);
      return;
    }
    if (action === "review") {
      showTaskReview(ctx.cwd, task.id);
      return;
    }
    if (action === "open") {
      await openTaskSession(ctx, task.id);
      return;
    }
    if (action === "open-review") {
      await openReviewerSession(ctx, task.id);
      return;
    }
    if (action.startsWith("status:")) {
      const status = action.slice("status:".length) as TaskStatus;
      updateTask(ctx.cwd, task.id, (fresh) => {
        forceStatus(fresh, status);
      });
      refreshUI(ctx);
      notify(ctx, `${task.id} → ${STATUS_LABELS[status]}`);
    }
  }

  function showTaskReport(cwd: string, taskId: string): void {
    const task = findTask(loadBoard(cwd), taskId);
    if (!task) return;
    const report = lastReport(task) ?? "(no report yet)";
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: `## ${task.id} ${task.title} — last report\n\n${report}`,
      display: true,
    });
  }

  function showTaskReview(cwd: string, taskId: string): void {
    const task = findTask(loadBoard(cwd), taskId);
    if (!task) return;
    const review = task.attempts.at(-1)?.reviewReport ?? "(no review yet)";
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: `## ${task.id} ${task.title} — review verdict\n\n${review}`,
      display: true,
    });
  }

  async function openReviewerSession(ctx: ExtensionCommandContext, taskId: string): Promise<void> {
    const task = findTask(loadBoard(ctx.cwd), taskId);
    const reviewSession = task?.attempts.at(-1)?.reviewSessionFile;
    if (reviewSession) await switchWithReturn(ctx, reviewSession);
  }

  async function openTaskSession(ctx: ExtensionCommandContext, taskId: string): Promise<void> {
    const board = loadBoard(ctx.cwd);
    const task = findTask(board, taskId);
    if (!task) {
      notify(ctx, `Unknown task: ${taskId}`, "error");
      return;
    }
    if (liveRuns.has(task.id)) {
      // The executor process owns that session file while running; attaching
      // the TUI to it would fork history. The dashboard tails it live instead.
      notify(
        ctx,
        `${task.id} is still running — watch it live in /${COMMAND} board (s to steer, x to abort). The session opens here once it finishes.`,
        "warning"
      );
      return;
    }
    const attempt = task.attempts.at(-1);
    const sessionFile = attempt ? findSessionFile(attempt) : undefined;
    if (!sessionFile) {
      notify(ctx, `${task.id} has no executor session yet.`, "warning");
      return;
    }
    const ok = await ctx.ui.confirm(
      `Open executor session for ${task.id}?`,
      `This switches the current TUI into the executor's session. Use /${COMMAND} back to return here.`
    );
    if (!ok) return;
    await switchWithReturn(ctx, sessionFile);
  }

  /** Switch sessions, remembering where we came from for /maestro back. */
  async function switchWithReturn(
    ctx: ExtensionCommandContext,
    sessionFile: string
  ): Promise<void> {
    if (sessionSwitchBlocked(activeDrive !== undefined, liveRuns.size)) {
      notify(
        ctx,
        `Pause the autonomous drive and wait for active executors before switching sessions. Use /${COMMAND} abort to stop them immediately.`,
        "warning"
      );
      return;
    }
    const current = ctx.sessionManager.getSessionFile();
    const result = await ctx.switchSession(sessionFile);
    if (!result.cancelled && current) previousSession = current;
  }

  async function pickFromList(
    ctx: ExtensionCommandContext,
    title: string,
    items: SelectItem[]
  ): Promise<string | null> {
    return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      const list = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc close"), 1, 0));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  // ------------------------------------------------------------ rendering

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(theme.fg("accent", "⚡ maestro\n") + content, 0, 0);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (contextNudgeShown) return;

    try {
      const usage = ctx.getContextUsage();
      if (!usage || usage.percent === null || usage.percent < CONTEXT_NUDGE_PERCENT) return;

      const board = loadBoard(ctx.cwd);
      if (board.tasks.length === 0 || !sessionOwnsBoard(ctx, board) || !ctx.hasUI) return;

      ctx.ui.notify(
        `Orchestrator context at ${Math.round(usage.percent)}% - consider /maestro handoff to continue with a clean supervisor.`
      );
      contextNudgeShown = true;
    } catch {
      // The turn may belong to a context invalidated by a session switch.
    }
  });

  pi.on("session_before_switch", (_event, ctx) => {
    if (!sessionSwitchBlocked(activeDrive !== undefined, liveRuns.size)) return;
    notify(
      ctx,
      `Session switch blocked while maestro work is active. Use /${COMMAND} pause and wait, or /${COMMAND} abort.`,
      "warning"
    );
    return { cancel: true };
  });

  pi.on("session_before_fork", (_event, ctx) => {
    if (!sessionSwitchBlocked(activeDrive !== undefined, liveRuns.size)) return;
    notify(
      ctx,
      `Session fork blocked while maestro work is active. Use /${COMMAND} pause and wait, or /${COMMAND} abort.`,
      "warning"
    );
    return { cancel: true };
  });

  pi.on("session_start", (event, ctx) => {
    liveRuns.clear();
    contextNudgeShown = false;
    // Session switches reload extensions, so switchWithReturn's in-memory
    // reference does not survive. Executor sessions may have a worktree cwd,
    // while their board and owner session remain linked from the main checkout.
    const navigationBoard = loadBoard(maestroBoardCwd(ctx.cwd));
    const executorSessions = navigationBoard.tasks.flatMap((task) =>
      task.attempts.flatMap((attempt) =>
        [attempt.sessionFile, attempt.reviewSessionFile].filter(
          (sessionFile): sessionFile is string => sessionFile !== undefined
        )
      )
    );
    previousSession = previousBoardSession(
      event.previousSessionFile,
      ctx.sessionManager.getSessionFile(),
      navigationBoard.ownerSessions,
      executorSessions
    );

    const board = loadBoard(ctx.cwd);
    // Executors die with the pi process; a task still marked running on
    // startup is a stale leftover from a crash or hard exit.
    for (const task of board.tasks) {
      if (task.status !== "running") continue;
      updateTask(ctx.cwd, task.id, (fresh) => {
        transition(fresh, "failed");
      });
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${task.id} was running when pi exited; marked failed. Retry with maestro_run ["${task.id}"].`,
          "warning"
        );
      }
    }
    const recovered = loadBoard(ctx.cwd);
    const knownWorktrees = recovered.tasks.flatMap((task) =>
      task.attempts.flatMap((attempt) =>
        attempt.worktreePath && attempt.branch
          ? [{ worktreePath: attempt.worktreePath, branch: attempt.branch }]
          : []
      )
    );
    const retained = recovered.tasks
      .filter((task) => task.status === "ready_for_review" || task.status === "changes_requested")
      .flatMap((task) => {
        const attempt = task.attempts.at(-1);
        return attempt?.worktreePath && attempt.branch
          ? [{ worktreePath: attempt.worktreePath, branch: attempt.branch }]
          : [];
      });
    try {
      sweepWorktrees(ctx.cwd, retained, knownWorktrees);
    } catch (error) {
      notify(ctx, `Could not clean stale maestro worktrees: ${String(error)}`, "warning");
    }
    refreshUI(ctx);
  });

  // The before-switch/fork guards normally keep active work in this runtime.
  // Shutdown still aborts as a final safety net so a forced reload or exit can never orphan it.
  pi.on("session_shutdown", () => {
    activeDrive?.abortController.abort();
    for (const run of liveRuns.values()) {
      run.handle.abort();
    }
    liveRuns.clear();
  });
}
