import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  type EditorTheme,
  Input,
  Key,
  Markdown,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import {
  artifactFindings,
  captureApprovedProvenance,
  completionFreshness,
  pathsOutsideWriteScope,
} from "./artifact-policy.js";
import {
  applyPlanTaskEdits,
  approvePlan,
  archiveBoard,
  assertTaskNotDispatched,
  consumeQuarantineNotice,
  findTask,
  forceStatus,
  humanRetryEligibility,
  humanRetryRiskToken,
  latestArchiveFile,
  listArchivedBoards,
  loadArchivedBoard,
  loadBoard,
  loadStatusHistory,
  planValidationMessage,
  rejectPlan,
  replaceBoard,
  replaceBoardWithArchive,
  restoreArchivedBoard,
  restoreQuarantineNotice,
  saveBoard,
  scopedDependencyGapsWithConfig,
  sweepDispatchState,
  updateBoard,
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
import {
  Dashboard,
  type DashboardTaskAction,
  type LivePaneLaunch,
  LivePaneComponent,
} from "./dashboard.js";
import { buildDoctorReport } from "./diagnostics.js";
import {
  buildDiscoveryBoard,
  completedDiscoveryReport,
  formatDiscoveryPreview,
  parseDiscoveryOutput,
} from "./discovery.js";
import {
  type ActiveDriveControl,
  acknowledgeDeliveredDecision,
  type BackgroundDrive,
  cleanupCompletedBoard,
  DriveRuntimeController,
  deliverPendingDecision,
  persistActiveDrive,
  persistDriveDecision,
} from "./drive-controller.js";
import {
  boardUsage,
  formatBoardProgress,
  formatCostSummary,
  formatStatusHistory,
  formatUsage,
  STATUS_LABELS,
  taskLine,
  truncateText,
} from "./format.js";
import { notify, runHandoff } from "./handoff.js";
import {
  comparePlans,
  exportPlan,
  formatPlanComparison,
  importPlan,
} from "./plan-serialization.js";
import { formatWorkflowPreflight, preflightWorkflow } from "./preflight.js";
import { buildOrchestratorBriefing, buildSupervisorBriefing } from "./prompts.js";
import {
  expandRecipe,
  loadRecipeListings,
  parseRecipeInput,
  removeRecipe,
  resolveRecipe,
  saveRecipeFromBoard,
} from "./recipes.js";
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
  canonicalTaskIds,
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
  type MaestroConfig,
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
  snapshot,
  type WorkflowRun,
} from "./workflow.js";
import {
  cleanupManagedWorktrees,
  inspectGit,
  inspectManagedWorktrees,
  snapshotArtifact,
  sweepWorktrees,
  worktreeExists,
} from "./worktree.js";

export interface MaestroDependencies {
  startExecutor: typeof defaultStartExecutor;
}

interface LivePaneRuntime {
  handle?: OverlayHandle;
  component?: LivePaneComponent;
  done?: () => void;
  isResponsiveVisible?: () => boolean;
  closing: boolean;
}

interface PlanPaneRuntime {
  done?: () => void;
  closing: boolean;
}

export function scrollableTextOffset(
  offset: number,
  delta: number,
  lineCount: number,
  pageSize = 18
): number {
  return Math.max(0, Math.min(Math.max(0, lineCount - pageSize), offset + delta));
}

const livePaneResponsiveVisibility = (width: number): boolean => width >= 100;

/** Shared read-only plan projection for modal and beside-editor presentations. */
export function formatPlanOverview(board: Board, config: MaestroConfig): string[] {
  const tasks = board.tasks.filter((task) => task.status !== "cancelled");
  const preflight = preflightWorkflow(board, config);
  const tierCounts = Object.entries(
    tasks.reduce<Record<string, number>>((counts, task) => {
      counts[task.tier] = (counts[task.tier] ?? 0) + 1;
      return counts;
    }, {})
  )
    .map(([tier, count]) => `${tier}:${count}`)
    .join(", ");
  const lines = [
    `${tasks.length} task(s) · tiers: ${tierCounts || "none"}`,
    ...formatWorkflowPreflight(preflight).split("\n"),
    "",
  ];
  for (const task of tasks) {
    const briefLines = task.brief.split("\n");
    lines.push(
      `${task.id} ${task.title} [${task.tier}]  (deps: ${task.dependsOn.join(", ") || "none"})`,
      `  brief: ${briefLines.slice(0, 3).join(" ")}${briefLines.length > 3 ? ` … (+${briefLines.length - 3} more lines)` : ""}`,
      `  criteria: ${(task.successCriteria ?? []).map((criterion, index) => `${index + 1}. ${criterion}`).join(" ") || "none"}`,
      `  writes: ${task.writePaths?.join(", ") || "none"}`,
      `  verification: ${task.verificationProfile ?? "none"} · review: ${task.reviewPolicy ?? "single"} · commit: ${task.commitMessage ?? "auto"}`,
      ""
    );
  }
  return lines;
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
  let runtimeActive = true;
  let contextNudgeShown = false;
  let activeCwd = process.cwd();
  /** Session we switched away from when opening an executor session (for /maestro back). */
  let previousSession: string | undefined;
  let hiddenLivePaneDriveId: string | undefined;
  let livePane: LivePaneRuntime | undefined;
  let planPane: PlanPaneRuntime | undefined;

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
    updateBoard(ctx.cwd, (board) => {
      if (board.ownerSessions?.includes(current)) return false;
      board.ownerSessions = [...(board.ownerSessions ?? []), current];
      return true;
    });
  }

  function labelCurrentEntry(ctx: ExtensionContext, label: string): void {
    const entryId = ctx.sessionManager.getLeafId();
    if (entryId) pi.setLabel(entryId, label);
  }

  function notifyQuarantine(ctx: ExtensionContext): void {
    const quarantined = consumeQuarantineNotice();
    if (!quarantined) return;
    try {
      notify(
        ctx,
        `Board was corrupt and quarantined to ${quarantined}. Restore an archive with /maestro replay.`,
        "warning"
      );
    } catch {
      // ctx went stale mid-command (e.g. a session-switching subcommand);
      // re-stash the notice so the next live ctx can surface it.
      restoreQuarantineNotice(quarantined);
    }
  }

  function currentDriveId(): string | undefined {
    return driveController.activeOwner()?.id;
  }

  function livePaneLaunches(ctx: ExtensionContext): LivePaneLaunch[] {
    const board = loadBoard(ctx.cwd);
    return [...liveRuns.values()].map((run) => {
      const task = findTask(board, run.taskId);
      const attempt = run.handle.attempt;
      return {
        key: `${run.kind}:${run.taskId}:${attempt.startedAt}:${attempt.logFile}`,
        taskId: run.taskId,
        title: task?.title ?? run.taskId,
        kind: run.kind,
        logFile: attempt.logFile,
        ...(attempt.sessionFile ? { sessionFile: attempt.sessionFile } : {}),
        ...(attempt.model ? { model: attempt.model } : {}),
        ...(attempt.provider ? { provider: attempt.provider } : {}),
        turns: run.turns,
        cost: run.cost,
        lastActivity: run.lastActivity,
      };
    });
  }

  function watchedLiveRunCount(): number {
    return liveRuns.size;
  }

  function canShowLivePane(ctx: ExtensionContext): boolean {
    if (ctx.mode !== "tui" || !loadConfig(ctx.cwd).livePanes) return false;
    const activeDrive = driveController.activeOwner();
    if (!activeDrive) return false;
    return sessionCanControlDrive(activeDrive.ownerSession, ctx.sessionManager.getSessionFile());
  }

  function livePaneIsVisible(width: number): boolean {
    const pane = livePane;
    if (!pane?.handle || pane.closing || pane.handle.isHidden()) return false;
    return livePaneResponsiveVisibility(width);
  }

  function closeLivePane(): void {
    const pane = livePane;
    if (!pane || pane.closing || !pane.done) return;
    pane.closing = true;
    pane.done();
  }

  function openLivePane(ctx: ExtensionContext): void {
    if (livePane || watchedLiveRunCount() === 0 || !canShowLivePane(ctx)) return;

    const pane: LivePaneRuntime = { closing: false };
    livePane = pane;
    let completion: Promise<void>;
    try {
      completion = ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          pane.done = () => done(undefined);
          pane.isResponsiveVisible = () => livePaneResponsiveVisibility(tui.terminal.columns);
          pane.component = new LivePaneComponent(theme, {
            getLaunches: () => livePaneLaunches(ctx),
            getHeight: () => Math.max(1, Math.floor(tui.terminal.rows * 0.8)),
            requestRender: () => tui.requestRender(),
            tui,
            cwd: ctx.cwd,
            onEscape: () => {
              pane.handle?.unfocus();
              refreshUI(ctx);
            },
            onCycleVisibility: () => cycleLivePane(ctx),
            onSteer: (launch, message) => {
              liveRuns.get(launch.taskId)?.handle.steer(message);
            },
            onFollowUp: (launch, message) => {
              liveRuns.get(launch.taskId)?.handle.followUp(message);
            },
          });
          return pane.component;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "right-center",
            width: "45%",
            maxHeight: "80%",
            visible: livePaneResponsiveVisibility,
          },
          onHandle: (handle) => {
            pane.handle = handle;
            if (!runtimeActive || watchedLiveRunCount() === 0 || !canShowLivePane(ctx)) {
              closeLivePane();
              return;
            }
            handle.unfocus();
            refreshUI(ctx);
          },
        }
      );
    } catch {
      pane.component?.dispose();
      if (livePane === pane) livePane = undefined;
      return;
    }

    const finish = () => {
      if (livePane !== pane) return;
      livePane = undefined;
      if (!runtimeActive || watchedLiveRunCount() === 0 || !canShowLivePane(ctx)) return;
      syncLivePane(ctx);
      refreshUI(ctx);
    };
    void completion.then(finish, finish);
  }

  function syncLivePane(ctx: ExtensionContext): void {
    if (watchedLiveRunCount() === 0 || !canShowLivePane(ctx)) {
      closeLivePane();
      return;
    }
    if (livePane) return;
    if (hiddenLivePaneDriveId === currentDriveId()) return;
    openLivePane(ctx);
  }

  function cycleLivePane(ctx: ExtensionContext): void {
    if (watchedLiveRunCount() === 0 || !canShowLivePane(ctx)) return;
    const pane = livePane;
    if (!pane) {
      if (hiddenLivePaneDriveId === currentDriveId()) hiddenLivePaneDriveId = undefined;
      openLivePane(ctx);
      return;
    }
    if (pane.closing || !pane.handle || !pane.isResponsiveVisible?.()) return;
    if (!pane.handle.isFocused()) {
      pane.handle.focus();
      return;
    }

    hiddenLivePaneDriveId = currentDriveId();
    closeLivePane();
    refreshUI(ctx);
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
    notifyQuarantine(ctx);
    syncLivePane(ctx);
    if (!board.planPending) closePlanPane();

    // Sessions that never touched this board (fresh /maestro-less chats in
    // the same repo) don't get its status bar. Live runs always show:
    // this process owns them regardless of which session spawned them.
    const showBoard = sessionOwnsBoard(ctx, board) || liveRuns.size > 0;
    if (board.tasks.length === 0 || !showBoard) {
      ctx.ui.setStatus(COMMAND, undefined);
      ctx.ui.setWidget(COMMAND, undefined);
      ctx.ui.setWorkingMessage();
      return;
    }

    const progress = formatBoardProgress(board.tasks);
    const status = projectStatus(board, liveRuns.keys(), loadConfig(ctx.cwd));
    const running = status.running;
    const usage = boardUsage(board.tasks);
    const runningPart = running > 0 ? ` · ${running} running` : "";
    const reviewPart = status.reviewable > 0 ? ` · ${status.reviewable} review` : "";
    const blockedPart = status.blocked > 0 ? ` · ${status.blocked} blocked` : "";
    const pausedPart = board.pausedDrive ? " · paused" : "";
    const planPart = board.planPending ? " · plan awaiting approval" : "";
    ctx.ui.setStatus(
      COMMAND,
      ctx.ui.theme.fg(
        running > 0 || board.pausedDrive ? "warning" : "muted",
        `⚡ maestro ${status.code} · ${progress}${runningPart}${reviewPart}${blockedPart}${pausedPart}${planPart} · $${usage.cost.toFixed(4)}`
      )
    );

    if (running === 0) {
      ctx.ui.setWidget(COMMAND, undefined);
      ctx.ui.setWorkingMessage();
      return;
    }
    ctx.ui.setWorkingMessage(`maestro · ${running} executor(s) · $${usage.cost.toFixed(2)}`);
    ctx.ui.setWidget(COMMAND, (tui, theme) => {
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
      return {
        render: () => (livePaneIsVisible(tui.terminal.columns) ? [] : lines),
        invalidate: () => {},
      };
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
    if (runtimeActive) refreshUI(ctx);
    onProgress();
  }

  function trackRun(ctx: ExtensionContext, run: WorkflowRun): () => void {
    if (hiddenLivePaneDriveId !== currentDriveId()) hiddenLivePaneDriveId = undefined;
    liveRuns.set(run.taskId, run);
    if (runtimeActive) refreshUI(ctx);
    // The workflow persists the running state immediately after registration.
    // Refresh again once that synchronous mutation has completed.
    queueMicrotask(() => {
      if (runtimeActive) refreshUI(ctx);
    });
    return () => {
      liveRuns.delete(run.taskId);
      if (runtimeActive) refreshUI(ctx);
    };
  }

  function manuallyApproveTask(ctx: ExtensionContext, taskId: string): Task {
    const initialBoard = loadBoard(ctx.cwd);
    const initialTask = findTask(initialBoard, taskId);
    if (!initialTask) throw new Error(`Unknown task id: ${taskId}`);
    assertTaskNotDispatched(initialTask);
    if (initialTask.status !== "ready_for_review") {
      throw new Error("Manual approval requires a task that is ready for review.");
    }
    const attempt = initialTask.attempts.at(-1);
    if (!attempt?.finalReport?.trim() || attempt.endedAt === undefined) {
      throw new Error("Manual approval requires a completed attempt with a final report.");
    }
    const findings = artifactFindings(initialTask, attempt);
    if (findings && findings.length > 0) {
      throw new Error(`Manual approval refused: ${findings[0]?.message ?? "artifact is unsafe"}`);
    }
    const candidateTree =
      (initialTask.writePaths?.length ?? 0) > 0
        ? (() => {
            if (attempt.touchedFiles.length === 0) {
              throw new Error("Manual approval requires nonempty attributable Git changes.");
            }
            const outsideScope = pathsOutsideWriteScope(initialTask, attempt);
            if (outsideScope.length > 0) {
              throw new Error(
                `Manual approval refused changes outside write scope: ${outsideScope.join(", ")}`
              );
            }
            const artifact = snapshotArtifact(
              attempt.worktreePath ?? ctx.cwd,
              attempt.touchedFiles
            );
            if (!artifact) throw new Error("Manual approval requires a scoped Git artifact.");
            return artifact;
          })()
        : undefined;
    const attemptIdentity = `${attempt.index}:${attempt.logFile}:${attempt.startedAt}`;

    return updateBoard(ctx.cwd, (board) => {
      const task = findTask(board, taskId);
      const freshAttempt = task?.attempts.at(-1);
      if (
        !task ||
        task.updatedAt !== initialTask.updatedAt ||
        !freshAttempt ||
        `${freshAttempt.index}:${freshAttempt.logFile}:${freshAttempt.startedAt}` !==
          attemptIdentity
      ) {
        throw new Error("Manual approval became stale while inspecting Git; retry it.");
      }
      assertTaskNotDispatched(task);
      if (candidateTree) task.provenance = { candidateTree, capturedAt: Date.now() };
      const proof = captureApprovedProvenance(board, task, loadConfig(ctx.cwd));
      if (!proof)
        throw new Error("Manual approval requires an authoritative artifact or final report.");
      forceStatus(task, "approved");
      task.approvalKind = "manual";
      task.verificationSummary = "accepted manually with versioned artifact proof";
      task.approvedProvenance = proof;
      return task;
    });
  }

  async function runDriveWorkflow(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    signal: AbortSignal | undefined,
    reportProgress: (message: string) => void,
    shouldPause?: () => boolean,
    humanRetryTaskId?: string,
    humanRetryExpectedRiskToken?: string,
    humanRetryOwnerSession?: string
  ): Promise<DriveSummary> {
    const config = loadConfig(ctx.cwd);
    const board = loadBoard(ctx.cwd);
    const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
    if (validationError) throw new Error(validationError);
    assertKnownTaskIds(board, taskIds);
    const workflowPreflight = preflightWorkflow(board, config, taskIds);
    if (
      workflowPreflight.requiresConfirmation &&
      board.scaleApproval?.signature !== workflowPreflight.signature
    ) {
      throw new Error(`Workflow scale confirmation is required (${workflowPreflight.signature}).`);
    }
    adoptBoard(ctx);

    const selected = taskIds
      ? taskIds.map((id) => findTask(board, id)).filter((task): task is Task => task !== undefined)
      : board.tasks;
    const unresolved = selected.filter(
      (task) => task.status !== "approved" || task.id === humanRetryTaskId
    );
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
    if (humanRetryTaskId) driveOptions.humanRetryTaskId = humanRetryTaskId;
    if (humanRetryExpectedRiskToken)
      driveOptions.humanRetryExpectedRiskToken = humanRetryExpectedRiskToken;
    if (humanRetryOwnerSession) driveOptions.humanRetryOwnerSession = humanRetryOwnerSession;
    return driveBoard(driveOptions);
  }

  function sendDecision(evidence: string, decisionId: string): void {
    if (!runtimeActive) throw new Error("Maestro session runtime is no longer active.");
    pi.sendMessage(
      { customType: MESSAGE_TYPE, content: evidence, display: true, details: { decisionId } },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  }

  function validateDriveStart(ctx: ExtensionContext, taskIds: string[] | undefined): void {
    const board = loadBoard(ctx.cwd);
    const config = loadConfig(ctx.cwd);
    const validationError = planValidationMessage(validatePlan(board, Object.keys(config.tiers)));
    if (validationError) throw new Error(validationError);
    assertKnownTaskIds(board, taskIds);
    if (board.planPending) throw new Error("Plan approval is pending.");
    const preflight = preflightWorkflow(board, config, taskIds);
    if (preflight.requiresConfirmation && board.scaleApproval?.signature !== preflight.signature) {
      throw new Error(
        `Workflow scale confirmation is required (${preflight.signature}); use the human /${COMMAND} drive command to inspect and confirm preflight.`
      );
    }
    if (!taskIds) return;

    const gaps = scopedDependencyGapsWithConfig(board, taskIds, config);
    if (gaps.length > 0) {
      throw new Error(
        `Scoped drive omits unresolved dependencies: ${gaps
          .map((gap) => `${gap.taskId} requires ${gap.dependencyId}`)
          .join(", ")}`
      );
    }
  }

  async function confirmDriveScale(
    ctx: ExtensionContext,
    taskIds: string[] | undefined
  ): Promise<boolean> {
    const board = loadBoard(ctx.cwd);
    const config = loadConfig(ctx.cwd);
    const preflight = preflightWorkflow(board, config, taskIds);
    if (!preflight.requiresConfirmation || board.scaleApproval?.signature === preflight.signature) {
      return true;
    }
    notify(ctx, formatWorkflowPreflight(preflight), "warning");
    if (!ctx.hasUI) return false;
    const confirmed = await ctx.ui.confirm(
      "Confirm workflow scale?",
      `${preflight.taskCount} tasks and up to ${preflight.totalLaunchUpperBound} raw launches (${preflight.signature}).`
    );
    if (!confirmed) return false;
    updateBoard(ctx.cwd, (fresh) => {
      const current = preflightWorkflow(fresh, loadConfig(ctx.cwd), taskIds);
      if (current.signature !== preflight.signature) {
        throw new Error("Workflow changed after preflight; inspect and confirm it again.");
      }
      fresh.scaleApproval = { signature: current.signature, confirmedAt: Date.now() };
    });
    return true;
  }

  function startBackgroundDrive(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    signal?: AbortSignal,
    reportProgress: (message: string) => void = () => {},
    humanRetryTaskId?: string,
    humanRetryExpectedRiskToken?: string
  ): BackgroundDrive {
    if (driveController.hasActive()) throw new Error("An autonomous drive is already active.");
    validateDriveStart(ctx, taskIds);

    const operation: BackgroundDrive = { promise: Promise.resolve() };
    const ownerSession = ctx.sessionManager.getSessionFile();
    if (ownerSession) operation.ownerSession = ownerSession;
    const driveId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const control: ActiveDriveControl = {
      id: driveId,
      cwd: ctx.cwd,
      pauseRequested: false,
      abortController: new AbortController(),
    };
    if (ownerSession) control.ownerSession = ownerSession;
    if (taskIds) control.taskIds = taskIds;

    const reserved = persistActiveDrive(ctx.cwd, {
      id: driveId,
      ...(ownerSession ? { ownerSession } : {}),
      ...(taskIds ? { taskIds } : {}),
      startedAt: Date.now(),
    });
    if (!reserved) {
      throw new Error("Another session already owns an active or paused drive.");
    }
    try {
      driveController.begin(control);
    } catch (error) {
      const summary = unexpectedDriveSummary(ctx.cwd, taskIds, error);
      persistDriveDecision(ctx.cwd, ownerSession, summary, formatDrivePulse(summary), driveId);
      throw error;
    }
    driveController.setBackground(operation);
    const statusRefresh = setInterval(() => {
      if (runtimeActive) refreshUI(ctx);
    }, 1_000);
    statusRefresh.unref();
    operation.promise = runControlledDrive(
      ctx,
      control,
      signal,
      reportProgress,
      humanRetryTaskId,
      humanRetryExpectedRiskToken,
      ownerSession
    )
      .then((summary) => {
        operation.summary = summary;
        const message = formatDrivePulse(summary).slice(0, 4000);
        const persisted = persistDriveDecision(ctx.cwd, ownerSession, summary, message, driveId);
        if (persisted && summary.stoppedBecause.code === "completed") {
          cleanupCompletedBoard(ctx.cwd);
          try {
            const archive = listArchivedBoards(ctx.cwd)[0];
            if (archive && loadBoard(ctx.cwd).tasks.length === 0) {
              notify(
                ctx,
                `Run complete — board archived to ${basename(archive.file)}. /maestro replay to revisit, /maestro start <goal> for a new run.`
              );
            }
          } catch {
            // The completion decision is durable; stale session UI must not turn it into an error.
          }
        }
        if (persisted && runtimeActive) {
          deliverPendingDecision(ctx.cwd, ownerSession, sendDecision);
        }
      })
      .catch((error) => {
        operation.error = error instanceof Error ? error.message : String(error);
        try {
          const summary = unexpectedDriveSummary(ctx.cwd, taskIds, operation.error);
          const persisted = persistDriveDecision(
            ctx.cwd,
            ownerSession,
            summary,
            formatDrivePulse(summary),
            driveId
          );
          if (persisted && runtimeActive) {
            deliverPendingDecision(ctx.cwd, ownerSession, sendDecision);
          }
        } catch (persistenceError) {
          operation.error = `${operation.error}; could not persist internal error: ${String(persistenceError)}`;
        }
      })
      .finally(() => {
        driveController.finish(control);
        clearInterval(statusRefresh);
        if (runtimeActive) refreshUI(ctx);
      });
    return driveController.getBackground() ?? operation;
  }

  function savePausedDrive(cwd: string, pausedDrive: PausedDriveState | undefined): void {
    updateBoard(cwd, (board) => {
      if (pausedDrive) board.pausedDrive = pausedDrive;
      else delete board.pausedDrive;
      return true;
    });
  }

  async function runControlledDrive(
    ctx: ExtensionContext,
    control: ActiveDriveControl,
    signal: AbortSignal | undefined,
    reportProgress: (message: string) => void,
    humanRetryTaskId?: string,
    humanRetryExpectedRiskToken?: string,
    humanRetryOwnerSession?: string
  ): Promise<DriveSummary> {
    const taskIds = control.taskIds;

    const combinedSignal = signal
      ? AbortSignal.any([signal, control.abortController.signal])
      : control.abortController.signal;
    const summary = await runDriveWorkflow(
      ctx,
      taskIds,
      combinedSignal,
      reportProgress,
      () => control.pauseRequested,
      humanRetryTaskId,
      humanRetryExpectedRiskToken,
      humanRetryOwnerSession
    );

    if (
      summary.stoppedBecause.code === "paused" ||
      summary.stoppedBecause.code === "provider_blocked" ||
      summary.stoppedBecause.code === "escalation_required"
    ) {
      const paused: PausedDriveState = {};
      if (taskIds) paused.taskIds = taskIds;
      if (control.ownerSession) paused.ownerSession = control.ownerSession;
      savePausedDrive(ctx.cwd, paused);
    }
    return summary;
  }

  function unexpectedDriveSummary(
    cwd: string,
    taskIds: string[] | undefined,
    error: unknown
  ): DriveSummary {
    const board = loadBoard(cwd);
    const selected = board.tasks.filter((task) => !taskIds || taskIds.includes(task.id));
    return {
      rounds: 0,
      tasks: selected.map((task) => snapshot(task)),
      stoppedBecause: {
        code: "error",
        message: `Drive stopped with an internal error: ${error instanceof Error ? error.message : String(error)}`,
        taskIds: selected.map((task) => task.id),
      },
    };
  }

  function sessionContainsDecision(ctx: ExtensionContext, decisionId: string): boolean {
    const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
      getEntries?: () => unknown[];
    };
    if (typeof sessionManager.getEntries !== "function") return false;
    return sessionManager.getEntries().some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as unknown as Record<string, unknown>;
      const details = record.details;
      if (
        details &&
        typeof details === "object" &&
        (details as Record<string, unknown>).decisionId === decisionId
      ) {
        return true;
      }
      const message = record.message;
      if (!message || typeof message !== "object") return false;
      const messageDetails = (message as Record<string, unknown>).details;
      return (
        !!messageDetails &&
        typeof messageDetails === "object" &&
        (messageDetails as Record<string, unknown>).decisionId === decisionId
      );
    });
  }

  function launchCommandDrive(ctx: ExtensionCommandContext, taskIds: string[] | undefined): void {
    const operation = startBackgroundDrive(ctx, taskIds, undefined, (message) =>
      notify(ctx, message)
    );
    void operation.promise.then(() => {
      if (!runtimeActive) return;
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

  async function requestHumanRetry(ctx: ExtensionContext, requestedTaskId: string): Promise<void> {
    if (driveController.hasActive() || liveRuns.size > 0) {
      notify(
        ctx,
        "Retry not started: an autonomous drive or executor is already running.",
        "warning"
      );
      return;
    }
    const previewBoard = loadBoard(ctx.cwd);
    const task = findTask(previewBoard, requestedTaskId);
    const ownerSession = ctx.sessionManager.getSessionFile();
    const eligibility = humanRetryEligibility(previewBoard, requestedTaskId, {
      maxAttempts: loadConfig(ctx.cwd).maxAttempts,
      config: loadConfig(ctx.cwd),
      isLive: (id) => liveRuns.has(id),
      ...(ownerSession ? { ownerSession } : {}),
    });
    if (!eligibility.eligible || !task) {
      notify(ctx, `Retry not started: ${eligibility.message}`, "warning");
      return;
    }

    const riskEvidence = humanRetryRiskToken(task);
    if (eligibility.requiresConfirmation) {
      if (!ctx.hasUI) {
        notify(ctx, `Retry not started: ${eligibility.message}`, "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Retry accepted or integrated work?",
        `${task.id} will run in a fresh isolated worktree. Existing attempts and recovery evidence will be preserved.`
      );
      if (!confirmed) {
        notify(ctx, "Retry cancelled; accepted work was not changed.", "warning");
        return;
      }
      const currentBoard = loadBoard(ctx.cwd);
      const currentTask = findTask(currentBoard, task.id);
      const currentEligibility = humanRetryEligibility(currentBoard, task.id, {
        maxAttempts: loadConfig(ctx.cwd).maxAttempts,
        config: loadConfig(ctx.cwd),
        isLive: (id) => liveRuns.has(id),
        ...(ownerSession ? { ownerSession } : {}),
      });
      if (
        !currentTask ||
        !currentEligibility.eligible ||
        humanRetryRiskToken(currentTask) !== riskEvidence
      ) {
        notify(
          ctx,
          "Retry not started: task acceptance or integration evidence changed during confirmation.",
          "warning"
        );
        return;
      }
    }
    if (!(await confirmDriveScale(ctx, [task.id]))) {
      notify(ctx, "Retry not started: workflow scale was not confirmed.", "warning");
      return;
    }
    const confirmedTask = findTask(loadBoard(ctx.cwd), task.id);
    if (!confirmedTask || humanRetryRiskToken(confirmedTask) !== riskEvidence) {
      notify(
        ctx,
        "Retry not started: task acceptance or integration evidence changed; confirm it again.",
        "warning"
      );
      return;
    }

    notify(ctx, `Retrying ${task.id} in isolated recovery mode…`);
    const operation = startBackgroundDrive(
      ctx,
      [task.id],
      undefined,
      (message) => notify(ctx, message),
      task.id,
      riskEvidence
    );
    void operation.promise.then(() => {
      if (!runtimeActive) return;
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
    if (code === "no_progress") {
      return `${summary.stoppedBecause.message}\n\n${base}`;
    }
    if (code === "provider_blocked") {
      return `${base}\n\nChoose a recovery: configure another fallback in /maestro config then /maestro resume, or maestro_update the task, or ask the user if the block is a cost/quota decision. Do not blindly retry the same provider.`;
    }
    if (code === "escalation_required") {
      return `${base}\n\nChoose one: maestro_update to raise the tier or rewrite the brief, maestro_plan to split the task, cancel it, or ask the user when scope/cost judgment is required, then /maestro resume. Do not blindly retry or raise maxAttempts.`;
    }
    if (code === "review_disagreement") {
      return `${base}\n\nResolve the disagreement deliberately: use maestro_update to change the task reviewPolicy, or split/cancel the task after inspecting both retained reviewer reports. Then start maestro_drive for the corrected scope.`;
    }
    if (code === "reviewer_failure") {
      return `${base}\n\nInspect the retained reviewer launch and artifact/verification evidence, correct the operational cause, then start maestro_drive for the affected task. Operational failures do not count as reviewer rejection or disagreement.`;
    }
    if (code === "attempt_cap") {
      return `${base}\n\nThe capped predecessor cannot run again because its consumed attempts remain. Create a narrowly scoped successor with maestro_plan and set supersedesTaskId to the capped task. Maestro atomically preserves the predecessor as cancelled and rewires downstream dependencies. Then start maestro_drive for the successor and rewired dependents. Do not perform cancellation/rewiring as separate calls or raise maxAttempts.`;
    }
    if (code === "stale_completion") {
      return `${base}\n\nThe approved proof is stale or legacy and cannot satisfy dependencies. Use the human Retry control for an isolated rerun, or create a scoped successor when the old work must remain retained. Inspect the fingerprint reason before changing the contract or configuration.`;
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

  const COMPLETION_CACHE_MS = 2_000;
  let boardCompletionCache: { cwd: string; expiresAt: number; board: Board } | undefined;
  let recipeCompletionCache:
    | { cwd: string; expiresAt: number; recipes: ReturnType<typeof loadRecipeListings> }
    | undefined;

  function completionBoard(): Board {
    const now = Date.now();
    if (
      !boardCompletionCache ||
      boardCompletionCache.cwd !== activeCwd ||
      boardCompletionCache.expiresAt <= now
    ) {
      boardCompletionCache = {
        cwd: activeCwd,
        expiresAt: now + COMPLETION_CACHE_MS,
        board: loadBoard(activeCwd),
      };
    }
    return boardCompletionCache.board;
  }

  function completionRecipes(): ReturnType<typeof loadRecipeListings> {
    const now = Date.now();
    if (
      !recipeCompletionCache ||
      recipeCompletionCache.cwd !== activeCwd ||
      recipeCompletionCache.expiresAt <= now
    ) {
      recipeCompletionCache = {
        cwd: activeCwd,
        expiresAt: now + COMPLETION_CACHE_MS,
        recipes: loadRecipeListings(activeCwd),
      };
    }
    return recipeCompletionCache.recipes;
  }

  registerMaestroCommand(
    pi,
    async (args, ctx) => {
      activeCwd = ctx.cwd;
      const { subcommand, rest, restParts } = parseCommand(args);

      try {
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
            const config = loadConfig(ctx.cwd);
            const git = inspectGit(ctx.cwd);
            if (!git.ok && (config.autoCommit || config.useWorktrees)) {
              notify(
                ctx,
                `Git repo not ready: ${git.summary}. Commits will fail — run /maestro doctor, or disable autoCommit/useWorktrees in /maestro config.`,
                "warning"
              );
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
                content: buildOrchestratorBriefing(
                  rest,
                  describeTiersForPlanning(loadConfig(ctx.cwd)),
                  loadConfig(ctx.cwd).planGate
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
            if (driveController.hasActive() || liveRuns.size > 0) {
              notify(ctx, "An autonomous drive or executor batch is already running.", "warning");
              return;
            }
            const requestedTaskIds = rest ? rest.split(/[\s,]+/).filter(Boolean) : undefined;
            let taskIds: string[] | undefined;
            try {
              taskIds = canonicalTaskIds(loadBoard(ctx.cwd), requestedTaskIds);
              if (loadBoard(ctx.cwd).planPending) throw new Error("Plan approval is pending.");
              if (!(await confirmDriveScale(ctx, taskIds))) {
                notify(ctx, "Drive not started: workflow scale was not confirmed.", "warning");
                return;
              }
              validateDriveStart(ctx, taskIds);
            } catch (error) {
              notify(ctx, `Drive not started: ${String(error)}`, "warning");
              return;
            }
            notify(ctx, `Driving ${taskIds?.join(", ") ?? "the whole board"}…`);
            launchCommandDrive(ctx, taskIds);
            return;
          }
          case "retry": {
            if (!rest || restParts.length !== 1) {
              notify(ctx, `Usage: /${COMMAND} retry <taskId>`, "warning");
              return;
            }
            await requestHumanRetry(ctx, rest);
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
            let taskIds: string[] | undefined;
            try {
              taskIds = canonicalTaskIds(board, paused.taskIds);
              if (board.planPending) throw new Error("Plan approval is pending.");
              if (!(await confirmDriveScale(ctx, taskIds))) {
                notify(ctx, "Drive not resumed: workflow scale was not confirmed.", "warning");
                return;
              }
              validateDriveStart(ctx, taskIds);
            } catch (error) {
              notify(ctx, `Drive not resumed: ${String(error)}`, "warning");
              return;
            }
            notify(ctx, `Resuming ${taskIds?.join(", ") ?? "the whole board"}…`);
            launchCommandDrive(ctx, taskIds);
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
            const [planAction, planPath, planTaskId] = restParts;
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
                  Object.keys(config.verificationProfiles ?? {}),
                  config.maxPlanTasks
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
            if (planAction === "diff") {
              if (!planPath) {
                notify(ctx, `Usage: /${COMMAND} plan diff <file> [taskId]`, "warning");
                return;
              }
              const config = loadConfig(ctx.cwd);
              try {
                const candidate = importPlan(
                  readFileSync(resolve(ctx.cwd, planPath), "utf-8"),
                  Object.keys(config.tiers),
                  Object.keys(config.verificationProfiles ?? {}),
                  config.maxPlanTasks
                );
                const comparison = comparePlans(loadBoard(ctx.cwd), candidate, config);
                notify(
                  ctx,
                  formatPlanComparison(comparison, `/${COMMAND} plan diff ${planPath}`, planTaskId)
                );
              } catch (error) {
                notify(ctx, error instanceof Error ? error.message : String(error), "error");
              }
              return;
            }
            await showPlan(ctx);
            return;
          }
          case "recipe": {
            const match = rest.match(/^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/);
            const action = match?.[1]?.toLowerCase() ?? "list";
            const name = match?.[2];
            const trailing = match?.[3];

            try {
              if (action === "list") {
                const recipes = loadRecipeListings(ctx.cwd);
                notify(
                  ctx,
                  recipes.length === 0
                    ? "No workflow recipes found."
                    : recipes
                        .map((entry) =>
                          entry.error
                            ? `${entry.name} [${entry.scope}] — INVALID ${entry.file}: ${truncateText(entry.error, 300)}`
                            : `${entry.name} [${entry.scope}] — ${entry.recipe?.description ?? `${entry.recipe?.tasks.length ?? 0} task(s)`}`
                        )
                        .join("\n")
                );
                return;
              }
              if (action === "inspect") {
                if (!name) {
                  notify(ctx, `Usage: /${COMMAND} recipe inspect <name>`, "warning");
                  return;
                }
                const resolved = resolveRecipe(ctx.cwd, name);
                notify(
                  ctx,
                  `[${resolved.scope}] ${resolved.file}\n${JSON.stringify(resolved.recipe, null, 2)}`
                );
                return;
              }
              if (action === "preview") {
                if (!name) {
                  notify(ctx, `Usage: /${COMMAND} recipe preview <name> [JSON input]`, "warning");
                  return;
                }
                const resolved = resolveRecipe(ctx.cwd, name);
                const config = loadConfig(ctx.cwd);
                const expanded = expandRecipe(
                  resolved.recipe,
                  parseRecipeInput(trailing),
                  Object.keys(config.tiers),
                  Object.keys(config.verificationProfiles ?? {}),
                  config.maxPlanTasks
                );
                notify(
                  ctx,
                  formatPlanComparison(
                    comparePlans(loadBoard(ctx.cwd), expanded, config),
                    `/${COMMAND} recipe preview ${name}`,
                    undefined,
                    4_000,
                    `/${COMMAND} recipe inspect ${name}`
                  )
                );
                return;
              }
              if (action === "save") {
                if (!name) {
                  notify(ctx, `Usage: /${COMMAND} recipe save <name> [user|project]`, "warning");
                  return;
                }
                const scope = trailing?.toLowerCase() ?? "user";
                if (scope !== "user" && scope !== "project") {
                  notify(ctx, "Recipe scope must be user or project.", "warning");
                  return;
                }
                const file = saveRecipeFromBoard(scope, ctx.cwd, name, loadBoard(ctx.cwd));
                notify(ctx, `Saved ${scope} recipe "${name}" to ${file}.`);
                return;
              }
              if (action === "run") {
                if (!name) {
                  notify(ctx, `Usage: /${COMMAND} recipe run <name> [JSON input]`, "warning");
                  return;
                }
                if (liveRuns.size > 0) {
                  notify(ctx, "Executors are still running. Recipe run cancelled.", "warning");
                  return;
                }
                const resolved = resolveRecipe(ctx.cwd, name);
                const config = loadConfig(ctx.cwd);
                const expanded = expandRecipe(
                  resolved.recipe,
                  parseRecipeInput(trailing),
                  Object.keys(config.tiers),
                  Object.keys(config.verificationProfiles ?? {}),
                  config.maxPlanTasks
                );
                const current = loadBoard(ctx.cwd);
                if (current.tasks.length > 0) {
                  const confirmed =
                    ctx.hasUI &&
                    (await ctx.ui.confirm(
                      "Run workflow recipe?",
                      `Archive ${current.tasks.length} current task(s), then run "${name}"?`
                    ));
                  if (!confirmed) {
                    notify(ctx, "Recipe run cancelled; current board was not changed.", "warning");
                    return;
                  }
                }
                const archive = replaceBoardWithArchive(ctx.cwd, () => structuredClone(expanded));
                refreshUI(ctx);
                notify(
                  ctx,
                  `Expanded recipe "${name}" into ${expanded.tasks.length} task(s); plan approval is required.${archive ? ` Previous board archived at ${archive}.` : ""}`
                );
                return;
              }
              if (action === "remove") {
                if (!name) {
                  notify(ctx, `Usage: /${COMMAND} recipe remove <name> [user|project]`, "warning");
                  return;
                }
                const requestedScope = trailing?.toLowerCase();
                if (
                  requestedScope !== undefined &&
                  requestedScope !== "user" &&
                  requestedScope !== "project"
                ) {
                  notify(ctx, "Recipe scope must be user or project.", "warning");
                  return;
                }
                const scope =
                  requestedScope ??
                  loadRecipeListings(ctx.cwd).find((entry) => entry.name === name)?.scope;
                if (!scope) {
                  notify(ctx, `${name} was not found.`, "warning");
                  return;
                }
                const confirmed =
                  ctx.hasUI &&
                  (await ctx.ui.confirm(
                    "Remove workflow recipe?",
                    `Permanently remove ${scope} recipe "${name}"?`
                  ));
                if (!confirmed) {
                  notify(ctx, "Recipe removal cancelled.", "warning");
                  return;
                }
                if (!removeRecipe(scope, ctx.cwd, name)) {
                  notify(ctx, `${scope} recipe "${name}" was not found.`, "warning");
                  return;
                }
                notify(ctx, `Removed ${scope} recipe "${name}".`);
                return;
              }
              notify(ctx, `Unknown recipe action: ${action}`, "warning");
            } catch (error) {
              notify(ctx, error instanceof Error ? error.message : String(error), "error");
            }
            return;
          }
          case "board":
          case "dash":
          case "dashboard":
            await showDashboard(ctx);
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
          case "discover": {
            const [taskId, requestedMode, ...extra] = restParts;
            const mode = requestedMode ?? "append";
            if (!taskId || extra.length > 0 || (mode !== "append" && mode !== "replace")) {
              notify(ctx, `Usage: /${COMMAND} discover <taskId> [append|replace]`, "warning");
              return;
            }

            try {
              const previewBoard = loadBoard(ctx.cwd);
              const previewRevision = previewBoard.revision ?? 0;
              const discoveryTask = findTask(previewBoard, taskId);
              if (liveRuns.has(discoveryTask?.id ?? taskId)) {
                throw new Error(`${taskId} discovery output is still live; wait for completion.`);
              }
              const report = completedDiscoveryReport(discoveryTask);
              const config = loadConfig(ctx.cwd);
              const output = parseDiscoveryOutput(report, config.maxDiscoveryGeneratedTasks);
              buildDiscoveryBoard(previewBoard, taskId, report, mode, config);
              notify(ctx, formatDiscoveryPreview(output, mode));

              const confirmed =
                ctx.hasUI &&
                (await ctx.ui.confirm(
                  "Apply discovery tasks?",
                  `${mode === "replace" ? "Replace the current board with" : "Append"} ${output.items.length} generated task(s)?`
                ));
              if (!confirmed) {
                notify(
                  ctx,
                  "Discovery tasks were not approved; the board was not changed.",
                  "warning"
                );
                return;
              }

              let archive: string | undefined;
              if (mode === "append") {
                updateBoard(ctx.cwd, (board) => {
                  if ((board.revision ?? 0) !== previewRevision) {
                    throw new Error(
                      "The board changed after preview; inspect and approve discovery again."
                    );
                  }
                  const freshReport = completedDiscoveryReport(findTask(board, taskId));
                  if (freshReport !== report) {
                    throw new Error(
                      "Discovery result changed after preview; inspect and approve it again."
                    );
                  }
                  const candidate = buildDiscoveryBoard(
                    board,
                    taskId,
                    report,
                    mode,
                    loadConfig(ctx.cwd)
                  );
                  board.nextTaskNumber = candidate.nextTaskNumber;
                  board.tasks = candidate.tasks;
                  board.planPending = true;
                  return true;
                });
              } else {
                archive = replaceBoardWithArchive(ctx.cwd, (board) => {
                  if ((board.revision ?? 0) !== previewRevision) {
                    throw new Error(
                      "The board changed after preview; inspect and approve discovery again."
                    );
                  }
                  const freshReport = completedDiscoveryReport(findTask(board, taskId));
                  if (freshReport !== report) {
                    throw new Error(
                      "Discovery result changed after preview; inspect and approve it again."
                    );
                  }
                  return buildDiscoveryBoard(board, taskId, report, mode, loadConfig(ctx.cwd));
                });
              }
              refreshUI(ctx);
              notify(
                ctx,
                `Approved ${output.items.length} discovery task(s); plan approval is required.${archive ? ` Previous board archived at ${archive}.` : ""}`
              );
            } catch (error) {
              notify(ctx, error instanceof Error ? error.message : String(error), "error");
            }
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
            const board = loadBoard(ctx.cwd);
            const config = loadConfig(ctx.cwd);
            const decision = board.activeDecision;
            if (decision && !decision.resolution) {
              const matching = decision.taskIds.some((id) => {
                const task = board.tasks.find((candidate) => candidate.id === id);
                return decision.kind === "reviewer_failure"
                  ? task?.status === "failed" || task?.status === "changes_requested"
                  : task?.dispatchClaim !== undefined;
              });
              if (!matching) {
                warnings.push(
                  `${decision.id}: unresolved ${decision.kind} decision has no matching task or live dispatch state`
                );
              }
            }
            for (const task of board.tasks) {
              if (task.status === "approved") {
                const freshness = completionFreshness(board, task, config);
                if (freshness.state !== "fresh") {
                  warnings.push(`${task.id}: ${freshness.state} completion — ${freshness.reason}`);
                }
              }
              if (task.approvalKind === "manual") warnings.push(`${task.id}: manually accepted`);
              if (task.status === "approved" && task.approvalKind !== "reviewed") {
                warnings.push(`${task.id}: approved without a reviewed artifact`);
              }
              if (task.approvalKind === "reviewed" && !task.provenance?.candidateTree) {
                warnings.push(
                  `${task.id}: reviewed approval is missing its authoritative Git tree`
                );
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
                warnings.push(
                  `${task.id}: reviewed artifact is missing trusted verification proof`
                );
              }
              const attempt = task.attempts.at(-1);
              if (
                attempt?.worktreePath &&
                !worktreeExists({
                  worktreePath: attempt.worktreePath,
                  branch: attempt.branch ?? "",
                })
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
            const count =
              Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : 20;
            notify(ctx, formatStatusHistory(history.entries, history.skipped, count));
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
            replaceBoard(
              ctx.cwd,
              { version: 1, nextTaskNumber: 1, tasks: [] },
              board.revision ?? 0
            ); // also drops goal
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
                ...(subcommand ? [`Unknown subcommand "${subcommand}". Available commands:`] : []),
                "start/plan/drive",
                `/${COMMAND} start <goal>   plan + delegate a goal with the orchestrator`,
                `/${COMMAND} handoff        continue run/review in a fresh session (drops planning context)`,
                `/${COMMAND} drive [ids]    autonomously run, review, and retry tasks`,
                `/${COMMAND} retry <taskId> retry failed work with isolated human-controlled safety`,
                `/${COMMAND} pause          stop the drive after active executors finish`,
                `/${COMMAND} resume         continue a paused drive from fresh board state`,
                `/${COMMAND} abort          abort a drive and its active executors`,
                `/${COMMAND} plan           review, approve, or reject a gated plan`,
                "",
                "observe",
                `/${COMMAND} board          full-screen live dashboard (steer/abort/inspect executors)`,
                `/${COMMAND} open <taskId>  switch into an executor session`,
                `/${COMMAND} back           switch back to the previous session`,
                "",
                "scripting",
                `/${COMMAND} config         interactive settings editor (add "project" for repo scope, "show" to print)`,
                `/${COMMAND} costs          show attempts, total/average cost, models, and providers`,
                `/${COMMAND} simulate [ids] preview deterministic dependency waves without running work`,
                `/${COMMAND} plan export <file>  export a versioned plan without run evidence`,
                `/${COMMAND} plan import <file>  validate, archive current work, and import`,
                `/${COMMAND} plan diff <file> [taskId]  inspect plan changes without mutation`,
                `/${COMMAND} recipe list|inspect|preview|save|run|remove  manage declarative recipes`,
                "",
                "recover",
                `/${COMMAND} discover <taskId> [append|replace]  preview and approve generated tasks`,
                `/${COMMAND} doctor         diagnose config, models, authentication, git, and managed worktrees`,
                `/${COMMAND} doctor cleanup remove rechecked stale/orphaned worktrees after confirmation`,
                `/${COMMAND} history [n]    show recent task status changes (default 20)`,
                `/${COMMAND} timeline [id]  show derived run/task evidence chronologically`,
                `/${COMMAND} timeline archive <file> [id]  show archived evidence`,
                `/${COMMAND} reconcile      report artifact/provenance inconsistencies without mutation`,
                `/${COMMAND} replay [file]  restore an archived board (picker when omitted)`,
                `/${COMMAND} reset          archive and clear the board`,
              ].join("\n")
            );
        }
      } finally {
        notifyQuarantine(ctx);
      }
    },
    (prefix) => {
      const normalized = prefix.toLowerCase();
      const taskCommand = ["retry", "open", "drive", "discover", "timeline"].find((command) =>
        normalized.startsWith(`${command} `)
      );
      if (taskCommand) {
        const trailingSeparator = /[\s,]$/.test(prefix);
        const parts = prefix.split(/[\s,]+/).filter((part) => part.length > 0);
        const query = trailingSeparator ? "" : (parts.at(-1)?.toLowerCase() ?? "");
        const idParts = trailingSeparator ? parts.slice(1) : parts.slice(1, -1);
        const precedingIds = taskCommand === "drive" ? idParts : [];
        const precedingIdsLower = new Set(precedingIds.map((id) => id.toLowerCase()));
        return completionBoard()
          .tasks.filter(
            (task) =>
              task.id.toLowerCase().startsWith(query) &&
              !precedingIdsLower.has(task.id.toLowerCase())
          )
          .map((task) => ({
            value: `${taskCommand} ${[...precedingIds, task.id].join(" ")}`,
            label: task.id,
            description: task.title,
          }));
      }
      const recipeMatch = prefix.match(/^recipe\s+(run|inspect|preview|remove)\s+(.*)$/i);
      if (!recipeMatch) return [];
      const action = recipeMatch[1]?.toLowerCase();
      const query = recipeMatch[2]?.toLowerCase() ?? "";
      return completionRecipes()
        .filter((recipe) => recipe.name.toLowerCase().startsWith(query))
        .map((recipe) => ({
          value: `recipe ${action} ${recipe.name}`,
          label: recipe.name,
          description: recipe.scope,
        }));
    }
  );

  pi.registerShortcut("ctrl+alt+b", {
    description: "Open the maestro dashboard",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await showDashboard(ctx);
    },
  });

  pi.registerShortcut("ctrl+alt+w", {
    description: "Cycle the maestro live pane",
    handler: (ctx) => cycleLivePane(ctx),
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
    const selection = await ctx.ui.custom<{ taskId: string; action: DashboardTaskAction } | null>(
      (tui, theme, _keybindings, done) => {
        const dashboard = new Dashboard(
          theme,
          {
            getBoard: () => loadBoard(ctx.cwd),
            getConfig: () => loadConfig(ctx.cwd),
            isLive: (taskId) => liveRuns.has(taskId),
            liveKind: (taskId) => liveRuns.get(taskId)?.kind,
            getLiveRun: (taskId) => {
              const live = liveRuns.get(taskId);
              if (!live) return undefined;
              return {
                cost: live.cost,
                turns: live.turns,
                lastActivity: live.lastActivity,
              };
            },
            liveActivity: (taskId) => {
              const live = liveRuns.get(taskId);
              if (!live) return undefined;
              const label = live.kind === "review" ? "reviewing" : "running";
              return `${label} · ${live.turns} turns · ${live.lastActivity}`;
            },
            steer: (taskId, message) => {
              liveRuns.get(taskId)?.handle.steer(message);
            },
            followUp: (taskId, message) => {
              liveRuns.get(taskId)?.handle.followUp(message);
            },
            abort: (taskId) => {
              liveRuns.get(taskId)?.handle.abort();
            },
            setTaskStatus: (taskId, status) => {
              try {
                if (status === "approved") manuallyApproveTask(ctx, taskId);
                else {
                  updateTask(ctx.cwd, taskId, (fresh) => {
                    assertTaskNotDispatched(fresh);
                    forceStatus(fresh, status);
                  });
                }
              } catch (error) {
                notify(ctx, error instanceof Error ? error.message : String(error), "warning");
                return;
              }
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
              return (
                isCommandContext(ctx) && task?.attempts.at(-1)?.reviewSessionFile !== undefined
              );
            },
            retryEligibility: (taskId) =>
              humanRetryEligibility(loadBoard(ctx.cwd), taskId, {
                maxAttempts: loadConfig(ctx.cwd).maxAttempts,
                config: loadConfig(ctx.cwd),
                isLive: (id) => liveRuns.has(id),
                ...(ctx.sessionManager.getSessionFile()
                  ? { ownerSession: ctx.sessionManager.getSessionFile() }
                  : {}),
              }),
            selectTaskAction: (taskId, action) => done({ taskId, action }),
            close: () => done(null),
            requestRender: () => tui.requestRender(),
            getLatestArchive: () => {
              const archive = latestArchiveFile(ctx.cwd);
              if (!archive) return undefined;
              return { name: basename(archive.file), at: Date.parse(archive.timestamp) };
            },
            getStatusHistory: () => loadStatusHistory(ctx.cwd) ?? undefined,
          },
          {
            getRows: () => tui.terminal.rows,
          }
        );
        return {
          render: (width: number) => dashboard.render(width),
          invalidate: () => dashboard.invalidate(),
          handleInput: (data: string) => dashboard.handleInput(data),
          dispose: () => dashboard.dispose(),
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "100%",
          maxHeight: "100%",
        },
      }
    );

    if (!selection) return;
    if (selection.action === "retry") {
      await requestHumanRetry(ctx, selection.taskId);
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

  async function showScrollableText(
    ctx: ExtensionCommandContext,
    title: string,
    lines: string[]
  ): Promise<void> {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      let offset = 0;
      const heading = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
      return {
        render: (width: number) => {
          const content = new Text(lines.slice(offset, offset + 18).join("\n"), 1, 0);
          return [
            ...heading.render(width),
            ...content.render(width),
            "",
            theme.fg("dim", "↑↓/PgUp/PgDn scroll · enter/esc close"),
          ];
        },
        invalidate: () => heading.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
            done();
            return;
          }
          if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) {
            offset = scrollableTextOffset(offset, -10, lines.length);
          }
          if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
            offset = scrollableTextOffset(offset, 10, lines.length);
          }
          tui.requestRender();
        },
      };
    });
  }

  function closePlanPane(): void {
    const pane = planPane;
    if (!pane || pane.closing || !pane.done) return;
    pane.closing = true;
    pane.done();
  }

  function openPlanPane(ctx: ExtensionCommandContext, board: Board): void {
    if (planPane || ctx.mode !== "tui") return;
    const lines = formatPlanOverview(board, loadConfig(ctx.cwd));
    const pane: PlanPaneRuntime = { closing: false };
    planPane = pane;
    let completion: Promise<void>;
    try {
      completion = ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) => {
          pane.done = () => done(undefined);
          const heading = new Text(theme.fg("accent", theme.bold("Maestro Plan · review")), 1, 0);
          const content = new Text(lines.join("\n"), 1, 0);
          const footer = new Text(
            theme.fg("dim", "Read-only · keep typing in the editor · /maestro plan to close"),
            1,
            0
          );
          return {
            render: (width: number) => [
              ...heading.render(width),
              ...content.render(width),
              ...footer.render(width),
            ],
            invalidate: () => {
              heading.invalidate();
              content.invalidate();
              footer.invalidate();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "right-center",
            width: "45%",
            maxHeight: "80%",
            visible: livePaneResponsiveVisibility,
          },
          onHandle: (handle) => {
            if (!loadBoard(ctx.cwd).planPending) {
              closePlanPane();
              return;
            }
            handle.unfocus();
          },
        }
      );
    } catch {
      if (planPane === pane) planPane = undefined;
      return;
    }

    const finish = () => {
      if (planPane === pane) planPane = undefined;
    };
    void completion.then(finish, finish);
  }

  async function showPlanOverview(ctx: ExtensionCommandContext, board: Board): Promise<void> {
    await showScrollableText(
      ctx,
      "Maestro Plan · review",
      formatPlanOverview(board, loadConfig(ctx.cwd))
    );
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
        closePlanPane();
        notify(ctx, "Board is empty. Plan tasks with maestro_plan.", "warning");
        return;
      }
      if (!board.planPending) {
        closePlanPane();
        notify(ctx, "No plan is awaiting approval.");
        return;
      }

      const editable = board.tasks.filter(
        (task) => task.status === "todo" || task.status === "cancelled"
      );
      const items: SelectItem[] = [
        {
          value: "overview",
          label: "Review plan …",
          description: "Read-only overview of every task",
        },
        ...editable.map((task) => ({
          value: `task:${task.id}`,
          label: `${task.id} ${task.title} [${task.tier}]${task.status === "cancelled" ? " · CANCELLED" : ""}`,
          description: `deps: ${task.dependsOn.join(", ") || "none"} · ${task.successCriteria?.length ?? 0} criteria · writes: ${task.writePaths?.join(", ") || "none"} · ${truncateText(task.brief, 1)}`,
        })),
      ];
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
        },
        {
          value: "beside_editor",
          label: planPane ? "Close review beside editor" : "Review beside editor",
          description: "Read-only plan overview that leaves the editor focused",
        }
      );

      const choice = await pickFromList(ctx, "Maestro Plan · awaiting approval", items);
      if (!choice) return;
      if (choice === "overview") {
        await showPlanOverview(ctx, board);
        continue;
      }
      if (choice === "beside_editor") {
        if (planPane) closePlanPane();
        else openPlanPane(ctx, board);
        return;
      }
      if (choice.startsWith("task:")) {
        await editPlanTask(ctx, choice.slice("task:".length));
        continue;
      }
      if (choice === "approve") {
        const fresh = loadBoard(ctx.cwd);
        const config = loadConfig(ctx.cwd);
        const validationError = planValidationMessage(
          validatePlan(fresh, Object.keys(config.tiers))
        );
        if (validationError) {
          notify(ctx, `${validationError}\nEdit the listed tasks before approving.`, "error");
          continue;
        }
        const preflight = preflightWorkflow(fresh, config);
        notify(
          ctx,
          formatWorkflowPreflight(preflight),
          preflight.requiresConfirmation ? "warning" : "info"
        );
        if (preflight.requiresConfirmation) {
          const confirmed =
            ctx.hasUI &&
            (await ctx.ui.confirm(
              "Confirm workflow scale?",
              `${preflight.taskCount} tasks and up to ${preflight.totalLaunchUpperBound} raw launches (${preflight.signature}).`
            ));
          if (!confirmed) {
            notify(ctx, "Plan remains gated; workflow scale was not confirmed.", "warning");
            continue;
          }
        }
        try {
          updateBoard(ctx.cwd, (current) => {
            const currentConfig = loadConfig(ctx.cwd);
            const currentValidationError = planValidationMessage(
              validatePlan(current, Object.keys(currentConfig.tiers))
            );
            if (currentValidationError) throw new Error(currentValidationError);
            const currentPreflight = preflightWorkflow(current, currentConfig);
            if (
              preflight.requiresConfirmation &&
              currentPreflight.signature !== preflight.signature
            ) {
              throw new Error("Workflow changed after preflight confirmation.");
            }
            if (!preflight.requiresConfirmation && currentPreflight.requiresConfirmation) {
              throw new Error("Workflow now requires explicit scale confirmation.");
            }
            if (currentPreflight.requiresConfirmation) {
              current.scaleApproval = {
                signature: currentPreflight.signature,
                confirmedAt: Date.now(),
              };
            }
            approvePlan(current, Object.keys(currentConfig.tiers));
          });
        } catch (error) {
          notify(
            ctx,
            `${error instanceof Error ? error.message : String(error)} Inspect and confirm the plan again; it remains gated.`,
            "warning"
          );
          return;
        }
        closePlanPane();
        refreshUI(ctx);
        notify(ctx, "Plan approved. Executors may now be started with maestro_drive.");
        labelCurrentEntry(ctx, "maestro: plan approved");
        return;
      }

      if (!ctx.hasUI) {
        notify(ctx, "Plan rejection requires the interactive UI.", "warning");
        continue;
      }
      const ok = await ctx.ui.confirm(
        "Reject plan?",
        `Archive and clear all ${board.tasks.length} task(s)?`
      );
      if (!ok) continue;
      const archivePath = rejectPlan(ctx.cwd);
      if (!archivePath) {
        notify(ctx, "Could not archive the board; rejection cancelled.", "error");
        return;
      }
      closePlanPane();
      refreshUI(ctx);
      notify(ctx, `Plan rejected. Board archived at ${archivePath}`);
      return;
    }
  }

  async function editPlanTask(ctx: ExtensionCommandContext, taskId: string): Promise<void> {
    const task = findTask(loadBoard(ctx.cwd), taskId);
    if (!task) return;
    try {
      assertTaskNotDispatched(task);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "warning");
      return;
    }
    const draft = structuredClone(task);
    const tiers = Object.keys(loadConfig(ctx.cwd).tiers);

    while (true) {
      const action = await pickFromList(ctx, `${draft.id} · edit planned task`, [
        { value: "viewBrief", label: "View brief (read-only)" },
        { value: "title", label: `Title · ${draft.title}` },
        { value: "brief", label: `Edit brief · ${truncateText(draft.brief, 3)}` },
        { value: "tier", label: `Tier · ${draft.tier}` },
        {
          value: "dependencies",
          label: `Dependencies · ${draft.dependsOn.join(", ") || "none"}`,
          description: "Comma- or space-separated task ids",
        },
        {
          value: "criteria",
          label: `Success criteria · ${draft.successCriteria?.length ?? 0}`,
          description: (draft.successCriteria ?? []).join(" · "),
        },
        {
          value: "writePaths",
          label: `Write scope · ${draft.writePaths?.length ?? 0} path(s)`,
          description: (draft.writePaths ?? []).join(" · "),
        },
        { value: "commitMessage", label: `Commit message · ${draft.commitMessage ?? "auto"}` },
        { value: "verification", label: `Verification · ${draft.verificationProfile ?? "none"}` },
        { value: "reviewPolicy", label: `Review policy · ${draft.reviewPolicy ?? "single"}` },
        {
          value: "cancellation",
          label: `Cancellation · ${draft.status === "cancelled" ? "cancelled" : "active"}`,
        },
        { value: "save", label: "Save changes", description: "Validate and update the board" },
        { value: "cancel", label: "Cancel editing", description: "Discard all draft changes" },
      ]);
      if (!action || action === "cancel") return;

      if (action === "viewBrief") {
        await showScrollableText(ctx, `${draft.id} · brief`, draft.brief.split("\n"));
        continue;
      }
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
      if (action === "writePaths") {
        const value = await editPlanText(
          ctx,
          "Write scope (one path per line)",
          (draft.writePaths ?? []).join("\n"),
          true
        );
        if (value !== null)
          applyPlanTaskEdits(
            draft,
            {
              writePaths: value
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean),
            },
            tiers
          );
        continue;
      }
      if (action === "commitMessage") {
        const value = await editPlanText(ctx, "Commit message", draft.commitMessage ?? "", false);
        if (value !== null) applyPlanTaskEdits(draft, { commitMessage: value }, tiers);
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
      if (action === "reviewPolicy") {
        const reviewPolicy = await pickFromList(ctx, "Review policy", [
          { value: "single", label: "Single reviewer" },
          { value: "confirm", label: "Independent confirmations" },
          { value: "find-and-refute", label: "Find and refute" },
        ]);
        if (reviewPolicy) {
          applyPlanTaskEdits(
            draft,
            { reviewPolicy: reviewPolicy as "single" | "confirm" | "find-and-refute" },
            tiers
          );
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
          ...(draft.writePaths !== undefined ? { writePaths: draft.writePaths } : {}),
          commitMessage: draft.commitMessage ?? "",
          ...(draft.successCriteria ? { successCriteria: draft.successCriteria } : {}),
          verificationProfile: draft.verificationProfile ?? "",
          reviewPolicy: draft.reviewPolicy ?? "single",
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
      try {
        updateTask(ctx.cwd, draft.id, (fresh) => {
          assertTaskNotDispatched(fresh);
          applyPlanTaskEdits(
            fresh,
            {
              title: draft.title,
              brief: draft.brief,
              tier: draft.tier,
              dependsOn: draft.dependsOn,
              ...(draft.writePaths !== undefined ? { writePaths: draft.writePaths } : {}),
              commitMessage: draft.commitMessage ?? "",
              ...(draft.successCriteria ? { successCriteria: draft.successCriteria } : {}),
              verificationProfile: draft.verificationProfile ?? "",
              reviewPolicy: draft.reviewPolicy ?? "single",
              cancelled: draft.status === "cancelled",
            },
            tiers
          );
        });
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "warning");
        return;
      }
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
    const retry = humanRetryEligibility(board, task.id, {
      maxAttempts: loadConfig(ctx.cwd).maxAttempts,
      config: loadConfig(ctx.cwd),
      isLive: (id) => liveRuns.has(id),
      ...(ctx.sessionManager.getSessionFile()
        ? { ownerSession: ctx.sessionManager.getSessionFile() }
        : {}),
    });
    if (retry.eligible) {
      actions.push({ value: "retry", label: "Retry failed work", description: retry.message });
    }
    if (!(["approved", "failed", "cancelled"] as TaskStatus[]).includes(task.status)) {
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
    if (action === "retry") {
      await requestHumanRetry(ctx, task.id);
      return;
    }
    if (action.startsWith("status:")) {
      const status = action.slice("status:".length) as TaskStatus;
      try {
        if (status === "approved") manuallyApproveTask(ctx, task.id);
        else {
          updateTask(ctx.cwd, task.id, (fresh) => {
            assertTaskNotDispatched(fresh);
            forceStatus(fresh, status);
          });
        }
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "warning");
        return;
      }
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
      if (status === "approved") labelCurrentEntry(ctx, `maestro: ${task.id} approved`);
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
    if (!content) return new Text(theme.fg("accent", "⚡ maestro"), 0, 0);
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", "⚡ maestro"), 0, 0));
    container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
    return container;
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
    activeCwd = ctx.cwd;
    runtimeActive = true;
    closeLivePane();
    closePlanPane();
    hiddenLivePaneDriveId = undefined;
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
    let recovered = loadBoard(boardCwd);
    const orphanedDrive = recovered.activeDrive;
    const currentSession = ctx.sessionManager.getSessionFile();
    if (
      orphanedDrive &&
      !driveController.hasActive() &&
      liveRuns.size === 0 &&
      sessionCanControlDrive(orphanedDrive.ownerSession, currentSession)
    ) {
      const summary = unexpectedDriveSummary(
        boardCwd,
        orphanedDrive.taskIds,
        "the owning extension runtime stopped before recording an outcome"
      );
      persistDriveDecision(
        boardCwd,
        orphanedDrive.ownerSession,
        summary,
        formatDrivePulse(summary),
        orphanedDrive.id
      );
      recovered = loadBoard(boardCwd);
    }
    const pendingDecision = recovered.activeDecision;
    if (
      pendingDecision &&
      !pendingDecision.deliveredAt &&
      sessionCanControlDrive(pendingDecision.ownerSession, currentSession) &&
      sessionContainsDecision(ctx, pendingDecision.id)
    ) {
      acknowledgeDeliveredDecision(boardCwd, pendingDecision.id);
      recovered = loadBoard(boardCwd);
    }
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
    runtimeActive = false;
    closeLivePane();
    closePlanPane();
    const active = driveController.activeOwner();
    if (active) {
      try {
        const summary = unexpectedDriveSummary(
          active.cwd,
          active.taskIds,
          "the extension runtime shut down while the drive was active"
        );
        persistDriveDecision(
          active.cwd,
          active.ownerSession,
          summary,
          formatDrivePulse(summary),
          active.id
        );
      } catch {
        // The durable active-drive record remains for owner-scoped startup reconciliation.
      }
    }
    driveController.shutdown();
    for (const run of liveRuns.values()) {
      run.handle.abort();
    }
    liveRuns.clear();
  });
}
