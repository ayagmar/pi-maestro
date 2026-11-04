import { type ExtensionCommandContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  Markdown,
  matchesKey,
  Text,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";

const SCROLL_STEP = 10;

export function scrollableTextOffset(
  offset: number,
  delta: number,
  lineCount: number,
  pageSize: number
): number {
  return Math.max(0, Math.min(Math.max(0, lineCount - pageSize), offset + delta));
}

/**
 * In pi's fullscreen mode (the 1.0 default) PgUp/PgDn scroll pi's own
 * viewport before an inline component sees them, so only the arrows page
 * this viewer there.
 */
export function scrollHint(tui: Pick<TUI, "mode">): string {
  return tui.mode === "fullscreen"
    ? "↑↓ scroll · enter/esc close"
    : "↑↓/PgUp/PgDn scroll · enter/esc close";
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
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
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
          truncateToWidth(theme.fg("dim", scrollHint(tui)), width),
        ];
      },
      invalidate: () => {
        heading.invalidate();
        body.invalidate();
        rowsWidth = -1;
      },
      handleInput: (data: string) => {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
          done();
          return;
        }
        if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) {
          offset = scrollableTextOffset(offset, -SCROLL_STEP, rows.length, pageSize());
        }
        if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
          offset = scrollableTextOffset(offset, SCROLL_STEP, rows.length, pageSize());
        }
        tui.requestRender();
      },
    };
  });
}
