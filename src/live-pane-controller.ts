import {
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type OverlayHandle } from "@earendil-works/pi-tui";
import { loadBoard } from "./board.js";
import { loadConfig } from "./config.js";
import { COMMAND } from "./constants.js";
import { type DriveRuntimeController } from "./drive-controller.js";
import { notify } from "./handoff.js";
import { collectLivePaneLaunches } from "./live-pane-launches.js";
import { LivePaneComponent, type LivePaneLaunch } from "./live-pane.js";
import { sessionSwitchBlocked } from "./session-control.js";
import { type SessionNavigator } from "./session-navigator.js";
import { type Board } from "./types.js";

interface LivePaneRuntime {
  handle?: OverlayHandle;
  component?: LivePaneComponent;
  done?: () => void;
  isResponsiveVisible?: () => boolean;
  closing: boolean;
}

export interface LivePaneControllerDependencies {
  driveController: DriveRuntimeController;
  sessionNavigator: SessionNavigator;
  isRuntimeActive(): boolean;
  sessionOwnsBoard(ctx: ExtensionContext, board: Board): boolean;
  refreshUI(ctx: ExtensionContext): void;
}

const responsiveVisibility = (width: number): boolean => width >= 100;

export class LivePaneController {
  private pane: LivePaneRuntime | undefined;
  private suppressedAutoPaneDriveId: string | undefined;

  constructor(private readonly dependencies: LivePaneControllerDependencies) {}

  launches(ctx: ExtensionContext): LivePaneLaunch[] {
    return collectLivePaneLaunches(ctx.cwd, this.dependencies.driveController.liveRunValues());
  }

  isVisible(_width: number): boolean {
    const pane = this.pane;
    if (!pane?.handle || pane.closing || pane.handle.isHidden()) return false;
    return pane.isResponsiveVisible?.() ?? true;
  }

  close(): void {
    const pane = this.pane;
    if (!pane || pane.closing || !pane.done) return;
    pane.closing = true;
    this.pane = undefined;
    pane.done();
  }

  open(ctx: ExtensionContext, focused: boolean): void {
    if (this.pane || !this.canShow(ctx)) return;
    if (this.launches(ctx).length === 0) {
      if (focused) {
        notify(ctx, `No Maestro agent sessions yet. Start a drive, then open /${COMMAND} agents.`);
      }
      return;
    }

    const pane: LivePaneRuntime = { closing: false };
    this.pane = pane;
    let completion: Promise<void>;
    try {
      completion = ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          pane.done = () => done(undefined);
          pane.isResponsiveVisible = () => focused || responsiveVisibility(tui.terminal.columns);
          pane.component = new LivePaneComponent(theme, {
            getLaunches: () => this.launches(ctx),
            getHeight: () => Math.max(1, Math.floor(tui.terminal.rows * 0.8)),
            requestRender: () => tui.requestRender(),
            tui,
            cwd: ctx.cwd,
            onEscape: () => {
              if (focused) this.close();
              else pane.handle?.unfocus();
              this.dependencies.refreshUI(ctx);
            },
            onCycleVisibility: () => this.cycle(ctx),
            onSteer: (launch, message) => {
              this.dependencies.driveController.getLiveRun(launch.taskId)?.handle.steer(message);
            },
            onFollowUp: (launch, message) => {
              this.dependencies.driveController.getLiveRun(launch.taskId)?.handle.followUp(message);
            },
            ...(isCommandContext(ctx)
              ? {
                  canOpenSession: () =>
                    !sessionSwitchBlocked(
                      this.dependencies.driveController.hasActive(),
                      this.dependencies.driveController.liveRunCount()
                    ),
                  onOpenSession: (launch: LivePaneLaunch) => {
                    if (!launch.sessionFile) return;
                    void (async () => {
                      const confirmed = await ctx.ui.confirm(
                        "Open agent session in Pi?",
                        `Switch to ${launch.taskId}'s ${launch.kind} session? Use /${COMMAND} back to return.`
                      );
                      if (!confirmed) return;
                      this.close();
                      await this.dependencies.sessionNavigator.switchWithReturn(
                        ctx,
                        launch.sessionFile as string
                      );
                    })();
                  },
                }
              : {}),
          });
          return pane.component;
        },
        {
          overlay: true,
          overlayOptions: focused
            ? { anchor: "center", width: "92%", maxHeight: "92%", margin: 1 }
            : {
                anchor: "right-center",
                width: "45%",
                maxHeight: "80%",
                visible: responsiveVisibility,
              },
          onHandle: (handle) => {
            pane.handle = handle;
            if (
              !this.dependencies.isRuntimeActive() ||
              this.launches(ctx).length === 0 ||
              !this.canShow(ctx)
            ) {
              this.close();
              return;
            }
            if (focused) handle.focus();
            else handle.unfocus();
            this.dependencies.refreshUI(ctx);
          },
        }
      );
    } catch {
      pane.component?.dispose();
      if (this.pane === pane) this.pane = undefined;
      return;
    }

    const finish = () => {
      if (this.pane === pane) this.pane = undefined;
      if (this.dependencies.isRuntimeActive()) this.dependencies.refreshUI(ctx);
    };
    void completion.then(finish, finish);
  }

  sync(ctx: ExtensionContext): void {
    if (this.pane && (!this.canShow(ctx) || this.launches(ctx).length === 0)) {
      this.close();
      return;
    }
    if (
      !this.pane &&
      this.dependencies.driveController.liveRunCount() > 0 &&
      loadConfig(ctx.cwd).livePanes &&
      this.suppressedAutoPaneDriveId !== this.currentDriveId()
    ) {
      this.open(ctx, false);
    }
  }

  cycle(ctx: ExtensionContext): void {
    if (!this.canShow(ctx)) {
      notify(
        ctx,
        "Agent sessions are available only in the owning interactive TUI session.",
        "warning"
      );
      return;
    }
    if (this.pane) {
      if (!this.pane.isResponsiveVisible?.()) {
        this.suppressedAutoPaneDriveId = this.currentDriveId();
        this.close();
        this.open(ctx, true);
        this.dependencies.refreshUI(ctx);
        return;
      }
      if (!this.pane.handle?.isFocused()) {
        this.pane.handle?.focus();
        this.dependencies.refreshUI(ctx);
        return;
      }
      this.suppressedAutoPaneDriveId = this.currentDriveId();
      this.close();
      this.dependencies.refreshUI(ctx);
      return;
    }
    this.open(ctx, true);
  }

  clearSuppression(): void {
    this.suppressedAutoPaneDriveId = undefined;
  }

  onRunStarted(): void {
    if (this.suppressedAutoPaneDriveId !== this.currentDriveId()) {
      this.suppressedAutoPaneDriveId = undefined;
    }
  }

  private currentDriveId(): string | undefined {
    return this.dependencies.driveController.activeOwner()?.id;
  }

  private canShow(ctx: ExtensionContext): boolean {
    if (ctx.mode !== "tui") return false;
    return this.dependencies.sessionOwnsBoard(ctx, loadBoard(ctx.cwd));
  }
}

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
  return "switchSession" in ctx;
}
