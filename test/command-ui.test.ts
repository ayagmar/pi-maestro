import assert from "node:assert/strict";
import test from "node:test";
import {
  type ExtensionCommandContext,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { editText, pickFromList } from "../src/command-ui.js";

initTheme("dark");

test("list pickers show the user's remapped keys from the keybindings pi injects", async () => {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+g" });
  let rendered: string[] = [];
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: async <T>(
        factory: (
          tui: { requestRender(): void },
          theme: Theme,
          keys: KeybindingsManager,
          done: (value: T) => void
        ) => { render(width: number): string[] }
      ) =>
        await new Promise<T>((resolve) => {
          const component = factory({ requestRender: () => {} }, plainTheme, keybindings, resolve);
          rendered = component.render(100);
          resolve(null as T);
        }),
    },
  } as unknown as ExtensionCommandContext;

  await pickFromList(ctx, "Pick", [{ value: "a", label: "A" }]);

  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI styling
  const footer = rendered.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(footer, /ctrl\+g close/);
  assert.doesNotMatch(footer, /escape close/);
});

test("the single-line editor exposes its cursor to pi when focused", async () => {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: async <T>(
        factory: (
          tui: { requestRender(): void },
          theme: Theme,
          keys: KeybindingsManager,
          done: (value: T) => void
        ) => { focused?: boolean; render(width: number): string[]; handleInput(data: string): void }
      ) =>
        await new Promise<T>((resolve) => {
          const component = factory({ requestRender: () => {} }, plainTheme, keybindings, resolve);
          // pi sets `focused` on a Focusable component before rendering it.
          component.focused = true;
          assert.ok(component.render(80).join("\n").includes(CURSOR_MARKER));
          component.handleInput("\r");
        }),
    },
  } as unknown as ExtensionCommandContext;

  assert.equal(await editText(ctx, "Title", "Rename", false), "Rename");
});
