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
  validateEffectiveConfig,
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
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
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

export interface ModelPickerChoice {
  value: string;
  label: string;
}

/**
 * Keep a bare model pattern selected while showing the authenticated model it
 * currently resolves to. The stored value stays bare, preserving provider
 * preference during execution.
 */
export function buildModelPickerChoices(
  modelRegistry: ExtensionCommandContext["modelRegistry"],
  choices: string[],
  currentValue: string,
  preferredProvider?: string
): ModelPickerChoice[] {
  const items = choices.map((choice) => ({ value: choice, label: choice }));
  if (currentValue.startsWith("(") || currentValue.includes("/")) return items;

  const pattern = currentValue.toLowerCase();
  const candidates = modelRegistry
    .getAvailable()
    .filter((model) => model.id.toLowerCase().includes(pattern));
  const preferred = preferredProvider
    ? candidates.find((model) => model.provider === preferredProvider)
    : undefined;
  const selected = preferred ?? candidates[0];
  if (!selected) return items;

  const qualifiedValue = `${selected.provider}/${selected.id}`;
  const selectedItem = items.find((item) => item.value === qualifiedValue);
  if (selectedItem) selectedItem.value = currentValue;
  return items;
}

function displayModelValue(
  modelRegistry: ExtensionCommandContext["modelRegistry"],
  choices: string[],
  currentValue: string,
  preferredProvider?: string
): string {
  return (
    buildModelPickerChoices(modelRegistry, choices, currentValue, preferredProvider).find(
      (choice) => choice.value === currentValue
    )?.label ?? currentValue
  );
}

function tierDescription(name: string): string {
  return TIER_DESCRIPTIONS[name] ?? "Custom tier.";
}

/** Apply one UI setting to a resolved config. Presets replace the full config. */
/**
 * Section summaries are the only thing visible without opening a section, so
 * they state what a drive will actually do and call out the settings that
 * spend money or switch a safety net off.
 */
export function essentialsSummary(config: MaestroConfig): string {
  const parts = [matchingPreset(config), `${config.maxParallel} at a time`];
  parts.push(config.maxRunCost === 0 ? "no spend cap" : `$${config.maxRunCost} cap`);
  if (config.planGate) parts.push("plans need approval");
  if (!config.autoCommit) parts.push("no auto-commit");
  return parts.join(" · ");
}

export function executionSummary(config: MaestroConfig): string {
  const parts = [config.useWorktrees ? "isolated checkouts" : "shared checkout"];
  if (config.detachedExecutors) parts.push("survives exit");
  if (config.livePanes) parts.push("live panes");
  if (config.cleanupCompletedTasks === false) parts.push("board kept");
  return parts.join(" · ");
}

export function limitsSummary(config: MaestroConfig): string {
  const off: string[] = [];
  if (config.maxCostPerTask === 0) off.push("attempt cost");
  if (config.maxRunCost === 0) off.push("run cost");
  // Silence is the wrong signal when a guard has been switched off.
  if (off.length > 0) return `${off.join(" and ")} cap off`;
  return `$${config.maxCostPerTask}/attempt · ${config.maxAttempts} tries · ${config.maxTotalLaunchesPerRun} launches`;
}

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
  else if (id === "livePanes") config.livePanes = value === "on";
  else if (id === "maxParallel") config.maxParallel = Number(value);
  else if (id === "useWorktrees") config.useWorktrees = value === "on";
  else if (id === "detachedExecutors") config.detachedExecutors = value === "on";
  else if (id === "retryContext") config.retryContext = value === "fresh" ? "fresh" : "resume";
  else if (id === "autoCommit") config.autoCommit = value === "on";
  else if (id === "cleanupCompletedTasks") config.cleanupCompletedTasks = value === "on";
  else if (id === "maxAttempts") config.maxAttempts = Number(value);
  else if (id === "maxPlanTasks") config.maxPlanTasks = Number(value);
  else if (id === "maxDiscoveryGeneratedTasks") {
    config.maxDiscoveryGeneratedTasks = Number(value);
  } else if (id === "maxTotalLaunchesPerRun") {
    config.maxTotalLaunchesPerRun = Number(value);
  } else if (id === "confirmationPlanTasks") {
    config.confirmationPlanTasks = Number(value);
  } else if (id === "confirmationTotalLaunches") {
    config.confirmationTotalLaunches = Number(value);
  } else if (id === "reviewPolicy") {
    config.reviewPolicy = value as MaestroConfig["reviewPolicy"];
  } else if (id === "reviewRequiredApprovals") {
    config.reviewRequiredApprovals = Number(value);
  } else if (id === "maxReviewerLaunches") {
    config.maxReviewerLaunches = Number(value);
  } else if (id === "maxCostPerTask") {
    config.maxCostPerTask = value === "off" ? 0 : Number(value.slice(1));
  } else if (id === "maxCostPerReview") {
    config.maxCostPerReview = value === "inherit" ? 0 : Number(value.slice(1));
  } else if (id === "reviewRejectionLimit") {
    config.reviewRejectionLimit = Number(value);
  } else if (id === "maxRunCost") {
    config.maxRunCost = value === "off" ? 0 : Number(value.slice(1));
  } else if (id === "statusWaitSeconds") {
    config.statusWaitSeconds = Number(value);
  } else if (id === "decisionNudgeMinutes") {
    config.decisionNudgeMinutes = value === "off" ? 0 : Number(value);
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
  const preferredProvider = ctx.model?.provider;
  const persist = () => saveConfig(scope, ctx.cwd, config);

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let settingsFocused = false;
    let activeModelInput: Input | undefined;
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
      const pickerChoices = buildModelPickerChoices(
        ctx.modelRegistry,
        choices,
        currentValue,
        preferredProvider
      );
      const input = new Input();
      activeModelInput = input;
      input.focused = settingsFocused;
      const finish = (selectedValue?: string) => {
        input.focused = false;
        if (activeModelInput === input) activeModelInput = undefined;
        close(selectedValue);
      };
      const titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
      const searchLabel = new Text(theme.fg("muted", " Search by provider or model id:"), 0, 0);
      const hint = new Text(
        theme.fg("dim", " ↑↓ navigate · type to filter · enter select · esc back"),
        0,
        0
      );
      let list: SelectList;

      const rebuildList = () => {
        const matchingLabels = new Set(
          filterModelChoices(
            pickerChoices.map((choice) => choice.label),
            input.getValue()
          )
        );
        const items: SelectItem[] = pickerChoices
          .filter((choice) => matchingLabels.has(choice.label))
          .map((choice) => {
            const item: SelectItem = { ...choice };
            if (choice.value === "(pi default)") {
              item.description = "Inherit the model selected in pi";
            }
            if (choice.value === "(none)") item.description = "Do not configure a fallback";
            return item;
          });
        list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), pickerTheme);
        const currentIndex = items.findIndex((item) => item.value === currentValue);
        if (!input.getValue() && currentIndex >= 0) list.setSelectedIndex(currentIndex);
        list.onSelect = (item) => finish(item.value);
        list.onCancel = () => finish();
      };
      rebuildList();

      return {
        get focused() {
          return input.focused;
        },
        set focused(value: boolean) {
          input.focused = value;
        },
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
        const primary = tier.model ?? "(pi default)";
        const fallback = tier.fallbacks?.[0] ?? "(none)";
        items.push({
          id: `model:${name}`,
          label: `${name} · model`,
          currentValue: displayModelValue(
            ctx.modelRegistry,
            modelChoices.model,
            primary,
            preferredProvider
          ),
          description: `${tierDescription(name)} Choose an authenticated provider/model, or inherit pi's model.`,
          submenu: (_current, close) =>
            createModelPicker(`${name} primary model`, modelChoices.model, primary, close),
        });
        items.push({
          id: `fallback:${name}`,
          label: `${name} · fallback`,
          currentValue: displayModelValue(
            ctx.modelRegistry,
            modelChoices.fallback,
            fallback,
            preferredProvider
          ),
          description: `First model tried after the ${name} primary fails. Deeper fallbacks remain unchanged.`,
          submenu: (_current, close) =>
            createModelPicker(`${name} fallback model`, modelChoices.fallback, fallback, close),
        });
        items.push({
          id: `thinking:${name}`,
          label: `${name} · thinking`,
          currentValue: tier.thinking,
          values: [...THINKING_LEVELS],
          description:
            tier.thinking === "max"
              ? `max reasoning for ${name}. The slowest and most expensive level; use it for work that genuinely stalls at xhigh.`
              : `Reasoning effort for ${name} executors. Start medium and raise only when quality requires it. The ladder tops out at max.`,
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
          {
            id: "maxRunCost",
            label: "Run cost cap (USD)",
            currentValue: config.maxRunCost === 0 ? "off" : `$${config.maxRunCost}`,
            values: ["off", "$5", "$10", "$25", "$50"],
            description: "Stop starting new executors after the board exceeds this cost.",
          },
          {
            id: "planGate",
            label: "Approve plans before running",
            currentValue: config.planGate ? "on" : "off",
            values: ["off", "on"],
            description: "Pause newly planned tasks until you approve them with /maestro plan.",
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
        ];
      }
      if (section === "execution") {
        return [
          {
            id: "livePanes",
            label: "Auto-open passive agent pane",
            currentValue: config.livePanes ? "on" : "off",
            values: ["off", "on"],
            description:
              "Optional. Agent sessions are always available from /maestro agents and the control center.",
          },
          {
            id: "useWorktrees",
            label: "Parallel git worktrees",
            currentValue: config.useWorktrees ? "on" : "off",
            values: ["off", "on"],
            description: "Isolate tasks in a parallel batch in separate git worktrees.",
          },
          {
            id: "detachedExecutors",
            label: "Detached executor survivability",
            currentValue: (config.detachedExecutors ?? false) ? "on" : "off",
            values: ["off", "on"],
            description: "Unix only. Keep isolated executor RPC processes alive across Pi exits.",
          },
          {
            id: "retryContext",
            label: "Rejection retry context",
            currentValue: config.retryContext ?? "resume",
            values: ["resume", "fresh"],
            description:
              "resume continues the rejected attempt's session (cached history, no re-reading); fresh restarts every attempt with a clean context.",
          },
          {
            id: "cleanupCompletedTasks",
            label: "Clear completed live board",
            currentValue: (config.cleanupCompletedTasks ?? true) ? "on" : "off",
            values: ["on", "off"],
            description: "Archive and remove live tasks after a drive completes successfully.",
          },
          {
            id: "statusWaitSeconds",
            label: "Progress pulse interval",
            currentValue: `${config.statusWaitSeconds}`,
            values: ["15", "30", "60", "90", "120", "180"],
            description:
              "Seconds the human status command waits before returning live executor progress.",
          },
          {
            id: "decisionNudgeMinutes",
            label: "Decision reminder (minutes)",
            currentValue:
              (config.decisionNudgeMinutes ?? 5) === 0
                ? "off"
                : `${config.decisionNudgeMinutes ?? 5}`,
            values: ["off", "3", "5", "10", "20"],
            description:
              "Re-nudge the owner session when a delivered decision sits unresolved with no board activity.",
          },
        ];
      }
      if (section === "limits") {
        return [
          {
            id: "maxPlanTasks",
            label: "Maximum plan tasks",
            currentValue: String(config.maxPlanTasks),
            values: ["16", "24", "32", "64", "128", "256", "512"],
            description: "Hard task-count limit at every plan mutation boundary.",
          },
          {
            id: "maxDiscoveryGeneratedTasks",
            label: "Maximum discovery tasks",
            currentValue: String(config.maxDiscoveryGeneratedTasks),
            values: ["8", "16", "32", "64", "128"],
            description: "Hard generated-task limit for one discovery result.",
          },
          {
            id: "maxTotalLaunchesPerRun",
            label: "Maximum launches per drive",
            currentValue: String(config.maxTotalLaunchesPerRun),
            values: ["32", "64", "128", "256", "512", "1024"],
            description: "Hard combined executor and reviewer process-launch limit.",
          },
          {
            id: "confirmationPlanTasks",
            label: "Task confirmation threshold",
            currentValue: String(config.confirmationPlanTasks),
            values: ["8", "16", "24", "32", "64", "128"],
            description: "Plans above this task count require explicit confirmation.",
          },
          {
            id: "confirmationTotalLaunches",
            label: "Launch confirmation threshold",
            currentValue: String(config.confirmationTotalLaunches),
            values: ["16", "32", "64", "128", "256", "512"],
            description: "Raw launch upper bounds above this value require confirmation.",
          },
          {
            id: "maxCostPerTask",
            label: "Cost cap per attempt (USD)",
            currentValue: config.maxCostPerTask === 0 ? "off" : `$${config.maxCostPerTask}`,
            values: ["off", "$1", "$2", "$5", "$10"],
            description: "Abort one executor attempt after it exceeds this cost.",
          },
        ];
      }
      if (section === "tiers") {
        return modelItems(Object.keys(config.tiers).filter((name) => name !== "review"));
      }
      return [
        {
          id: "reviewPolicy",
          label: "Review policy for new tasks",
          currentValue: config.reviewPolicy ?? "single",
          values: ["single", "confirm", "find-and-refute"],
          description:
            config.reviewPolicy === "confirm"
              ? `confirm: ${config.reviewRequiredApprovals ?? 2} independent reviewers must agree. Thorough, and the most expensive.`
              : config.reviewPolicy === "find-and-refute"
                ? "find-and-refute: one reviewer hunts for problems, a second tries to disprove them. Costly; reserve for risky work."
                : "single: one reviewer per attempt. Cheapest, and enough for most tasks. Raise it per task in /maestro plan.",
        },
        {
          id: "reviewRequiredApprovals",
          label: "Required confirming approvals",
          currentValue:
            config.reviewPolicy === "confirm"
              ? String(config.reviewRequiredApprovals ?? 2)
              : `${config.reviewRequiredApprovals ?? 2} (unused)`,
          values: ["2", "3", "4"],
          description:
            config.reviewPolicy === "confirm"
              ? "Independent approvals required before a task is approved."
              : "Only applies to tasks using the confirm policy.",
        },
        {
          id: "maxReviewerLaunches",
          label: "Maximum reviewer launches",
          currentValue: String(config.maxReviewerLaunches ?? 4),
          values: ["2", "3", "4", "6", "8"],
          description: "Hard bound including provider fallbacks for one review attempt.",
        },
        {
          id: "maxCostPerReview",
          label: "Cost cap per reviewer launch (USD)",
          currentValue: !config.maxCostPerReview ? "inherit" : `$${config.maxCostPerReview}`,
          values: ["inherit", "$1", "$2", "$5", "$10"],
          description:
            "Abort one reviewer launch after it exceeds this cost. Inherit uses the per-attempt cap.",
        },
        {
          id: "reviewRejectionLimit",
          label: "Rejections before escalation",
          currentValue: String(config.reviewRejectionLimit ?? 2),
          values: ["1", "2", "3", "4"],
          description:
            "Consecutive genuine reviewer rejections before a task escalates instead of retrying.",
        },
        ...modelItems(config.tiers.review ? ["review"] : []),
      ];
    };

    let navigation: SettingsList;
    const updateNavigationValues = () => {
      navigation.updateValue("general", matchingPreset(config));
      navigation.updateValue(
        "general",
        `${matchingPreset(config)} · ${config.maxParallel} parallel`
      );
      navigation.updateValue(
        "execution",
        config.useWorktrees ? "isolated checkouts" : "shared checkout"
      );
      navigation.updateValue(
        "tiers",
        `${Object.keys(config.tiers).filter((name) => name !== "review").length} tiers`
      );
      const reviewModel = config.tiers.review?.model ?? "(pi default)";
      navigation.updateValue(
        "review",
        displayModelValue(ctx.modelRegistry, modelChoices.model, reviewModel, preferredProvider)
      );
    };

    const createSection = (section: string, close: (selectedValue?: string) => void) => {
      let items = buildSectionItems(section);
      const list = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (id, value) => {
          const updated = applySettingsChange(structuredClone(config), id, value);
          const error = validateEffectiveConfig(updated);
          if (error) {
            ctx.ui.notify(`Setting not saved: ${error}`, "warning");
            return;
          }
          config = updated;
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
        label: "Essentials",
        currentValue: essentialsSummary(config),
        description: "Models, how much runs at once, and how much it may spend.",
        submenu: (_current, close) => createSection("general", close),
      },
      {
        id: "execution",
        label: "How work runs",
        currentValue: executionSummary(config),
        description: "Isolation, live panes, and what happens after a drive finishes.",
        submenu: (_current, close) => createSection("execution", close),
      },
      {
        id: "limits",
        label: "Safety limits",
        currentValue: limitsSummary(config),
        description: "Runaway guards. Leave these alone until a real run trips one.",
        submenu: (_current, close) => createSection("limits", close),
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
        label: "Review",
        currentValue: `${config.reviewPolicy ?? "single"} · ${displayModelValue(
          ctx.modelRegistry,
          modelChoices.model,
          config.tiers.review?.model ?? "(pi default)",
          preferredProvider
        )}`,
        description: "How hard new tasks are reviewed, and which model does it.",
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
      get focused() {
        return settingsFocused;
      },
      set focused(value: boolean) {
        settingsFocused = value;
        if (activeModelInput) activeModelInput.focused = value;
      },
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
