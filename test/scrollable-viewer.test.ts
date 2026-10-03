import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showScrollableMarkdown, showScrollableText } from "../src/scrollable-viewer.js";

initTheme();

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

interface ViewerComponent {
  render(width: number): string[];
  handleInput(data: string): void;
}

/** Open a viewer in a fake TUI of the given mode and return its first frame at `width`. */
async function firstFrame(
  mode: "fullscreen" | "regular",
  width: number,
  show: (ctx: ExtensionCommandContext) => Promise<void>
): Promise<string[]> {
  let frame: string[] = [];
  const ctx = {
    ui: {
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: () => void
        ) => ViewerComponent
      ) => {
        let closed = false;
        const tui = { mode, terminal: { rows: 30, columns: width }, requestRender: () => {} };
        const component = factory(tui, theme, {}, () => {
          closed = true;
        });
        frame = component.render(width);
        component.handleInput("\x1b");
        assert.equal(closed, true);
      },
    },
  } as unknown as ExtensionCommandContext;
  await show(ctx);
  return frame;
}

for (const [name, show] of [
  ["text", (ctx: ExtensionCommandContext) => showScrollableText(ctx, "Brief", ["line"])],
  ["markdown", (ctx: ExtensionCommandContext) => showScrollableMarkdown(ctx, "Plan", "# Plan")],
] as const) {
  test(`scrollable ${name} viewer advertises only keys that reach it`, async () => {
    // pi's fullscreen viewport consumes PgUp/PgDn before inline components.
    const fullscreen = (await firstFrame("fullscreen", 80, show)).at(-1) ?? "";
    assert.match(fullscreen, /↑↓ scroll/);
    assert.doesNotMatch(fullscreen, /PgUp/);
    const regular = (await firstFrame("regular", 80, show)).at(-1) ?? "";
    assert.match(regular, /PgUp\/PgDn/);
    for (const line of await firstFrame("regular", 12, show)) {
      assert.ok(visibleWidth(line) <= 12, line);
    }
  });
}
