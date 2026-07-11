import {
  type ExtensionCommandContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import {
  type ConfigScope,
  configFile,
  findPreset,
  loadConfig,
  matchingPreset,
  PRESETS,
  saveConfig,
  THINKING_LEVELS,
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

const FALLBACK_CHOICES = [
  "(none)",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
];

export interface ModelChoices {
  model: string[];
  fallback: string[];
}

export function buildModelChoices(
  modelRegistry: ExtensionCommandContext["modelRegistry"]
): ModelChoices {
  const available = modelRegistry
    .getAvailable()
    .map((model) => `${model.provider}/${model.id}`)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();

  if (available.length === 0) {
    return { model: MODEL_CHOICES, fallback: FALLBACK_CHOICES };
  }

  return {
    model: ["(pi default)", ...available],
    fallback: ["(none)", ...available],
  };
}

export function filterModelChoices(choices: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return choices;
  return choices.filter((choice) => choice.toLowerCase().includes(normalizedQuery));
}

function tierDescription(name: string): string {
  return TIER_DESCRIPTIONS[name] ?? "Custom tier.";
}

/** Apply one UI setting to a resolved config. Presets replace the full config. */
export function applySettingsChange(
  currentConfig: MaestroConfig,
  id: string,
  value: string
): MaestroConfig {
  const config = currentConfig;

  if (id === "preset") {
    const preset = findPreset(value);
    return preset ? structuredClone(preset.config) : config;
  }
  if (id === "planGate") config.planGate = value === "on";
  else if (id === "maxParallel") config.maxParallel = Number(value);
  else if (id === "useWorktrees") config.useWorktrees = value === "on";
  else if (id === "autoCommit") config.autoCommit = value === "on";
  else if (id === "maxAttempts") config.maxAttempts = Number(value);
  else if (id === "maxCostPerTask") {
    config.maxCostPerTask = value === "off" ? 0 : Number(value.slice(1));
  } else if (id === "maxRunCost") {
    config.maxRunCost = value === "off" ? 0 : Number(value.slice(1));
  } else {
    const [kind, tierName] = id.split(":");
    const tier = tierName ? config.tiers[tierName] : undefined;
    if (!tier) return config;

    if (kind === "model") {
      if (value === "(pi default)") delete tier.model;
      else tier.model = value;
    } else if (kind === "fallback") {
      // The UI edits the first fallback; deeper chain entries stay untouched.
      const rest = tier.fallbacks?.slice(1) ?? [];
      const chain = value === "(none)" ? rest : [value, ...rest];
      if (chain.length === 0) delete tier.fallbacks;
      else tier.fallbacks = chain;
    } else if (kind === "thinking") {
      tier.thinking = value;
    }
  }

  return config;
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
  let config: MaestroConfig = structuredClone(loadConfig(ctx.cwd));
  const modelChoices = buildModelChoices(ctx.modelRegistry);
  const persist = () => saveConfig(scope, ctx.cwd, config);

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const pickerTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };

    const createModelPicker = (
      title: string,
      choices: string[],
      currentValue: string,
      close: (selectedValue?: string) => void
    ) => {
      const input = new Input();
      const titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
      const searchLabel = new Text(theme.fg("muted", " Search by provider or model id:"), 0, 0);
      const hint = new Text(
        theme.fg("dim", " ↑↓ navigate · type to filter · enter select · esc back"),
        0,
        0
      );
      let list: SelectList;

      const rebuildList = () => {
        const items: SelectItem[] = filterModelChoices(choices, input.getValue()).map((choice) => {
          const item: SelectItem = { value: choice, label: choice };
          if (choice === "(pi default)") item.description = "Inherit the model selected in pi";
          if (choice === "(none)") item.description = "Do not configure a fallback";
          return item;
        });
        list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), pickerTheme);
        const currentIndex = items.findIndex((item) => item.value === currentValue);
        if (!input.getValue() && currentIndex >= 0) list.setSelectedIndex(currentIndex);
        list.onSelect = (item) => close(item.value);
        list.onCancel = () => close();
      };
      rebuildList();

      return {
        render: (width: number) => [
          ...titleText.render(width),
          ...searchLabel.render(width),
          ...input.render(width),
          "",
          ...list.render(width),
          "",
          ...hint.render(width),
        ],
        invalidate: () => {
          titleText.invalidate();
          searchLabel.invalidate();
          input.invalidate();
          list.invalidate();
          hint.invalidate();
        },
        handleInput: (data: string) => {
          if (
            matchesKey(data, Key.up) ||
            matchesKey(data, Key.down) ||
            matchesKey(data, Key.enter) ||
            matchesKey(data, Key.escape)
          ) {
            list.handleInput(data);
            return;
          }
          input.handleInput(data);
          rebuildList();
        },
      };
    };

    const modelItems = (tierNames: string[]): SettingItem[] => {
      const items: SettingItem[] = [];
      for (const name of tierNames) {
        const tier = config.tiers[name];
        if (!tier) continue;
        items.push({
          id: `model:${name}`,
          label: `${name} · model`,
          currentValue: tier.model ?? "(pi default)",
          description: `${tierDescription(name)} Choose an authenticated provider/model, or inherit pi's model.`,
          submenu: (current, close) =>
            createModelPicker(`${name} primary model`, modelChoices.model, current, close),
        });
        items.push({
          id: `fallback:${name}`,
          label: `${name} · fallback`,
          currentValue: tier.fallbacks?.[0] ?? "(none)",
          description: `First model tried after the ${name} primary fails. Deeper fallbacks remain unchanged.`,
          submenu: (current, close) =>
            createModelPicker(`${name} fallback model`, modelChoices.fallback, current, close),
        });
        items.push({
          id: `thinking:${name}`,
          label: `${name} · thinking`,
          currentValue: tier.thinking,
          values: [...THINKING_LEVELS],
          description: `Reasoning effort for ${name} executors. Start medium and raise only when quality requires it.`,
        });
      }
      return items;
    };

    const buildSectionItems = (section: string): SettingItem[] => {
      if (section === "general") {
        return [
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
            description: "How many independent executors may run at once.",
          },
        ];
      }
      if (section === "execution") {
        return [
          {
            id: "planGate",
            label: "Approve plans before running",
            currentValue: config.planGate ? "on" : "off",
            values: ["off", "on"],
            description: "Pause newly planned tasks until you approve them with /maestro plan.",
          },
          {
            id: "useWorktrees",
            label: "Parallel git worktrees",
            currentValue: config.useWorktrees ? "on" : "off",
            values: ["off", "on"],
            description: "Isolate tasks in a parallel batch in separate git worktrees.",
          },
          {
            id: "autoCommit",
            label: "Auto-commit approved tasks",
            currentValue: config.autoCommit ? "on" : "off",
            values: ["on", "off"],
            description: "Commit each approved task with one conventional commit.",
          },
          {
            id: "maxAttempts",
            label: "Max attempts per task",
            currentValue: String(config.maxAttempts),
            values: ["1", "2", "3", "4", "5"],
            description: "Hard cap on execution attempts before a task fails.",
          },
          {
            id: "maxCostPerTask",
            label: "Cost cap per attempt (USD)",
            currentValue: config.maxCostPerTask === 0 ? "off" : `$${config.maxCostPerTask}`,
            values: ["off", "$1", "$2", "$5", "$10"],
            description: "Abort one executor attempt after it exceeds this cost.",
          },
          {
            id: "maxRunCost",
            label: "Run cost cap (USD)",
            currentValue: config.maxRunCost === 0 ? "off" : `$${config.maxRunCost}`,
            values: ["off", "$5", "$10", "$25", "$50"],
            description: "Stop starting new executors after the board exceeds this cost.",
          },
        ];
      }
      if (section === "tiers") {
        return modelItems(Object.keys(config.tiers).filter((name) => name !== "review"));
      }
      return modelItems(config.tiers.review ? ["review"] : []);
    };

    let navigation: SettingsList;
    const updateNavigationValues = () => {
      navigation.updateValue("general", matchingPreset(config));
      navigation.updateValue(
        "execution",
        `${config.maxParallel} parallel · ${config.maxAttempts} attempts`
      );
      navigation.updateValue(
        "tiers",
        `${Object.keys(config.tiers).filter((name) => name !== "review").length} tiers`
      );
      navigation.updateValue("review", config.tiers.review?.model ?? "(pi default)");
    };

    const createSection = (section: string, close: (selectedValue?: string) => void) => {
      let items = buildSectionItems(section);
      const list = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (id, value) => {
          config = applySettingsChange(config, id, value);
          persist();
          items = buildSectionItems(section);
          for (const item of items) list.updateValue(item.id, item.currentValue);
          updateNavigationValues();
          tui.requestRender();
        },
        () => close(),
        { enableSearch: false }
      );
      return list;
    };

    const navigationItems: SettingItem[] = [
      {
        id: "general",
        label: "General settings",
        currentValue: matchingPreset(config),
        description: "Preset and executor concurrency.",
        submenu: (_current, close) => createSection("general", close),
      },
      {
        id: "execution",
        label: "Execution and safety",
        currentValue: `${config.maxParallel} parallel · ${config.maxAttempts} attempts`,
        description: "Plan approval, worktrees, commits, retries, and cost limits.",
        submenu: (_current, close) => createSection("execution", close),
      },
      {
        id: "tiers",
        label: "Tier model settings",
        currentValue: `${Object.keys(config.tiers).filter((name) => name !== "review").length} tiers`,
        description: "Primary model, fallback, and thinking level for executor tiers.",
        submenu: (_current, close) => createSection("tiers", close),
      },
      {
        id: "review",
        label: "Review settings",
        currentValue: config.tiers.review?.model ?? "(pi default)",
        description: "Primary model, fallback, and thinking level for adversarial review.",
        submenu: (_current, close) => createSection("review", close),
      },
    ];

    navigation = new SettingsList(
      navigationItems,
      navigationItems.length,
      getSettingsListTheme(),
      () => {},
      () => done(undefined),
      { enableSearch: false }
    );

    const container = new Container();
    const title = ` maestro settings · ${scope} scope → ${configFile(scope, ctx.cwd)}`;
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(
      new Text(
        theme.fg(
          "muted",
          " Changes save immediately. Esc returns to a section, then closes settings."
        ),
        1,
        0
      )
    );

    return {
      render: (width: number) => [...container.render(width), ...navigation.render(width)],
      invalidate: () => {
        container.invalidate();
        navigation.invalidate();
      },
      handleInput: (data: string) => {
        navigation.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function presetDescription(name: string): string {
  if (name === "custom") return "Hand-tuned values. Pick a preset to reset all tiers at once.";
  return findPreset(name)?.description ?? "";
}
