import {
  type ExtensionCommandContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
  type ConfigScope,
  PRESETS,
  THINKING_LEVELS,
  configFile,
  findPreset,
  loadConfig,
  matchingPreset,
  saveConfig,
} from "./config.js";
import { type MaestroConfig } from "./types.js";

const TIER_DESCRIPTIONS: Record<string, string> = {
  trivial: "Mechanical, well-specified changes: renames, configs, small files, docs.",
  standard: "Scoped features or bugfixes with a clear spec touching few files.",
  complex: "Cross-cutting changes, ambiguous specs, or design judgment.",
  review: "Adversarial reviewer. Read-only tools; approves or requests changes.",
};

const MODEL_CHOICES = [
  "(pi default)",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "claude-sonnet-5",
  "claude-fable-5",
];

function tierDescription(name: string): string {
  return TIER_DESCRIPTIONS[name] ?? "Custom tier.";
}

/**
 * Interactive settings editor for maestro. Edits are applied to a full
 * resolved config and written to one scope file, so what you see is exactly
 * what future runs use.
 */
export async function showSettings(
  ctx: ExtensionCommandContext,
  scope: ConfigScope
): Promise<void> {
  // Work on the resolved config so the UI always shows effective values.
  let config: MaestroConfig = structuredClone(loadConfig(ctx.cwd));

  const persist = () => saveConfig(scope, ctx.cwd, config);

  const buildItems = (): SettingItem[] => {
    const items: SettingItem[] = [
      {
        id: "preset",
        label: "Preset",
        currentValue: matchingPreset(config),
        values: PRESETS.map((preset) => preset.name),
        description: presetDescription(matchingPreset(config)),
      },
      {
        id: "maxParallel",
        label: "Max parallel executors",
        currentValue: String(config.maxParallel),
        values: ["1", "2", "3", "4", "6", "8"],
        description:
          "How many executors run at once. Higher is faster for independent tasks but multiplies burst API usage.",
      },
    ];

    for (const [name, tier] of Object.entries(config.tiers)) {
      items.push({
        id: `model:${name}`,
        label: `${name} · model`,
        currentValue: tier.model ?? "(pi default)",
        values: MODEL_CHOICES,
        description: `${tierDescription(name)} "(pi default)" inherits your current pi model — works with any provider.`,
      });
      items.push({
        id: `thinking:${name}`,
        label: `${name} · thinking`,
        currentValue: tier.thinking,
        values: [...THINKING_LEVELS],
        description: `Reasoning effort for ${name} executors. Per GPT-5.6 guidance: start medium, drop a level if quality holds, raise only when evals show a gain.`,
      });
    }
    return items;
  };

  const applyChange = (id: string, value: string) => {
    if (id === "preset") {
      const preset = findPreset(value);
      if (preset) config = structuredClone(preset.config);
      persist();
      return;
    }
    if (id === "maxParallel") {
      config.maxParallel = Number(value);
      persist();
      return;
    }
    const [kind, tierName] = id.split(":");
    const tier = tierName ? config.tiers[tierName] : undefined;
    if (!tier) return;
    if (kind === "model") {
      if (value === "(pi default)") delete tier.model;
      else tier.model = value;
    }
    if (kind === "thinking") tier.thinking = value;
    persist();
  };

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const title = ` maestro settings · ${scope} scope → ${configFile(scope, ctx.cwd)}`;
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(
      new Text(
        theme.fg(
          "muted",
          " Changing any value switches preset to \u201ccustom\u201d. Model names are patterns resolved against your available providers."
        ),
        1,
        0
      )
    );

    let list: SettingsList;
    const rebuild = () => {
      const items = buildItems();
      list = new SettingsList(
        items,
        Math.min(items.length + 2, 16),
        getSettingsListTheme(),
        (id, value) => {
          applyChange(id, value);
          // Preset switches rewrite every tier; rebuild so all rows update.
          if (id === "preset") rebuild();
          else {
            for (const item of buildItems()) list.updateValue(item.id, item.currentValue);
            list.updateValue("preset", matchingPreset(config));
          }
          tui.requestRender();
        },
        () => done(undefined),
        { enableSearch: true }
      );
    };
    rebuild();

    container.addChild(
      new Text(theme.fg("dim", " enter/space cycle · type to search · esc save & close"), 1, 0)
    );

    return {
      render: (width: number) => {
        // Container children are static; render list between header and hint.
        const header = container.render(width);
        const hint = header.pop() ?? "";
        return [...header, ...list.render(width), hint];
      },
      invalidate: () => {
        container.invalidate();
        list.invalidate();
      },
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function presetDescription(name: string): string {
  if (name === "custom") return "Hand-tuned values. Pick a preset to reset all tiers at once.";
  return findPreset(name)?.description ?? "";
}
