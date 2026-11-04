import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { showScrollableMarkdown, showScrollableText } from "../src/scrollable-viewer.js";

initTheme();

const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

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
    mode: "tui",
    hasUI: true,
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
        const component = factory(tui, theme, keybindings, () => {
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

test("the text viewer pages a long paragraph by its wrapped terminal rows", async () => {
  const paragraph = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
  const frames: string[][] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: () => void
        ) => ViewerComponent
      ) => {
        const tui = {
          mode: "regular",
          terminal: { rows: 24, columns: 40 },
          requestRender: () => {},
        };
        const component = factory(tui, theme, keybindings, () => {});
        frames.push(component.render(40));
        component.handleInput("\x1b[B");
        frames.push(component.render(40));
      },
    },
  } as unknown as ExtensionCommandContext;

  await showScrollableText(ctx, "Brief", [paragraph]);

  const [first, scrolled] = frames;
  assert.ok(first && scrolled);
  assert.ok(first.length <= 24, `frame is ${first.length} rows on a 24-row terminal`);
  assert.match(first.join("\n"), /word0 /);
  assert.notDeepEqual(scrolled, first, "scrolling down must move through the paragraph");
  assert.doesNotMatch(scrolled.join("\n"), /word0 /);
});
