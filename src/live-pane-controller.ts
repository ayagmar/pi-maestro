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

/** Rows shown in the below-editor agent selector, matched by the shortcut cycle. */
export const AGENT_SELECTOR_ROWS = 6;

export class LivePaneController {
  private pane: LivePaneRuntime | undefined;
  private suppressedAutoPaneDriveId: string | undefined;
  private sharedSelection: string | undefined;

  constructor(private readonly dependencies: LivePaneControllerDependencies) {}

  launches(ctx: ExtensionContext): LivePaneLaunch[] {
    return collectLivePaneLaunches(ctx.cwd, this.dependencies.driveController.liveRunValues());
  }

  /**
   * The bounded, ordered agent list shared by the below-editor selector widget
   * and the ctrl+alt+j/k cycle: live launches first (board order), then the
   * most recent settled ones. One ordering for both, or the selection marker
   * would point at rows the widget does not show.
   */
  selectorLaunches(ctx: ExtensionContext): LivePaneLaunch[] {
    const launches = this.launches(ctx);
    const live = launches.filter((launch) => launch.live !== false);
    const settled = launches
      .filter((launch) => launch.live === false)
      .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
    return [...live, ...settled].slice(0, AGENT_SELECTOR_ROWS);
  }

  selectedLaunchKey(ctx: ExtensionContext): string | undefined {
    const rows = this.selectorLaunches(ctx);
    if (rows.some((launch) => launch.key === this.sharedSelection)) return this.sharedSelection;
    return rows.find((launch) => launch.live !== false)?.key ?? rows[0]?.key;
  }

  /** Move the shared agent selection without opening anything. */
  selectAdjacent(ctx: ExtensionContext, offset: -1 | 1): void {
    const rows = this.selectorLaunches(ctx);
    if (rows.length === 0) {
      notify(ctx, `No Maestro agent sessions yet. Start a drive, then use /${COMMAND} agents.`);
      return;
    }
    const current = this.selectedLaunchKey(ctx);
    const index = rows.findIndex((launch) => launch.key === current);
    const next = rows[(Math.max(0, index) + offset + rows.length) % rows.length];
    if (!next) return;
    this.sharedSelection = next.key;
    this.pane?.component?.selectKey(next.key);
    this.dependencies.refreshUI(ctx);
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
            ...(this.sharedSelection ? { initialSelectedKey: this.sharedSelection } : {}),
            onSelectionChange: (key) => {
              this.sharedSelection = key;
            },
            tui,
            cwd: ctx.cwd,
            onEscape: () => {
              // The footer promises "esc close", so escape must actually close
              // — and stay closed. Without suppression, sync() re-opened the
              // auto pane on the next update tick, which read as "this pane
              // cannot be closed".
              this.suppressedAutoPaneDriveId = this.currentDriveId();
              this.close();
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
      const wasFocused = this.pane.handle?.isFocused() ?? false;
      const wasVisible = this.pane.isResponsiveVisible?.() ?? true;
      // One key, one ladder: docked side pane → centered focused viewer →
      // closed (suppressed until the next drive). Focusing the docked pane
      // in place left it glued to the right edge over truncated chat text,
      // which is exactly what users reported as broken.
      this.suppressedAutoPaneDriveId = this.currentDriveId();
      this.close();
      if (!wasFocused || !wasVisible) this.open(ctx, true);
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
