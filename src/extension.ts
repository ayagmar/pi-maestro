import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
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
import {
  applyPlanTaskEdits,
  approvePlan,
  archiveBoard,
  findTask,
  forceStatus,
  listArchivedBoards,
  loadArchivedBoard,
  loadBoard,
  loadStatusHistory,
  planValidationMessage,
  rejectPlan,
  replaceBoard,
  restoreArchivedBoard,
  saveBoard,
  scopedDependencyGaps,
  sweepDispatchState,
  updateTask,
  validatePlan,
} from "./board.js";
import { parseCommand, registerMaestroCommand } from "./commands.js";
import {
  describeConfig,
  describeTiersForPlanning,
  loadConfig,
  resolveTierModels,
} from "./config.js";
import { COMMAND, CONTEXT_NUDGE_PERCENT, MESSAGE_TYPE, REPORT_PREVIEW_LINES } from "./constants.js";
import { Dashboard, type DashboardTaskAction } from "./dashboard.js";
import { buildDoctorReport } from "./diagnostics.js";
import {
  type ActiveDriveControl,
  type BackgroundDrive,
  cleanupCompletedBoard,
  DriveRuntimeController,
  deliverPendingDecision,
  persistDriveDecision,
} from "./drive-controller.js";
import {
  boardUsage,
  formatBoardProgress,
  formatCostSummary,
  formatUsage,
  STATUS_LABELS,
  taskLine,
  truncateText,
} from "./format.js";
import { notify, runHandoff } from "./handoff.js";
import { exportPlan, importPlan } from "./plan-serialization.js";
import { buildOrchestratorBriefing, buildSupervisorBriefing } from "./prompts.js";
import {
  captureBoardLogs,
  cleanupStaleLogs,
  inspectLogRetention,
  pruneStaleLogs,
  pruneTaskLogs,
} from "./retention.js";
import {
  startExecutor as defaultStartExecutor,
  findSessionFile,
  type RunUpdate,
} from "./runner.js";
import {
  assertKnownTaskIds,
  maestroBoardCwd,
  previousBoardSession,
  sessionCanControlDrive,
  sessionSwitchBlocked,
} from "./session-control.js";
import { showSettings } from "./settings-ui.js";
import { projectStatus } from "./status.js";
import { deriveRunTimeline, formatRunTimeline } from "./timeline.js";

export {
  assertKnownTaskIds,
  maestroBoardCwd,
  previousBoardSession,
  sessionCanControlDrive,
  sessionSwitchBlocked,
} from "./session-control.js";

import { registerMaestroTools } from "./tools.js";
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
  formatDriveSummary,
  lastReport,
  preflightTaskTiers,
  simulatePlan,
  type WorkflowRun,
} from "./workflow.js";
import {
  cleanupManagedWorktrees,
  inspectManagedWorktrees,
  sweepWorktrees,
  worktreeExists,
} from "./worktree.js";

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
  const driveController = new DriveRuntimeController();
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
    const status = projectStatus(board, liveRuns.keys());
    const running = status.running;
    const usage = boardUsage(board.tasks);
    const runningPart = running > 0 ? ` · ${running} running` : "";
    const pausedPart = board.pausedDrive ? " · paused" : "";
    ctx.ui.setStatus(
      COMMAND,
      ctx.ui.theme.fg(
        running > 0 || board.pausedDrive ? "warning" : "muted",
        `⚡ maestro ${status.code} · ${progress}${runningPart}${pausedPart} · $${usage.cost.toFixed(4)}`
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
      const resolution = resolveTierModels(
        "review",
        reviewTier,
        ctx.modelRegistry,
        ctx.model?.provider
      );
      if (!resolution.ok) throw new Error(resolution.error);
      const [primary, ...fallbacks] = resolution.modelArgs;
      if (primary === undefined) delete reviewTier.model;
      else reviewTier.model = primary;
      if (fallbacks.length === 0) delete reviewTier.fallbacks;
      else reviewTier.fallbacks = fallbacks.filter((model): model is string => model !== undefined);
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
      isLive: (taskId) => liveRuns.has(taskId),
      onRetentionWarning: (warning) => notify(ctx, `Log cleanup warning: ${warning}`, "warning"),
    };
    if (taskIds) driveOptions.taskIds = taskIds;
    if (signal) driveOptions.signal = signal;
    if (shouldPause) driveOptions.shouldPause = shouldPause;
    return driveBoard(driveOptions);
  }

  function sendDecision(evidence: string): void {
    pi.sendMessage(
      { customType: MESSAGE_TYPE, content: evidence, display: true },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  }

  function startBackgroundDrive(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    signal?: AbortSignal,
    reportProgress: (message: string) => void = () => {}
  ): BackgroundDrive {
    if (driveController.hasActive()) throw new Error("An autonomous drive is already active.");

    const operation: BackgroundDrive = { promise: Promise.resolve() };
    const ownerSession = ctx.sessionManager.getSessionFile();
    if (ownerSession) operation.ownerSession = ownerSession;
    driveController.setBackground(operation);
    operation.promise = runControlledDrive(ctx, taskIds, signal, reportProgress)
      .then((summary) => {
        operation.summary = summary;
        const message = formatDrivePulse(summary).slice(0, 4000);
        if (summary.stoppedBecause.code === "completed") cleanupCompletedBoard(ctx.cwd);
        persistDriveDecision(ctx.cwd, ownerSession, summary, message);
        deliverPendingDecision(ctx.cwd, ownerSession, sendDecision);
      })
      .catch((error) => {
        operation.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => refreshUI(ctx));
    return driveController.getBackground() ?? operation;
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
    if (driveController.hasActive()) throw new Error("An autonomous drive is already active.");
    const board = loadBoard(ctx.cwd);
    const config = loadConfig(ctx.cwd);
    const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
    if (validationError) throw new Error(validationError);
    assertKnownTaskIds(board, taskIds);
    if (taskIds) {
      const gaps = scopedDependencyGaps(board, taskIds);
      if (gaps.length > 0) {
        throw new Error(
          `Scoped drive omits unresolved dependencies: ${gaps
            .map((gap) => `${gap.taskId} requires ${gap.dependencyId}`)
            .join(", ")}`
        );
      }
    }

    const ownerSession = ctx.sessionManager.getSessionFile();
    const control: ActiveDriveControl = {
      cwd: ctx.cwd,
      pauseRequested: false,
      abortController: new AbortController(),
    };
    if (ownerSession) control.ownerSession = ownerSession;
    if (taskIds) control.taskIds = taskIds;
    driveController.begin(control);
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
      driveController.finish(control);
    }

    if (
      summary.stoppedBecause.code === "paused" ||
      summary.stoppedBecause.code === "provider_blocked" ||
      summary.stoppedBecause.code === "escalation_required"
    ) {
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

  registerMaestroTools({
    pi,
    adoptBoard,
    refreshUI,
    liveRuns,
    driveController,
    startBackgroundDrive,
  });

  function formatDrivePulse(summary: DriveSummary): string {
    const base = formatDriveSummary(summary);
    const code = summary.stoppedBecause.code;
    if (code === "provider_blocked") {
      return `${base}\n\nChoose a recovery: configure another fallback in /maestro config then /maestro resume, or maestro_update the task, or ask the user if the block is a cost/quota decision. Do not blindly retry the same provider.`;
    }
    if (code === "escalation_required") {
      return `${base}\n\nChoose one: maestro_update to raise the tier or rewrite the brief, maestro_plan to split the task, cancel it, or ask the user when scope/cost judgment is required, then /maestro resume. Do not blindly retry or raise maxAttempts.`;
    }
    if (code === "attempt_cap") {
      return `${base}\n\nThe capped predecessor cannot run again because its consumed attempts remain even if its tier or brief changes. Create a narrowly scoped successor with maestro_plan whose title and brief identify the capped task. Keep the capped predecessor visible, then use maestro_update to replace its id in every downstream dependency while preserving unrelated dependencies. Start maestro_drive with an explicit taskIds list containing the successor and every rewired dependent, and excluding the capped predecessor. Do not raise the project maxAttempts to force another retry.`;
    }
    if (code === "blocked") {
      return `${base}\n\nChoose one: maestro_update the brief/tier, maestro_plan to split, cancel the task, or ask the user. Do not raise the project maxAttempts to force another retry.`;
    }
    return base;
  }

  function _getReportPreview(board: Board, taskId: string): string {
    const task = findTask(board, taskId);
    const report = task ? lastReport(task) : undefined;
    if (!report) return "";
    return `\nReport:\n${truncateText(report, REPORT_PREVIEW_LINES)}`;
  }

  registerMaestroCommand(pi, async (args, ctx) => {
    const { subcommand, rest, restParts } = parseCommand(args);

    switch (subcommand) {
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
          const previousRevision = board.revision ?? 0;
          const archivedLogs = captureBoardLogs(ctx.cwd, board);
          for (const warning of archivedLogs.warnings) {
            notify(ctx, `Log cleanup warning: ${warning}`, "warning");
          }
          const archivePath = archiveBoard(ctx.cwd);
          board = { version: 1, nextTaskNumber: 1, tasks: [], goal: rest };
          replaceBoard(ctx.cwd, board, previousRevision);
          if (archivePath) {
            const cleanup = pruneStaleLogs(
              ctx.cwd,
              archivedLogs.entries,
              () => loadBoard(ctx.cwd),
              (id) => liveRuns.has(id),
              archivedLogs.warnings
            );
            if (cleanup.warnings.length > 0) {
              notify(
                ctx,
                `Log cleanup warning: ${cleanup.warnings.join("; ").slice(0, 500)}`,
                "warning"
              );
            }
            notify(ctx, `Previous board archived: ${archivePath}`);
          }
        } else {
          board.goal = rest;
          saveBoard(ctx.cwd, board);
        }
        adoptBoard(ctx);
        refreshUI(ctx);
        nameSessionAfterGoal(ctx, rest, "maestro");
        pi.sendMessage(
          {
            customType: MESSAGE_TYPE,
            content: buildOrchestratorBriefing(rest, describeTiersForPlanning(loadConfig(ctx.cwd))),
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
        if (driveController.hasActive() || liveRuns.size > 0) {
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
        if (!driveController.hasActive()) {
          const paused = loadBoard(ctx.cwd).pausedDrive;
          notify(
            ctx,
            paused ? "Autonomous drive is already paused." : "No autonomous drive is active.",
            "warning"
          );
          return;
        }
        const activeOwner = driveController.activeOwner();
        if (
          activeOwner?.cwd !== ctx.cwd ||
          !sessionCanControlDrive(activeOwner.ownerSession, currentSession)
        ) {
          notify(ctx, "Only the session that started this drive may pause it.", "warning");
          return;
        }
        driveController.requestPause();
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
        if (driveController.hasActive() || liveRuns.size > 0) {
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
        if (driveController.hasActive()) {
          const activeOwner = driveController.activeOwner();
          if (
            activeOwner?.cwd !== ctx.cwd ||
            !sessionCanControlDrive(activeOwner.ownerSession, currentSession)
          ) {
            notify(ctx, "Only the session that started this drive may abort it.", "warning");
            return;
          }
          driveController.abort();
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
      case "plan": {
        const [planAction, planPath] = restParts;
        if (planAction === "export") {
          if (!planPath) {
            notify(ctx, `Usage: /${COMMAND} plan export <file>`, "warning");
            return;
          }
          const file = resolve(ctx.cwd, planPath);
          if (existsSync(file)) {
            notify(ctx, `Refusing to overwrite existing file: ${file}`, "error");
            return;
          }
          writeFileSync(file, exportPlan(loadBoard(ctx.cwd)), { flag: "wx" });
          notify(ctx, `Plan exported to ${file}`);
          return;
        }
        if (planAction === "import") {
          if (!planPath) {
            notify(ctx, `Usage: /${COMMAND} plan import <file>`, "warning");
            return;
          }
          if (liveRuns.size > 0) {
            notify(ctx, "Executors are still running. Import cancelled.", "warning");
            return;
          }
          const config = loadConfig(ctx.cwd);
          let imported: Board;
          try {
            imported = importPlan(
              readFileSync(resolve(ctx.cwd, planPath), "utf-8"),
              Object.keys(config.tiers),
              Object.keys(config.verificationProfiles ?? {})
            );
          } catch (error) {
            notify(ctx, error instanceof Error ? error.message : String(error), "error");
            return;
          }
          const current = loadBoard(ctx.cwd);
          if (current.tasks.length > 0) {
            const confirmed =
              ctx.hasUI &&
              (await ctx.ui.confirm(
                "Replace current plan?",
                `Archive ${current.tasks.length} current task(s), then import ${imported.tasks.length}?`
              ));
            if (!confirmed) {
              notify(ctx, "Plan import cancelled; current board was not changed.", "warning");
              return;
            }
            const archive = archiveBoard(ctx.cwd);
            if (!archive) {
              notify(ctx, "Could not archive the current board; import cancelled.", "error");
              return;
            }
          }
          replaceBoard(ctx.cwd, imported, current.revision ?? 0);
          refreshUI(ctx);
          notify(ctx, `Imported ${imported.tasks.length} task(s); plan approval is required.`);
          return;
        }
        await showPlan(ctx);
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
      case "simulate": {
        const taskIds = rest ? rest.split(/[\s,]+/).filter(Boolean) : undefined;
        const board = loadBoard(ctx.cwd);
        assertKnownTaskIds(board, taskIds);
        const validationError = planValidationMessage(
          validatePlan(board, Object.keys(loadConfig(ctx.cwd).tiers))
        );
        notify(ctx, validationError ?? simulatePlan(board, loadConfig(ctx.cwd), taskIds));
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
      case "reconcile": {
        const warnings: string[] = [];
        for (const task of loadBoard(ctx.cwd).tasks) {
          if (task.approvalKind === "manual") warnings.push(`${task.id}: manually accepted`);
          if (task.status === "approved" && task.approvalKind !== "reviewed") {
            warnings.push(`${task.id}: approved without a reviewed artifact`);
          }
          if (task.approvalKind === "reviewed" && !task.provenance?.candidateTree) {
            warnings.push(`${task.id}: reviewed approval is missing its authoritative Git tree`);
          }
          if (task.approvalKind === "reviewed" && !task.provenance?.reviewedAt) {
            warnings.push(`${task.id}: artifact has no persisted review proof`);
          }
          if (task.approvalKind === "reviewed" && !task.integratedCommit) {
            warnings.push(`${task.id}: reviewed approval is missing its integration commit`);
          }
          if (
            task.verificationProfile &&
            task.approvalKind === "reviewed" &&
            !task.provenance?.verifiedAt
          ) {
            warnings.push(`${task.id}: reviewed artifact is missing trusted verification proof`);
          }
          const attempt = task.attempts.at(-1);
          if (
            attempt?.worktreePath &&
            !worktreeExists({ worktreePath: attempt.worktreePath, branch: attempt.branch ?? "" })
          ) {
            warnings.push(`${task.id}: recorded recovery worktree is missing`);
          }
        }
        notify(
          ctx,
          warnings.length > 0
            ? `Reconciliation warnings:\n- ${warnings.join("\n- ")}`
            : "Board artifacts are consistent."
        );
        return;
      }
      case "doctor": {
        const liveTaskIds = new Set(liveRuns.keys());
        if (restParts[0]?.toLowerCase() !== "cleanup") {
          notify(ctx, buildDoctorReport(ctx.cwd, ctx.modelRegistry, ctx.model, liveTaskIds));
          return;
        }

        const board = loadBoard(ctx.cwd);
        const candidates = inspectManagedWorktrees(ctx.cwd, board, liveTaskIds).filter(
          (entry) => entry.state === "orphaned" || entry.state === "stale"
        );
        const logCandidates = inspectLogRetention(ctx.cwd, board, liveTaskIds).filter(
          (entry) => entry.state === "stale"
        );
        if (candidates.length === 0 && logCandidates.length === 0) {
          notify(ctx, "No stale logs or stale/orphaned managed worktrees to clean.");
          return;
        }

        let confirmed = restParts[1]?.toLowerCase() === "confirm";
        if (ctx.hasUI && !confirmed) {
          const logBytes = logCandidates.reduce((total, entry) => total + entry.size, 0);
          confirmed = await ctx.ui.confirm(
            "Clean stale maestro state?",
            `Remove ${candidates.length} stale/orphaned checkout(s) and ${logCandidates.length} stale log(s) (${Math.ceil(logBytes / 1024)} KB)? Candidates will be rechecked; active and retained state is preserved.`
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
        const logResult = cleanupStaleLogs(
          ctx.cwd,
          new Set(logCandidates.map((entry) => resolve(entry.file))),
          () => loadBoard(ctx.cwd),
          (taskId) => liveRuns.has(taskId)
        );
        const preserved = result.preserved.filter(
          (entry) =>
            entry.state === "active" ||
            entry.state === "recoverable" ||
            entry.state === "retained-conflict"
        ).length;
        const warnings = logResult.warnings.length
          ? ` Warnings: ${logResult.warnings.join("; ").slice(0, 500)}`
          : "";
        notify(
          ctx,
          `Removed ${result.removed.length} stale/orphaned worktree(s) and ${logResult.removed.length} stale log(s). Preserved ${preserved + logResult.preserved.length} active or retained item(s).${warnings}`
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
        await runHandoff({
          ctx,
          briefing: buildSupervisorBriefing(
            board.goal,
            board.tasks,
            describeTiersForPlanning(loadConfig(ctx.cwd))
          ),
          goal: board.goal ?? "maestro run",
          adoptBoard,
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
        const count = Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : 20;
        const lines = history
          .slice(-count)
          .map((entry) => `${entry.ts} ${entry.taskId} ${entry.from} → ${entry.to}`);
        notify(ctx, lines.join("\n"));
        return;
      }
      case "timeline": {
        const [first, archiveName, archivedTaskId] = restParts;
        const archived = first?.toLowerCase() === "archive";
        let board: Board;
        let taskId: string | undefined;
        try {
          board = archived ? loadArchivedBoard(ctx.cwd, archiveName ?? "") : loadBoard(ctx.cwd);
          taskId = archived ? archivedTaskId : first;
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
          return;
        }
        if (taskId && !findTask(board, taskId)) {
          notify(ctx, `Unknown task: ${taskId}`, "warning");
          return;
        }
        notify(ctx, formatRunTimeline(deriveRunTimeline(board, taskId)));
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
          const archivedLogs = captureBoardLogs(ctx.cwd, loadBoard(ctx.cwd));
          for (const warning of archivedLogs.warnings) {
            notify(ctx, `Log cleanup warning: ${warning}`, "warning");
          }
          const restored = restoreArchivedBoard(ctx.cwd, selectedFile);
          if (restored.archivedCurrent) {
            const cleanup = pruneStaleLogs(
              ctx.cwd,
              archivedLogs.entries,
              () => loadBoard(ctx.cwd),
              (id) => liveRuns.has(id),
              archivedLogs.warnings
            );
            if (cleanup.warnings.length > 0) {
              notify(
                ctx,
                `Log cleanup warning: ${cleanup.warnings.join("; ").slice(0, 500)}`,
                "warning"
              );
            }
          }
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
        const archivedLogs = captureBoardLogs(ctx.cwd, board);
        for (const warning of archivedLogs.warnings) {
          notify(ctx, `Log cleanup warning: ${warning}`, "warning");
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
        replaceBoard(ctx.cwd, { version: 1, nextTaskNumber: 1, tasks: [] }, board.revision ?? 0); // also drops goal
        const cleanup = pruneStaleLogs(
          ctx.cwd,
          archivedLogs.entries,
          () => loadBoard(ctx.cwd),
          (id) => liveRuns.has(id),
          archivedLogs.warnings
        );
        if (cleanup.warnings.length > 0) {
          notify(
            ctx,
            `Log cleanup warning: ${cleanup.warnings.join("; ").slice(0, 500)}`,
            "warning"
          );
        }
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
            `/${COMMAND} simulate [ids] preview deterministic dependency waves without running work`,
            `/${COMMAND} doctor         diagnose config, models, authentication, git, and managed worktrees`,
            `/${COMMAND} doctor cleanup remove rechecked stale/orphaned worktrees after confirmation`,
            `/${COMMAND} history [n]    show recent task status changes (default 20)`,
            `/${COMMAND} timeline [id]  show derived run/task evidence chronologically`,
            `/${COMMAND} timeline archive <file> [id]  show archived evidence`,
            `/${COMMAND} plan export <file>  export a versioned plan without run evidence`,
            `/${COMMAND} plan import <file>  validate, archive current work, and import`,
            `/${COMMAND} replay [file]  restore an archived board (picker when omitted)`,
            `/${COMMAND} reset          archive and clear the board`,
          ].join("\n")
        );
    }
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
            if (status === "approved") {
              const cleanup = pruneTaskLogs(
                ctx.cwd,
                taskId,
                () => loadBoard(ctx.cwd),
                (id) => liveRuns.has(id)
              );
              for (const warning of cleanup.warnings) {
                notify(ctx, `Log cleanup warning: ${warning}`, "warning");
              }
            }
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
    if (selection.action === "retry") {
      try {
        const operation = startBackgroundDrive(ctx, [selection.taskId], undefined, (message) =>
          notify(ctx, message)
        );
        void operation.promise.then(() => {
          if (operation.summary) {
            notify(
              ctx,
              formatDriveSummary(operation.summary),
              operation.summary.stoppedBecause.code === "completed" ? "info" : "warning"
            );
          } else if (operation.error) {
            notify(ctx, operation.error, "error");
          }
        });
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return;
    }
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
        notify(ctx, "Plan approved. Executors may now be started with maestro_drive.");
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
        {
          value: "criteria",
          label: `Success criteria · ${draft.successCriteria?.length ?? 0}`,
          description: (draft.successCriteria ?? []).join(" · "),
        },
        {
          value: "verification",
          label: `Verification · ${draft.verificationProfile ?? "none"}`,
        },
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
      if (action === "criteria") {
        const value = await editPlanText(
          ctx,
          "Success criteria (one per line)",
          (draft.successCriteria ?? []).join("\n"),
          true
        );
        if (value !== null) {
          try {
            applyPlanTaskEdits(
              draft,
              {
                successCriteria: value
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean),
              },
              tiers
            );
          } catch (error) {
            notify(ctx, error instanceof Error ? error.message : String(error), "error");
          }
        }
        continue;
      }
      if (action === "verification") {
        const config = loadConfig(ctx.cwd);
        const profile = await pickFromList(ctx, "Verification profile", [
          { value: "", label: "None" },
          ...Object.keys(config.verificationProfiles ?? {}).map((name) => ({
            value: name,
            label: name,
          })),
        ]);
        if (profile !== undefined && profile !== null) {
          applyPlanTaskEdits(draft, { verificationProfile: profile }, tiers);
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
          ...(draft.writePaths ? { writePaths: draft.writePaths } : {}),
          ...(draft.successCriteria ? { successCriteria: draft.successCriteria } : {}),
          verificationProfile: draft.verificationProfile ?? "",
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
            ...(draft.writePaths ? { writePaths: draft.writePaths } : {}),
            ...(draft.successCriteria ? { successCriteria: draft.successCriteria } : {}),
            verificationProfile: draft.verificationProfile ?? "",
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
        if (status === "approved") {
          fresh.approvalKind = "manual";
          fresh.verificationSummary = "accepted manually from the dashboard";
        }
      });
      if (status === "approved") {
        const cleanup = pruneTaskLogs(
          ctx.cwd,
          task.id,
          () => loadBoard(ctx.cwd),
          (id) => liveRuns.has(id)
        );
        for (const warning of cleanup.warnings) {
          notify(ctx, `Log cleanup warning: ${warning}`, "warning");
        }
      }
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
    if (sessionSwitchBlocked(driveController.hasActive(), liveRuns.size)) {
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
      const config = loadConfig(ctx.cwd);
      const threshold = (config.handoffContextRatio ?? CONTEXT_NUDGE_PERCENT / 100) * 100;
      if (!usage || usage.percent === null || threshold <= 0 || usage.percent < threshold) return;

      const board = loadBoard(ctx.cwd);
      if (board.tasks.length === 0 || !sessionOwnsBoard(ctx, board)) return;
      if (driveController.hasActive() || liveRuns.size > 0) {
        if (ctx.hasUI)
          ctx.ui.notify("Maestro handoff pending until live work reaches a safe boundary.");
        return;
      }

      contextNudgeShown = true;
      pi.sendUserMessage(`/${COMMAND} handoff`, { deliverAs: "followUp" });
    } catch {
      // The turn may belong to a context invalidated by a session switch.
    }
  });

  pi.on("session_before_switch", (_event, ctx) => {
    if (!sessionSwitchBlocked(driveController.hasActive(), liveRuns.size)) return;
    notify(
      ctx,
      `Session switch blocked while maestro work is active. Use /${COMMAND} pause and wait, or /${COMMAND} abort.`,
      "warning"
    );
    return { cancel: true };
  });

  pi.on("session_before_fork", (_event, ctx) => {
    if (!sessionSwitchBlocked(driveController.hasActive(), liveRuns.size)) return;
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
    const boardCwd = maestroBoardCwd(ctx.cwd);
    const navigationBoard = loadBoard(boardCwd);
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

    // Recovery is lease-aware: live owners survive extension reloads and only
    // expired claims are reclaimed with their attempt in one board transaction.
    const recoveryNotes = sweepDispatchState(boardCwd);
    for (const note of recoveryNotes) notify(ctx, note, "warning");
    const recovered = loadBoard(boardCwd);
    deliverPendingDecision(boardCwd, ctx.sessionManager.getSessionFile(), sendDecision);
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
      sweepWorktrees(boardCwd, retained, knownWorktrees);
    } catch (error) {
      notify(ctx, `Could not clean stale maestro worktrees: ${String(error)}`, "warning");
    }
    refreshUI(ctx);
  });

  // The before-switch/fork guards normally keep active work in this runtime.
  // Shutdown still aborts as a final safety net so a forced reload or exit can never orphan it.
  pi.on("session_shutdown", () => {
    driveController.shutdown();
    for (const run of liveRuns.values()) {
      run.handle.abort();
    }
    liveRuns.clear();
  });
}
