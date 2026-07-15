import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  type EditorTheme,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

export async function editText(
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

export async function pickFromList(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[]
): Promise<string | null> {
  return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const list = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
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
