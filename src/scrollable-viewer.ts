import {
  type ExtensionCommandContext,
  getMarkdownTheme,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { hint } from "./command-ui.js";

const SCROLL_STEP = 10;

export function scrollableTextOffset(
  offset: number,
  delta: number,
  lineCount: number,
  pageSize: number
): number {
  return Math.max(0, Math.min(Math.max(0, lineCount - pageSize), offset + delta));
}

const SCROLL_UP = ["tui.select.up", "tui.select.pageUp"] as const;
const SCROLL_DOWN = ["tui.select.down", "tui.select.pageDown"] as const;
const CLOSE = ["tui.select.confirm", "tui.select.cancel"] as const;

/**
 * The viewer's key hint, from the keybindings pi injects. In pi's fullscreen
 * mode (the 1.0 default) the page keys scroll pi's own viewport before an
 * inline component sees them, so only the line keys are advertised there.
 */
function scrollHint(tui: Pick<TUI, "mode">, theme: Theme, keybindings: KeybindingsManager): string {
  const scroll =
    tui.mode === "fullscreen"
      ? (["tui.select.up", "tui.select.down"] as const)
      : (["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const);
  return `${hint(theme, keybindings, scroll, "scroll")}  ${hint(theme, keybindings, CLOSE, "close")}`;
}

export async function showScrollableText(
  ctx: ExtensionCommandContext,
  title: string,
  lines: string[]
): Promise<void> {
  if (ctx.mode !== "tui") {
    // ctx.ui.custom renders nothing outside the TUI; RPC forwards notify.
    if (ctx.hasUI) ctx.ui.notify(`${title}\n\n${lines.join("\n")}`, "info");
    return;
  }
  await showPaged(ctx, title, new Text(lines.join("\n"), 1, 0));
}

export async function showScrollableMarkdown(
  ctx: ExtensionCommandContext,
  title: string,
  markdownText: string
): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(`${title}\n\n${markdownText}`, "info");
    return;
  }
  await showPaged(ctx, title, new Markdown(markdownText, 1, 0, getMarkdownTheme()));
}

/**
 * Pages `body` by the terminal rows it wraps to at the current width, so a
 * long paragraph on a narrow terminal still scrolls instead of overflowing
 * the screen as one source line.
 */
async function showPaged(
  ctx: ExtensionCommandContext,
  title: string,
  body: Component
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    let offset = 0;
    let rows: string[] = [];
    let rowsWidth = -1;
    const heading = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
    const pageSize = () => Math.max(6, tui.terminal.rows - 6);
    return {
      render: (width: number) => {
        if (rowsWidth !== width) {
          rows = body.render(width);
          rowsWidth = width;
        }
        offset = scrollableTextOffset(offset, 0, rows.length, pageSize());
        return [
          ...heading.render(width),
          ...rows.slice(offset, offset + pageSize()),
          truncateToWidth(scrollHint(tui, theme, keybindings), width),
        ];
      },
      invalidate: () => {
        heading.invalidate();
        body.invalidate();
        rowsWidth = -1;
      },
      handleInput: (data: string) => {
        const pressed = (actions: readonly Parameters<KeybindingsManager["matches"]>[1][]) =>
          actions.some((action) => keybindings.matches(data, action));
        if (pressed(CLOSE)) {
          done();
          return;
        }
        if (pressed(SCROLL_UP)) {
          offset = scrollableTextOffset(offset, -SCROLL_STEP, rows.length, pageSize());
        }
        if (pressed(SCROLL_DOWN)) {
          offset = scrollableTextOffset(offset, SCROLL_STEP, rows.length, pageSize());
        }
        tui.requestRender();
      },
    };
  });
}
