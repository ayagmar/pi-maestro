import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MaestroCommandCompletions } from "./command-completions.js";
import {
  handleConfigCommand,
  handleCostsCommand,
  handleInsightsCommand,
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
        case "insights":
          handleInsightsCommand(ctx);
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
      liveRunKinds: () => this.runtime.liveRunKinds(),
    };
  }

  private showHelp(ctx: ExtensionCommandContext, subcommand: string): void {
    notify(
      ctx,
      [
        ...(subcommand ? [`Unknown subcommand "${subcommand}". Available commands:`, ""] : []),
        "Most runs need only these:",
        `/${COMMAND} start <goal>   plan and delegate a goal`,
        `/${COMMAND} drive [ids]    run, review, and retry until the board settles`,
        `/${COMMAND} board          dashboard: tasks, launches, evidence, actions`,
        `/${COMMAND} config         change models, concurrency, and spend caps`,
        "",
        "while a drive runs",
        `/${COMMAND} pause          stop starting work after active executors finish`,
        `/${COMMAND} resume         continue a paused drive`,
        `/${COMMAND} abort          stop the drive and its executors`,
        `/${COMMAND} open <taskId>  switch into an executor session (\`back\` returns)`,
        `/${COMMAND} agents         browse live and completed sessions`,
        "",
        "when something goes wrong",
        `/${COMMAND} retry <taskId> retry failed work under human control`,
        `/${COMMAND} doctor         diagnose config, models, auth, git, and worktrees`,
        `/${COMMAND} handoff        continue in a fresh session, dropping planning context`,
        `/${COMMAND} replay [file]  restore an archived board`,
        `/${COMMAND} reset          archive and clear the board`,
        "",
        "review spend and outcomes",
        `/${COMMAND} costs          attempts, total and average cost, models, providers`,
        `/${COMMAND} insights       compare cost, approval, and failure rates by model`,
        `/${COMMAND} timeline [id]  run and task evidence, chronologically`,
        `/${COMMAND} history [n]    recent task status changes`,
        "",
        "occasional",
        `/${COMMAND} plan           approve a gated plan; export, import, diff`,
        `/${COMMAND} recipe         save and run declarative workflows`,
        `/${COMMAND} workflows      browse and operate reusable workflows`,
        `/${COMMAND} simulate [ids] preview dependency waves without running work`,
        `/${COMMAND} discover <id>  preview and approve generated tasks`,
        `/${COMMAND} reconcile      report artifact inconsistencies without mutation`,
      ].join("\n")
    );
  }
}
