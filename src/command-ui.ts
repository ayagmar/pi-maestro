import {
  type ExtensionCommandContext,
  getSelectListTheme,
  keyHint,
  rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

/**
 * ctx.ui.custom renders only in the TUI; in RPC mode it resolves undefined
 * at once, which made every Maestro picker a silent no-op there. Outside
 * the TUI these helpers use pi's stock dialogs, which RPC forwards to the
 * client.
 */
function usesStockDialogs(ctx: ExtensionCommandContext): boolean {
  return ctx.mode !== "tui";
}

/**
 * Multi-line text goes through pi's stock editor dialog in every mode: it
 * follows the user's keybindings and offers the external editor. pi has no
 * prefilled single-line input dialog, so the TUI keeps a small custom one.
 */
export async function editText(
  ctx: ExtensionCommandContext,
  title: string,
  value: string,
  multiline: boolean
): Promise<string | null> {
  if (multiline || usesStockDialogs(ctx)) {
    if (!ctx.hasUI) return null;
    const next = await ctx.ui.editor(title, value);
    if (next === undefined) return null;
    return multiline ? next : next.replace(/\s*\r?\n\s*/g, " ").trim();
  }
  return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const heading = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
    const hint = new Text(
      `${keyHint("tui.input.submit", "save")}  ${keyHint("tui.select.cancel", "cancel")}`,
      1,
      0
    );
    const field = new Input();
    field.setValue(value);
    field.onSubmit = (next) => done(next);
    field.onEscape = () => done(null);

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
        field.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export async function pickFromList(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[]
): Promise<string | null> {
  if (usesStockDialogs(ctx)) {
    if (!ctx.hasUI || items.length === 0) return null;
    const labels = items.map((item) =>
      item.description ? `${item.label} — ${item.description}` : item.label
    );
    const picked = await ctx.ui.select(title, labels);
    if (picked === undefined) return null;
    return items[labels.indexOf(picked)]?.value ?? null;
  }
  // pi's stock select dialog has no per-item descriptions, which most Maestro
  // menus rely on, so the TUI renders its own list with pi's list theme.
  return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(
      new Text(
        `${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "close")}`,
        1,
        0
      )
    );
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
