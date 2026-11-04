import {
  type ExtensionCommandContext,
  getSelectListTheme,
  type KeybindingsManager,
  rawKeyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

type KeybindingId = Parameters<KeybindingsManager["getKeys"]>[0];

/**
 * Formats a configured keybinding with the manager pi injects into
 * `ctx.ui.custom`. pi's exported `keyHint` reads the keybindings of whichever
 * pi-coding-agent copy the import resolves to, which can be the extension's
 * own and renders `app.*` ids without keys.
 */
export function hint(
  theme: Theme,
  keybindings: KeybindingsManager,
  ids: KeybindingId | readonly KeybindingId[],
  description: string
): string {
  const keys = (typeof ids === "string" ? [ids] : ids)
    .flatMap((id) => keybindings.getKeys(id))
    .join("/");
  return keys ? rawKeyHint(keys, description) : theme.fg("muted", description);
}

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
  return await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    const heading = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
    const footer = new Text(
      `${hint(theme, keybindings, "tui.input.submit", "save")}  ${hint(theme, keybindings, "tui.select.cancel", "cancel")}`,
      1,
      0
    );
    const field = new Input();
    field.setValue(value);
    field.onSubmit = (next) => done(next);
    field.onEscape = () => done(null);

    return {
      // Focusable: pi places the hardware (IME) cursor at the field's marker.
      get focused() {
        return field.focused;
      },
      set focused(value: boolean) {
        field.focused = value;
      },
      render: (width: number) => [
        ...heading.render(width),
        ...field.render(width),
        ...footer.render(width),
      ],
      invalidate: () => {
        heading.invalidate();
        field.invalidate();
        footer.invalidate();
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
  return await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(
      new Text(
        `${hint(theme, keybindings, ["tui.select.up", "tui.select.down"], "navigate")}  ${hint(theme, keybindings, "tui.select.confirm", "select")}  ${hint(theme, keybindings, "tui.select.cancel", "close")}`,
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
