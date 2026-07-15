import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MaestroCommandCompletions } from "./command-completions.js";
import {
  handleConfigCommand,
  handleCostsCommand,
  handleReconcileCommand,
  handleSimulationCommand,
  handleTimelineCommand,
} from "./command-inspection.js";
import { handlePlanCommand } from "./command-plans.js";
import { handleDiscoveryCommand, handleRecipeCommand } from "./command-recipes.js";
import {
  handleDoctorCommand,
  handleHistoryCommand,
  handleReplayCommand,
  handleResetCommand,
} from "./command-recovery.js";
import {
  handleAbortCommand,
  handleDriveCommand,
  handleHandoffCommand,
  handlePauseCommand,
  handleResumeCommand,
  handleRetryCommand,
  handleStartCommand,
  type RunCommandRuntime,
  type RunCommandSession,
} from "./command-run-control.js";
import { parseCommand } from "./commands.js";
import { COMMAND } from "./constants.js";
import { notify } from "./handoff.js";

export interface CommandNavigation {
  back(ctx: ExtensionCommandContext): Promise<void>;
  openTask(ctx: ExtensionCommandContext, taskId: string): Promise<void>;
}

export interface CommandViews {
  showHome(ctx: ExtensionCommandContext): Promise<string | null>;
  showAgents(ctx: ExtensionCommandContext): void;
  showWorkflows(ctx: ExtensionCommandContext): Promise<void>;
  showDashboard(ctx: ExtensionCommandContext): Promise<void>;
  showPlan(ctx: ExtensionCommandContext): Promise<void>;
  onBoardChanged(ctx: ExtensionCommandContext): void;
  notifyQuarantine(ctx: ExtensionCommandContext): void;
}

export class MaestroCommandDispatcher {
  private readonly completions: MaestroCommandCompletions;

  constructor(
    initialCwd: string,
    private readonly runtime: RunCommandRuntime,
    private readonly session: RunCommandSession,
    private readonly navigation: CommandNavigation,
    private readonly views: CommandViews
  ) {
    this.completions = new MaestroCommandCompletions(initialCwd);
  }

  setCwd(cwd: string): void {
    this.completions.setCwd(cwd);
  }

  readonly complete = (prefix: string) => this.completions.complete(prefix);

  readonly dispatch = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    this.completions.setCwd(ctx.cwd);
    let { subcommand, rest, restParts } = parseCommand(args);
    if (!subcommand && ctx.mode === "tui") {
      const selected = await this.views.showHome(ctx);
      if (!selected) return;
      ({ subcommand, rest, restParts } = parseCommand(selected));
    }

    try {
      switch (subcommand) {
        case "start":
          await handleStartCommand(ctx, rest, this.runtime, this.session);
          return;
        case "back":
          await this.navigation.back(ctx);
          return;
        case "drive":
          await handleDriveCommand(ctx, rest, this.runtime);
          return;
        case "retry":
          await handleRetryCommand(ctx, rest, restParts, this.runtime);
          return;
        case "pause":
          handlePauseCommand(ctx, this.runtime);
          return;
        case "resume":
          await handleResumeCommand(ctx, this.runtime);
          return;
        case "abort":
          handleAbortCommand(ctx, this.runtime);
          return;
        case "plan":
          await handlePlanCommand(ctx, restParts, {
            hasLiveRuns: () => this.runtime.liveRunCount() > 0,
            onBoardChanged: () => this.views.onBoardChanged(ctx),
            reviewPlan: this.views.showPlan,
          });
          return;
        case "recipe":
          await handleRecipeCommand(ctx, rest, this.mutationRuntime(ctx));
          return;
        case "agents":
          this.views.showAgents(ctx);
          return;
        case "workflows":
          await this.views.showWorkflows(ctx);
          return;
        case "board":
        case "dash":
        case "dashboard":
          await this.views.showDashboard(ctx);
          return;
        case "open":
          if (!rest) {
            notify(ctx, "Usage: /maestro open <taskId>", "warning");
            return;
          }
          await this.navigation.openTask(ctx, rest);
          return;
        case "config":
          await handleConfigCommand(ctx, rest, () => this.views.onBoardChanged(ctx));
          return;
        case "simulate":
          handleSimulationCommand(ctx, rest);
          return;
        case "discover":
          await handleDiscoveryCommand(ctx, restParts, this.mutationRuntime(ctx));
          return;
        case "costs":
          handleCostsCommand(ctx);
          return;
        case "reconcile":
          handleReconcileCommand(ctx);
          return;
        case "doctor":
          await handleDoctorCommand(ctx, restParts, this.recoveryRuntime(ctx));
          return;
        case "handoff":
          await handleHandoffCommand(ctx, this.runtime, this.session);
          return;
        case "history":
          handleHistoryCommand(ctx, rest);
          return;
        case "timeline":
          handleTimelineCommand(ctx, restParts);
          return;
        case "replay":
          await handleReplayCommand(ctx, rest, this.recoveryRuntime(ctx));
          return;
        case "reset":
          await handleResetCommand(ctx, rest, this.recoveryRuntime(ctx));
          return;
        default:
          this.showHelp(ctx, subcommand);
      }
    } finally {
      this.views.notifyQuarantine(ctx);
    }
  };

  private mutationRuntime(ctx: ExtensionCommandContext) {
    return {
      hasLiveRuns: () => this.runtime.liveRunCount() > 0,
      isTaskLive: this.runtime.isTaskLive,
      onBoardChanged: () => this.views.onBoardChanged(ctx),
    };
  }

  private recoveryRuntime(ctx: ExtensionCommandContext) {
    return {
      ...this.mutationRuntime(ctx),
      liveTaskIds: () => this.runtime.liveTaskIds(),
    };
  }

  private showHelp(ctx: ExtensionCommandContext, subcommand: string): void {
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
        `/${COMMAND} board          phase-first project dashboard (tasks, launches, evidence, actions)`,
        `/${COMMAND} agents         browse live and completed executor/reviewer sessions`,
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
        `/${COMMAND} workflows      interactively browse and operate reusable workflows`,
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
        `/${COMMAND} reset [confirm] archive and clear the board`,
      ].join("\n")
    );
  }
}
