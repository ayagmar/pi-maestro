import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  archiveBoard,
  blockedReason,
  createTask,
  findTask,
  forceStatus,
  isRunnable,
  loadBoard,
  loadStatusHistory,
  saveBoard,
  transition,
  updateTask,
} from "./board.js";
import {
  describeConfig,
  describeTiersForPlanning,
  loadConfig,
  resolveTierModel,
} from "./config.js";
import { COMMAND, MESSAGE_TYPE, REPORT_PREVIEW_LINES } from "./constants.js";
import {
  boardUsage,
  formatUsage,
  STATUS_GLYPHS,
  STATUS_LABELS,
  taskLine,
  truncateText,
} from "./format.js";
import { buildOrchestratorBriefing, buildSupervisorBriefing } from "./prompts.js";
import { Dashboard } from "./dashboard.js";
import {
  findSessionFile,
  mapWithConcurrencyLimit,
  type RunUpdate,
  startExecutor,
} from "./runner.js";
import { showSettings } from "./settings-ui.js";
import { type Board, type Task, type TaskStatus, type TierConfig } from "./types.js";
import {
  executeTask,
  lastReport,
  preflightTaskTiers,
  reviewTask,
  snapshot,
  type TaskSnapshot,
  type WorkflowRun,
} from "./workflow.js";

interface MaestroDetails {
  action: string;
  tasks: TaskSnapshot[];
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

export default function maestro(pi: ExtensionAPI) {
  // Inside a spawned executor the extension must be inert: no recursive
  // orchestration, and no session_start crash-recovery fighting the parent
  // over the shared board file.
  if (process.env.PI_MAESTRO_EXECUTOR === "1") return;

  const liveRuns = new Map<string, WorkflowRun>();
  /** Session we switched away from when opening an executor session (for /maestro back). */
  let previousSession: string | undefined;

  function sessionOwnsBoard(ctx: ExtensionContext, board: Board): boolean {
    if (!board.ownerSessions || board.ownerSessions.length === 0) return true; // legacy board
    const current = ctx.sessionManager.getSessionFile();
    if (!current) return true; // print/RPC mode: no session identity to scope by
    return board.ownerSessions.includes(current);
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

    const approved = board.tasks.filter((t) => t.status === "approved").length;
    const running = liveRuns.size;
    const usage = boardUsage(board.tasks);
    const runningPart = running > 0 ? ` · ${running} running` : "";
    ctx.ui.setStatus(
      COMMAND,
      ctx.ui.theme.fg(
        running > 0 ? "warning" : "muted",
        `⚡ maestro ${approved}/${board.tasks.length}${runningPart} · $${usage.cost.toFixed(4)}`
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
    return () => {
      liveRuns.delete(run.taskId);
      refreshUI(ctx);
    };
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
        if (input.dependsOn) taskInput.dependsOn = input.dependsOn;
        created.push(createTask(board, taskInput));
      }
      saveBoard(ctx.cwd, board);
      refreshUI(ctx);

      const lines = created.map((task) => `${task.id}: ${task.title} (${task.tier})`);
      return {
        content: [
          { type: "text", text: `Created ${created.length} task(s):\n${lines.join("\n")}` },
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
      adoptBoard(ctx);
      const config = loadConfig(ctx.cwd);
      const board = loadBoard(ctx.cwd);
      const requestedIds = params.taskIds as string[] | undefined;

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

      // Preflight tier models before spawning anything: a bad pattern or
      // missing API key should fail with an actionable message, not N dead runs.
      const resolvedTiers = preflightTaskTiers(
        runnable,
        config,
        ctx.modelRegistry,
        ctx.model?.provider
      );

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
          startExecutor,
          onUpdate: (taskId, update) => applyUpdate(ctx, taskId, update, emitProgress),
          trackRun: (run) => trackRun(ctx, run),
        };
        if (signal) workflowOptions.signal = signal;
        return executeTask(workflowOptions);
      });

      // Reports were written by executors after our board copy was loaded.
      const freshBoard = loadBoard(ctx.cwd);
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
          startExecutor,
          onUpdate: (taskId, update) => applyUpdate(ctx, taskId, update, emitProgress),
          trackRun: (run) => trackRun(ctx, run),
        };
        if (signal) workflowOptions.signal = signal;
        return reviewTask(workflowOptions);
      });

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
    name: "maestro_update",
    label: "Maestro Update",
    description:
      "Update a planned task: refine its brief, retitle it, change its tier, or cancel it. Use when a task failed twice with the same root cause or the plan needs adjusting. Running tasks cannot be updated.",
    promptSnippet: "Refine a task's brief/tier or cancel it (maestro board)",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id like T1" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      brief: Type.Optional(Type.String({ description: "New self-contained brief" })),
      tier: Type.Optional(Type.String({ description: "New complexity tier" })),
      cancel: Type.Optional(Type.Boolean({ description: "Cancel the task" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { taskId, title, brief, tier, cancel } = params as {
        taskId: string;
        title?: string;
        brief?: string;
        tier?: string;
        cancel?: boolean;
      };
      if (tier && !loadConfig(ctx.cwd).tiers[tier]) {
        throw new Error(
          `Unknown tier "${tier}". Available tiers: ${Object.keys(loadConfig(ctx.cwd).tiers).join(", ")}`
        );
      }
      if (liveRuns.has(taskId.trim().toUpperCase())) {
        throw new Error(`${taskId} is running. Abort it first or wait for it to finish.`);
      }
      const updated = updateTask(ctx.cwd, taskId, (fresh) => {
        if (title) fresh.title = title;
        if (brief) {
          fresh.brief = brief;
          // A rewritten brief supersedes review feedback on the old one.
          delete fresh.reviewNotes;
          if (fresh.status === "changes_requested" || fresh.status === "failed") {
            forceStatus(fresh, "todo");
          }
        }
        if (tier) fresh.tier = tier;
        if (cancel) forceStatus(fresh, "cancelled");
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
        args.cancel ? "cancel" : null,
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
      "Cheap status pulse of the maestro board: every task with its status, tier, attempts, and cost. Use this instead of re-reading executor output.",
    promptSnippet: "Check status of maestro board tasks",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const board = loadBoard(ctx.cwd);
      if (board.tasks.length === 0) {
        return {
          content: [{ type: "text", text: "Board is empty. Plan tasks with maestro_plan." }],
          details: { action: "status", tasks: [] },
        };
      }
      const lines = board.tasks.map((task) => {
        const blocked = blockedReason(board, task);
        return taskLine(task) + (blocked ? ` (${blocked})` : "");
      });
      const usage = boardUsage(board.tasks);
      return {
        content: [{ type: "text", text: `${lines.join("\n")}\n\nTotal: ${formatUsage(usage)}` }],
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
    return new Text(text.trimEnd(), 0, 0);
  }

  // ------------------------------------------------------------- commands

  pi.registerCommand(COMMAND, {
    description:
      "Orchestrator/executor workflows: start <goal> | board | open <taskId> | history [n] | config | reset",
    getArgumentCompletions: (prefix) => {
      const options = [
        "start",
        "handoff",
        "back",
        "board",
        "list",
        "open",
        "config",
        "config project",
        "config show",
        "history",
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
          const board = loadBoard(ctx.cwd);
          board.goal = rest;
          saveBoard(ctx.cwd, board);
          adoptBoard(ctx);
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
              `/${COMMAND} board          full-screen live dashboard (steer/abort/inspect executors)`,
              `/${COMMAND} list           compact task picker`,
              `/${COMMAND} open <taskId>  switch into an executor session`,
              `/${COMMAND} back           switch back to the previous session`,
              `/${COMMAND} config         interactive settings editor (add "project" for repo scope, "show" to print)`,
              `/${COMMAND} history [n]    show recent task status changes (default 20)`,
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
   * only get ExtensionContext (no switchSession), so opening an executor
   * session from there falls back to a hint instead of switching.
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

    const openTaskId = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
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
        openSession: (taskId) => done(taskId),
        close: () => done(null),
        requestRender: () => tui.requestRender(),
      });
      return {
        render: (width: number) => dashboard.render(width),
        invalidate: () => dashboard.invalidate(),
        handleInput: (data: string) => dashboard.handleInput(data),
        dispose: () => dashboard.dispose(),
      };
    });

    if (!openTaskId) return;
    if (isCommandContext(ctx)) {
      await openTaskSession(ctx, openTaskId);
      return;
    }
    notify(ctx, `Run /${COMMAND} open ${openTaskId} to switch into the executor session.`);
  }

  function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
    return "switchSession" in ctx;
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
      const report = lastReport(task) ?? "(no report yet)";
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: `## ${task.id} ${task.title} — last report\n\n${report}`,
        display: true,
      });
      return;
    }
    if (action === "review") {
      const review = task.attempts.at(-1)?.reviewReport ?? "(no review yet)";
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: `## ${task.id} ${task.title} — review verdict\n\n${review}`,
        display: true,
      });
      return;
    }
    if (action === "open") {
      await openTaskSession(ctx, task.id);
      return;
    }
    if (action === "open-review") {
      const reviewSession = task.attempts.at(-1)?.reviewSessionFile;
      if (reviewSession) await switchWithReturn(ctx, reviewSession);
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

  pi.on("session_start", (_event, ctx) => {
    liveRuns.clear();
    // Executors die with the pi process; a task still marked running on
    // startup is a stale leftover from a crash or hard exit.
    const board = loadBoard(ctx.cwd);
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
    refreshUI(ctx);
  });

  // Kill live executors on pi exit so no orphan processes keep burning tokens.
  pi.on("session_shutdown", () => {
    for (const run of liveRuns.values()) {
      run.handle.abort();
    }
    liveRuns.clear();
  });
}
