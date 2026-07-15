import { type ExtensionCommandContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

const TEXT_PAGE_SIZE = 18;
const SCROLL_STEP = 10;

export function scrollableTextOffset(
  offset: number,
  delta: number,
  lineCount: number,
  pageSize = TEXT_PAGE_SIZE
): number {
  return Math.max(0, Math.min(Math.max(0, lineCount - pageSize), offset + delta));
}

export async function showScrollableText(
  ctx: ExtensionCommandContext,
  title: string,
  lines: string[]
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let offset = 0;
    const heading = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
    return {
      render: (width: number) => {
        const content = new Text(lines.slice(offset, offset + TEXT_PAGE_SIZE).join("\n"), 1, 0);
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
          offset = scrollableTextOffset(offset, -SCROLL_STEP, lines.length);
        }
        if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
          offset = scrollableTextOffset(offset, SCROLL_STEP, lines.length);
        }
        tui.requestRender();
      },
    };
  });
}

export async function showScrollableMarkdown(
  ctx: ExtensionCommandContext,
  title: string,
  markdownText: string
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let offset = 0;
    let rendered: string[] = [];
    let renderedWidth = -1;
    const heading = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
    const markdown = new Markdown(markdownText, 1, 0, getMarkdownTheme());
    return {
      render: (width: number) => {
        if (renderedWidth !== width) {
          rendered = markdown.render(width);
          renderedWidth = width;
        }
        const pageSize = Math.max(6, tui.terminal.rows - 6);
        offset = Math.min(offset, Math.max(0, rendered.length - pageSize));
        return [
          ...heading.render(width),
          ...rendered.slice(offset, offset + pageSize),
          theme.fg("dim", "↑↓/PgUp/PgDn scroll · enter/esc close"),
        ];
      },
      invalidate: () => {
        heading.invalidate();
        markdown.invalidate();
        renderedWidth = -1;
      },
      handleInput: (data: string) => {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
          done();
          return;
        }
        if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) {
          offset = Math.max(0, offset - SCROLL_STEP);
        }
        if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
          offset += SCROLL_STEP;
        }
        tui.requestRender();
      },
    };
  });
}
