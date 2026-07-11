import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  blockedReason,
  createTask,
  findTask,
  isRunnable,
  loadBoard,
  saveBoard,
  stateDir,
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
  taskUsage,
  truncateText,
} from "./format.js";
import {
  buildExecutorPrompt,
  buildOrchestratorBriefing,
  buildSupervisorBriefing,
  buildReviewPrompt,
  parseVerdict,
} from "./prompts.js";
import { Dashboard } from "./dashboard.js";
import {
  type ExecutorHandle,
  findSessionFile,
  mapWithConcurrencyLimit,
  startExecutor,
} from "./runner.js";
import { showSettings } from "./settings-ui.js";
import {
  type Board,
  type MaestroConfig,
  type Task,
  type TaskStatus,
  type TierConfig,
} from "./types.js";

interface LiveRun {
  taskId: string;
  kind: "execute" | "review";
  turns: number;
  cost: number;
  lastActivity: string;
  handle: ExecutorHandle;
}

interface TaskSnapshot {
  id: string;
  title: string;
  status: TaskStatus;
  tier: string;
  attempts: number;
  cost: number;
  turns: number;
  note?: string;
}

interface MaestroDetails {
  action: string;
  tasks: TaskSnapshot[];
}

function snapshot(task: Task, note?: string): TaskSnapshot {
  const usage = taskUsage(task);
  const snap: TaskSnapshot = {
    id: task.id,
    title: task.title,
    status: task.status,
    tier: task.tier,
    attempts: task.attempts.length,
    cost: usage.cost,
    turns: usage.turns,
  };
  if (note !== undefined) snap.note = note;
  return snap;
}

function lastReport(task: Task): string | undefined {
  return task.attempts.at(-1)?.finalReport;
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info"
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

export default function maestro(pi: ExtensionAPI) {
  // Inside a spawned executor the extension must be inert: no recursive
  // orchestration, and no session_start crash-recovery fighting the parent
  // over the shared board file.
  if (process.env.PI_MAESTRO_EXECUTOR === "1") return;

  const liveRuns = new Map<string, LiveRun>();

  function refreshUI(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const board = loadBoard(ctx.cwd);

    if (board.tasks.length === 0) {
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
    update: { turns: number; cost: number; lastActivity: string },
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

  function trackRun(ctx: ExtensionContext, run: LiveRun): () => void {
    liveRuns.set(run.taskId, run);
    refreshUI(ctx);
    return () => {
      liveRuns.delete(run.taskId);
      refreshUI(ctx);
    };
  }

  async function executeTask(
    board: Board,
    task: Task,
    tier: TierConfig,
    config: MaestroConfig,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onProgress: () => void
  ): Promise<TaskSnapshot> {
    if (task.attempts.length >= config.maxAttempts) {
      const updated = updateTask(ctx.cwd, task.id, (fresh) => {
        fresh.status = "failed";
      });
      return snapshot(
        updated ?? task,
        `attempt cap reached (${config.maxAttempts}); rewrite the brief with maestro_update or raise maxAttempts`
      );
    }
    const dependencyReports = task.dependsOn
      .map((depId) => findTask(board, depId))
      .filter((dep): dep is Task => dep !== undefined && lastReport(dep) !== undefined)
      .map((dep) => ({ id: dep.id, title: dep.title, report: lastReport(dep) ?? "" }));

    const attemptIndex = task.attempts.length + 1;
    const runOptions: Parameters<typeof startExecutor>[0] = {
      stateDir: stateDir(ctx.cwd),
      runId: `${task.id}-attempt-${attemptIndex}`,
      cwd: ctx.cwd,
      prompt: buildExecutorPrompt(task, dependencyReports),
      tier,
      onUpdate: (update) => applyUpdate(ctx, task.id, update, onProgress),
    };
    if (signal) runOptions.signal = signal;
    if (config.maxCostPerTask > 0) runOptions.maxCost = config.maxCostPerTask;
    const run = startExecutor(runOptions);
    run.attempt.index = attemptIndex;

    const live: LiveRun = {
      taskId: task.id,
      kind: "execute",
      turns: 0,
      cost: 0,
      lastActivity: "starting…",
      handle: run,
    };
    const untrack = trackRun(ctx, live);

    // All board writes go through updateTask (fresh load per write) because
    // parallel executors finish in arbitrary order.
    updateTask(ctx.cwd, task.id, (fresh) => {
      fresh.status = "running";
      fresh.attempts.push(run.attempt);
    });

    const outcome = await run.outcome;
    untrack();

    if (outcome.finalReport) run.attempt.finalReport = outcome.finalReport;
    if (outcome.model !== undefined) run.attempt.model = outcome.model;

    const status: TaskStatus = outcome.aborted
      ? "cancelled"
      : outcome.exitCode !== 0 || outcome.errorMessage
        ? "failed"
        : "ready_for_review";

    const updated = updateTask(ctx.cwd, task.id, (fresh) => {
      fresh.status = status;
      fresh.attempts[fresh.attempts.length - 1] = run.attempt;
    });

    const note = outcome.aborted
      ? "aborted by user"
      : status === "failed"
        ? (outcome.errorMessage ?? `exit code ${outcome.exitCode}`)
        : undefined;
    return snapshot(updated ?? task, note);
  }

  async function reviewTask(
    task: Task,
    tier: TierConfig,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onProgress: () => void
  ): Promise<TaskSnapshot> {
    const report = lastReport(task);
    if (!report) {
      return snapshot(task, "no executor report to review");
    }

    const runOptions: Parameters<typeof startExecutor>[0] = {
      stateDir: stateDir(ctx.cwd),
      runId: `${task.id}-review-${task.attempts.length}`,
      cwd: ctx.cwd,
      prompt: buildReviewPrompt(task, report),
      tier,
      onUpdate: (update) => applyUpdate(ctx, task.id, update, onProgress),
    };
    if (signal) runOptions.signal = signal;
    const run = startExecutor(runOptions);

    const live: LiveRun = {
      taskId: task.id,
      kind: "review",
      turns: 0,
      cost: 0,
      lastActivity: "starting…",
      handle: run,
    };
    const untrack = trackRun(ctx, live);

    const outcome = await run.outcome;
    untrack();

    const verdict =
      outcome.aborted || outcome.exitCode !== 0 || outcome.errorMessage
        ? undefined
        : parseVerdict(outcome.finalReport);

    const updated = updateTask(ctx.cwd, task.id, (fresh) => {
      // Reviewer usage is billed against the task for honest per-task cost.
      const attempt = fresh.attempts.at(-1);
      if (attempt) {
        attempt.usage.input += outcome.usage.input;
        attempt.usage.output += outcome.usage.output;
        attempt.usage.cost += outcome.usage.cost;
        attempt.usage.turns += outcome.usage.turns;
      }
      if (!verdict) return; // aborted/failed/no verdict: stays ready_for_review
      if (verdict.approved) {
        fresh.status = "approved";
        delete fresh.reviewNotes;
      } else {
        fresh.status = "changes_requested";
        fresh.reviewNotes = verdict.notes || outcome.finalReport;
      }
    });

    const result = updated ?? task;
    if (outcome.aborted)
      return snapshot(result, "review aborted by user; task stays ready for review");
    if (outcome.exitCode !== 0 || outcome.errorMessage) {
      return snapshot(result, `review failed: ${outcome.errorMessage ?? outcome.exitCode}`);
    }
    if (!verdict) {
      return snapshot(result, "reviewer gave no VERDICT line; review again or inspect manually");
    }
    return snapshot(result, verdict.approved ? "approved" : truncateText(verdict.notes, 10));
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
              description: "Tasks that must be approved before this one runs",
            })
          ),
        }),
        { description: "Tasks to add to the board" }
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
      const resolvedTiers = new Map<string, TierConfig>();
      for (const task of runnable) {
        if (resolvedTiers.has(task.tier)) continue;
        const tier = config.tiers[task.tier] ?? config.tiers.standard;
        if (!tier) throw new Error(`No tier config for "${task.tier}" and no standard fallback`);
        const resolution = resolveTierModel(
          task.tier,
          tier,
          ctx.modelRegistry,
          ctx.model?.provider
        );
        if (!resolution.ok) throw new Error(resolution.error);
        const resolved: TierConfig = { ...tier };
        if (resolution.modelArg === undefined) delete resolved.model;
        else resolved.model = resolution.modelArg;
        resolvedTiers.set(task.tier, resolved);
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
        return executeTask(board, task, tier, config, ctx, signal, emitProgress);
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

      const results = await mapWithConcurrencyLimit(reviewable, config.maxParallel, (task) =>
        reviewTask(task, reviewTier, ctx, signal, emitProgress)
      );

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
            fresh.status = "todo";
          }
        }
        if (tier) fresh.tier = tier;
        if (cancel) fresh.status = "cancelled";
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
      "Orchestrator/executor workflows: start <goal> | board | open <taskId> | config | reset",
    getArgumentCompletions: (prefix) => {
      const options = [
        "start",
        "handoff",
        "board",
        "list",
        "open",
        "config",
        "config project",
        "config show",
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
            board.tasks.map((task) => taskLine(task)).join("\n"),
            describeTiersForPlanning(loadConfig(ctx.cwd))
          );
          const parentSession = ctx.sessionManager.getSessionFile();
          const result = await ctx.newSession(parentSession ? { parentSession } : {});
          if (result.cancelled) return;
          pi.sendMessage(
            { customType: MESSAGE_TYPE, content: briefing, display: true },
            { triggerTurn: true }
          );
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
          if (ctx.hasUI) {
            const ok = await ctx.ui.confirm(
              "Reset board?",
              `Delete all ${board.tasks.length} task(s) from the board?`
            );
            if (!ok) return;
          }
          saveBoard(ctx.cwd, { version: 1, nextTaskNumber: 1, tasks: [] }); // also drops goal
          refreshUI(ctx);
          notify(ctx, "Board reset.");
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
              `/${COMMAND} config         interactive settings editor (add "project" for repo scope, "show" to print)`,
              `/${COMMAND} reset          clear the board`,
            ].join("\n")
          );
      }
    },
  });

  pi.registerShortcut("ctrl+alt+b", {
    description: "Open the maestro dashboard",
    handler: (ctx) => {
      if (!ctx.hasUI) return;
      // Route through the command so the handler gets ExtensionCommandContext
      // (needed for switchSession when opening an executor session).
      pi.sendUserMessage(`/${COMMAND} board`);
    },
  });

  async function showDashboard(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
      await showBoard(ctx);
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
            fresh.status = status;
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

    if (openTaskId) await openTaskSession(ctx, openTaskId);
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
    if (task.attempts.length > 0) {
      actions.push({
        value: "open",
        label: "Open executor session",
        description: "Switch this TUI into the executor's session",
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
    if (action === "open") {
      await openTaskSession(ctx, task.id);
      return;
    }
    if (action.startsWith("status:")) {
      const status = action.slice("status:".length) as TaskStatus;
      updateTask(ctx.cwd, task.id, (fresh) => {
        fresh.status = status;
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
      notify(
        ctx,
        `${task.id} is still running. Wait for it to finish, or watch its log: ${task.attempts.at(-1)?.logFile}`,
        "warning"
      );
      return;
    }
    const attempt = task.attempts.at(-1);
    const sessionFile = attempt ? findSessionFile(attempt.sessionDir) : undefined;
    if (!sessionFile) {
      notify(ctx, `${task.id} has no executor session yet.`, "warning");
      return;
    }
    const ok = await ctx.ui.confirm(
      `Open executor session for ${task.id}?`,
      "This switches the current TUI into the executor's session. Use /resume to come back to the orchestrator."
    );
    if (!ok) return;
    await ctx.switchSession(sessionFile);
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
        fresh.status = "failed";
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
