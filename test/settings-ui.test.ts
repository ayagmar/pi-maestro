import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionCommandContext,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_CONFIG,
  loadConfig,
  matchingPreset,
  setProjectConfigTrust,
  saveConfig,
  validateEffectiveConfig,
} from "../src/config.js";
import {
  applySettingsChange,
  buildModelChoices,
  buildModelPickerChoices,
  filterModelChoices,
  presetDrift,
  showSettings,
  watchdogSummary,
} from "../src/settings-ui.js";

initTheme();
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

function registryWithModels(
  models: Array<{ provider: string; id: string }>
): ExtensionCommandContext["modelRegistry"] {
  return {
    getAvailable: () => models,
  } as unknown as ExtensionCommandContext["modelRegistry"];
}

test("settings model choices display provider-qualified authenticated models", () => {
  const choices = buildModelChoices(
    registryWithModels([
      { provider: "provider-b", id: "zeta" },
      { provider: "provider-a", id: "alpha" },
      { provider: "provider-c", id: "zeta" },
      { provider: "provider-b", id: "zeta" },
    ])
  );

  assert.deepEqual(choices.model, [
    "(pi default)",
    "provider-a/alpha",
    "provider-b/zeta",
    "provider-c/zeta",
  ]);
  assert.deepEqual(choices.fallback, [
    "(none)",
    "provider-a/alpha",
    "provider-b/zeta",
    "provider-c/zeta",
  ]);
});

test("settings model filtering matches provider, model id, and sentinels", () => {
  const choices = ["(pi default)", "anthropic/claude-sonnet-5", "openai/gpt-5.6-sol"];

  assert.deepEqual(filterModelChoices(choices, "claude"), ["anthropic/claude-sonnet-5"]);
  assert.deepEqual(filterModelChoices(choices, "OPENAI"), ["openai/gpt-5.6-sol"]);
  assert.deepEqual(filterModelChoices(choices, "default"), ["(pi default)"]);
  assert.deepEqual(filterModelChoices(choices, ""), choices);
});

test("picker selects bare primary and fallback values without qualifying them", () => {
  const registry = registryWithModels([
    { provider: "openai", id: "gpt-5.6-sol" },
    { provider: "proxy", id: "gpt-5.6-sol" },
    { provider: "anthropic", id: "claude-sonnet-5" },
  ]);
  const choices = buildModelChoices(registry);

  const standard = { model: "gpt-5.6-sol", thinking: "medium", fallbacks: ["claude-sonnet-5"] };

  const primaryItems = buildModelPickerChoices(registry, choices.model, standard.model, "openai");
  const fallbackItems = buildModelPickerChoices(
    registry,
    choices.fallback,
    standard.fallbacks[0] as string,
    "openai"
  );

  assert.deepEqual(
    primaryItems.find((item) => item.value === standard.model),
    {
      value: "gpt-5.6-sol",
      label: "openai/gpt-5.6-sol",
    }
  );
  assert.deepEqual(
    fallbackItems.find((item) => item.value === standard.fallbacks?.[0]),
    {
      value: "claude-sonnet-5",
      label: "anthropic/claude-sonnet-5",
    }
  );
  assert.equal(primaryItems.filter((item) => item.label === "openai/gpt-5.6-sol").length, 1);
  assert.ok(primaryItems.some((item) => item.value === "proxy/gpt-5.6-sol"));

  const config = structuredClone(DEFAULT_CONFIG);
  applySettingsChange(config, "model:standard", standard.model);
  applySettingsChange(config, "fallback:standard", standard.fallbacks[0] as string);
  assert.equal(config.tiers.standard?.model, "gpt-5.6-sol");
  assert.equal(config.tiers.standard?.fallbacks?.[0], "claude-sonnet-5");
});

test("picker marks the exact model a bare pattern resolves to, not a longer variant", () => {
  const registry = registryWithModels([
    { provider: "openai", id: "gpt-5.6-sol-mini" },
    { provider: "openai", id: "gpt-5.6-sol" },
  ]);
  const items = buildModelPickerChoices(registry, buildModelChoices(registry).model, "gpt-5.6-sol");
  assert.deepEqual(
    items.find((item) => item.value === "gpt-5.6-sol"),
    { value: "gpt-5.6-sol", label: "openai/gpt-5.6-sol" }
  );
  assert.ok(items.some((item) => item.value === "openai/gpt-5.6-sol-mini"));
});

test("settings model choices retain static menus when no authenticated models are available", () => {
  const choices = buildModelChoices(registryWithModels([]));

  assert.deepEqual(choices.model, [
    "(pi default)",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "claude-haiku-4-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-fable-5",
  ]);
  assert.deepEqual(choices.fallback, [
    "(none)",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ]);
});

test("settings model search owns focus only while its picker is active", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-settings-focus-"));
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const context = {
    cwd,
    modelRegistry: registryWithModels([{ provider: "openai", id: "gpt-test" }]),
    ui: {
      notify: () => {},
      custom: async (factory: (...args: unknown[]) => unknown) => {
        const component = factory({ requestRender: () => {} }, theme, keybindings, () => {}) as {
          focused: boolean;
          render(width: number): string[];
          handleInput(data: string): void;
        };
        component.focused = true;
        // Open the tier section, whose first row is a model picker. Its index
        // is derived from the rendered menu so reorganising sections cannot
        // silently retarget this focus test at some other control.
        const menu = component.render(100).join("\n").split("\n");
        const tierRow = menu.findIndex((line) => line.includes("Tier model settings"));
        const firstRow = menu.findIndex((line) => line.includes("Essentials"));
        assert.ok(tierRow > 0 && firstRow > 0, "the tier section must appear in the menu");
        for (let step = 0; step < tierRow - firstRow; step += 1) component.handleInput("\x1b[B");
        component.handleInput("\r");
        component.handleInput("\r");

        assert.ok(component.render(100).join("\n").includes(CURSOR_MARKER));
        component.focused = false;
        assert.ok(!component.render(100).join("\n").includes(CURSOR_MARKER));
        component.focused = true;
        assert.ok(component.render(100).join("\n").includes(CURSOR_MARKER));

        component.handleInput("\x1b");
        assert.ok(!component.render(100).join("\n").includes(CURSOR_MARKER));
      },
    },
  } as unknown as ExtensionCommandContext;

  try {
    await showSettings(context, "project");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the model picker selects with a remapped confirm key", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-settings-remap-"));
  // pi installs the user's keybindings globally and injects the same manager.
  const remapped = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.confirm": "ctrl+g",
    "tui.select.cancel": "ctrl+q",
  });
  setKeybindings(remapped);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const context = {
    cwd,
    modelRegistry: registryWithModels([{ provider: "openai", id: "gpt-test" }]),
    ui: {
      notify: () => {},
      custom: async (factory: (...args: unknown[]) => unknown) => {
        const component = factory({ requestRender: () => {} }, theme, remapped, () => {}) as {
          focused: boolean;
          render(width: number): string[];
          handleInput(data: string): void;
        };
        component.focused = true;
        const menu = component.render(100).join("\n").split("\n");
        const tierRow = menu.findIndex((line) => line.includes("Tier model settings"));
        const firstRow = menu.findIndex((line) => line.includes("Essentials"));
        for (let step = 0; step < tierRow - firstRow; step += 1) component.handleInput("\x1b[B");
        component.handleInput("\x07");
        component.handleInput("\x07");
        const picker = stripVTControlCharacters(component.render(100).join("\n"));
        assert.match(picker, /ctrl\+g select/);
        assert.match(picker, /ctrl\+q back/);
        assert.match(picker, /ctrl\+q returns to a section/);
        // "(pi default)" is current; move to the authenticated model and pick it.
        component.handleInput("\x1b[B");
        component.handleInput("\x07");
      },
    },
  } as unknown as ExtensionCommandContext;

  try {
    await showSettings(context, "project");
    const models = Object.values(loadConfig(cwd).tiers).map((tier) => tier.model);
    assert.ok(models.includes("openai/gpt-test"), `no tier took the model: ${models.join(", ")}`);
  } finally {
    setKeybindings(keybindings);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("section summaries keep their full text after a setting changes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-settings-summary-"));
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const context = {
    cwd,
    modelRegistry: registryWithModels([{ provider: "openai", id: "gpt-test" }]),
    ui: {
      notify: () => {},
      custom: async (factory: (...args: unknown[]) => unknown) => {
        const component = factory({ requestRender: () => {} }, theme, keybindings, () => {}) as {
          focused: boolean;
          render(width: number): string[];
          handleInput(data: string): void;
        };
        component.focused = true;
        const row = (label: string) =>
          component
            .render(160)
            .join("\n")
            .split("\n")
            .find((line) => line.includes(label)) ?? "";
        assert.match(row("Essentials"), /3 at a time · \$25 cap/);
        assert.match(row("Review"), /single · /);

        // Essentials → "Max parallel executors" (second row) → cycle 3 → 4.
        component.handleInput("\r");
        component.handleInput("\x1b[B");
        setProjectConfigTrust(false);
        try {
          component.handleInput("\r");
          assert.match(
            stripVTControlCharacters(row("Max parallel executors")),
            /\b3\b/,
            "refused edit must restore the displayed value"
          );
          assert.equal(existsSync(join(cwd, ".pi", "maestro.json")), false);
        } finally {
          setProjectConfigTrust(true);
        }
        component.handleInput("\r");
        component.handleInput("\x1b");

        assert.match(row("Essentials"), /4 at a time · \$25 cap/);
        assert.match(row("Review"), /single · /);
      },
    },
  } as unknown as ExtensionCommandContext;

  try {
    await showSettings(context, "project");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("model picker changes preserve qualified values, sentinels, and fallback chains", () => {
  let config = structuredClone(DEFAULT_CONFIG);
  const standard = config.tiers.standard;
  assert.ok(standard);
  standard.fallbacks = ["old-primary", "provider-c/last-resort"];

  config = applySettingsChange(config, "model:standard", "provider-a/shared-id");
  config = applySettingsChange(config, "fallback:standard", "provider-b/shared-id");
  assert.equal(config.tiers.standard?.model, "provider-a/shared-id");
  assert.deepEqual(config.tiers.standard?.fallbacks, [
    "provider-b/shared-id",
    "provider-c/last-resort",
  ]);

  config = applySettingsChange(config, "model:standard", "(pi default)");
  config = applySettingsChange(config, "fallback:standard", "(none)");
  assert.equal(config.tiers.standard?.model, undefined);
  assert.deepEqual(config.tiers.standard?.fallbacks, ["provider-c/last-resort"]);
});

test("switching executor presets keeps the selected trusted verification profile and its command", () => {
  const config = {
    ...DEFAULT_CONFIG,
    verificationProfiles: { unit: { command: "npm test", timeoutSeconds: 60 } },
    defaultVerificationProfile: "unit",
  };
  const next = applySettingsChange(config, "preset", "inherit");
  assert.equal(matchingPreset(next), "inherit");
  assert.equal(presetDrift(next), undefined);
  assert.equal(next.defaultVerificationProfile, "unit");
  assert.deepEqual(next.verificationProfiles, config.verificationProfiles);
});

test("the review ladder settings round-trip through applySettingsChange", () => {
  let config = structuredClone(DEFAULT_CONFIG);
  assert.equal(config.reviewEscalation, "risk");
  assert.equal(config.reviewCheapModel, undefined);

  config = applySettingsChange(config, "reviewCheapModel", "anthropic/claude-haiku-4-5");
  config = applySettingsChange(config, "reviewEscalation", "doubt");
  assert.equal(config.reviewCheapModel, "anthropic/claude-haiku-4-5");
  assert.equal(config.reviewEscalation, "doubt");

  // "(none)" switches the ladder off rather than naming a model.
  config = applySettingsChange(config, "reviewCheapModel", "(none)");
  assert.equal(config.reviewCheapModel, undefined);
});

test("watchdog and logging settings round-trip through applySettingsChange", () => {
  let config = structuredClone(DEFAULT_CONFIG);
  config = applySettingsChange(config, "watchdogIdleSeconds", "300");
  assert.equal(config.watchdogIdleSeconds, 300);
  config = applySettingsChange(config, "watchdogIdleSeconds", "off");
  assert.equal(config.watchdogIdleSeconds, 0);
  config = applySettingsChange(config, "watchdogWarningTurns", "24");
  assert.equal(config.watchdogWarningTurns, 24);
  config = applySettingsChange(config, "watchdogWarningTurns", "off");
  assert.equal(config.watchdogWarningTurns, 0);
  config = applySettingsChange(config, "watchdogTerminationTurns", "8");
  assert.equal(config.watchdogTerminationTurns, 8);
  config = applySettingsChange(config, "handoffContextRatio", "80%");
  assert.equal(config.handoffContextRatio, 0.8);
  config = applySettingsChange(config, "handoffContextRatio", "off");
  assert.equal(config.handoffContextRatio, 0);
  config = applySettingsChange(config, "logEvents", "full");
  assert.equal(config.logEvents, "full");
  config = applySettingsChange(config, "maxLogBytesPerRun", "10MB");
  assert.equal(config.maxLogBytesPerRun, 10_000_000);
  config = applySettingsChange(config, "maxLogBytesPerRun", "unlimited");
  assert.equal(config.maxLogBytesPerRun, 0);
  // Every value produced above passes effective-config validation.
  assert.equal(validateEffectiveConfig(config), undefined);
});

test("pushOnIntegration toggles through settings and preset drift names the changed fields", () => {
  let config = structuredClone(DEFAULT_CONFIG);
  assert.equal(presetDrift(config), undefined); // exact preset match
  config = applySettingsChange(config, "pushOnIntegration", "on");
  assert.equal(config.pushOnIntegration, true);
  config = applySettingsChange(config, "maxRunCost", "$300");
  const drift = presetDrift(config);
  assert.ok(drift, "a hand-tuned config must name its drift");
  assert.match(drift ?? "", /closest inherit/);
  assert.match(drift ?? "", /pushOnIntegration/);
  assert.match(drift ?? "", /maxRunCost/);
});

test("watchdog summary names disabled guards instead of hiding them", () => {
  assert.equal(
    watchdogSummary(structuredClone(DEFAULT_CONFIG)),
    "120s idle→steer · 12 turns→steer · handoff at 68%"
  );
  assert.equal(
    watchdogSummary({
      ...structuredClone(DEFAULT_CONFIG),
      watchdogIdleSeconds: 0,
      watchdogWarningTurns: 0,
      handoffContextRatio: 0,
    }),
    "idle watch off · turn watch off · auto-handoff off"
  );
});

test("settings cannot persist an impossible effective review configuration", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-settings-invalid-"));
  try {
    let config = structuredClone(DEFAULT_CONFIG);
    config = applySettingsChange(config, "reviewRequiredApprovals", "8");
    config = applySettingsChange(config, "maxReviewerLaunches", "4");

    assert.equal(config.reviewRequiredApprovals, 8);
    assert.equal(config.maxReviewerLaunches, 4);
    assert.throws(
      () => saveConfig("project", cwd, config),
      /reviewRequiredApprovals \(8\).*maxReviewerLaunches \(4\)/
    );
    assert.equal(existsSync(join(cwd, ".pi", "maestro.json")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("settings changes preserve existing values and persist provider-qualified selections", () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-settings-"));
  try {
    let config = structuredClone(DEFAULT_CONFIG);
    config = applySettingsChange(config, "planGate", "on");
    config = applySettingsChange(config, "livePanes", "off");
    config = applySettingsChange(config, "maxParallel", "6");
    config = applySettingsChange(config, "maxCostPerTask", "$5");
    config = applySettingsChange(config, "statusWaitSeconds", "30");
    config = applySettingsChange(config, "cleanupCompletedTasks", "off");
    config = applySettingsChange(config, "reviewRequiredApprovals", "3");
    config = applySettingsChange(config, "maxReviewerLaunches", "3");
    config = applySettingsChange(config, "model:complex", "anthropic/claude-sonnet-5");
    saveConfig("project", cwd, config);

    const persisted = JSON.parse(readFileSync(join(cwd, ".pi", "maestro.json"), "utf-8"));
    assert.equal(persisted.planGate, true);
    assert.equal(persisted.livePanes, false);
    assert.equal(persisted.maxParallel, 6);
    assert.equal(persisted.maxCostPerTask, 5);
    assert.equal(persisted.statusWaitSeconds, 30);
    assert.equal(persisted.cleanupCompletedTasks, false);
    assert.equal(persisted.reviewRequiredApprovals, 3);
    assert.equal(persisted.maxReviewerLaunches, 3);
    assert.equal(persisted.autoCommit, DEFAULT_CONFIG.autoCommit);
    assert.equal(persisted.tiers.complex.model, "anthropic/claude-sonnet-5");
    assert.equal(persisted.tiers.review.tools, DEFAULT_CONFIG.tiers.review?.tools);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("user settings flag rows a trusted project overrides, and keep editing the user value", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-settings-override-"));
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-settings-override-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const userFile = join(agentDir, "maestro.json");
  const projectFile = join(cwd, ".pi", "maestro.json");
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;

  type Component = {
    focused: boolean;
    render(width: number): string[];
    handleInput(data: string): void;
  };
  const open = async (inspect: (component: Component) => void) => {
    const context = {
      cwd,
      modelRegistry: registryWithModels([]),
      ui: {
        notify: () => {},
        custom: async (factory: (...args: unknown[]) => unknown) => {
          const component = factory(
            { requestRender: () => {} },
            theme,
            keybindings,
            () => {}
          ) as Component;
          component.focused = true;
          inspect(component);
        },
      },
    } as unknown as ExtensionCommandContext;
    await showSettings(context, "user");
  };
  const screen = (component: Component) =>
    stripVTControlCharacters(component.render(160).join("\n"));

  try {
    saveConfig("user", cwd, { ...DEFAULT_CONFIG, maxRunCost: 10 });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({ maxRunCost: 200 }));

    await open((component) => {
      // The menu says a section has overrides before it is opened.
      assert.match(screen(component), /Essentials.*1 overridden by project/);
      assert.doesNotMatch(screen(component), /Safety limits.*overridden/);

      component.handleInput("\r");
      component.handleInput("\x1b[B");
      component.handleInput("\x1b[B");
      const row = screen(component);
      assert.match(row, /Run cost cap \(USD\) · project: \$200\s+\$10/);
      assert.match(row, /runs here use \$200, not your user value \$10/);

      // Cycling edits the user value; the project value stays on display.
      component.handleInput("\r");
      assert.match(screen(component), /Run cost cap \(USD\) · project: \$200\s+\$5/);
    });
    assert.equal(JSON.parse(readFileSync(userFile, "utf8")).maxRunCost, 5);
    assert.deepEqual(JSON.parse(readFileSync(projectFile, "utf8")), { maxRunCost: 200 });
    assert.equal(loadConfig(cwd).maxRunCost, 200);

    // An untrusted project is not read, so it cannot be advertised either.
    setProjectConfigTrust(false);
    try {
      await open((component) => {
        assert.doesNotMatch(screen(component), /overridden by project/);
      });
    } finally {
      setProjectConfigTrust(true);
    }

    // Rendering never moves a damaged project file aside.
    writeFileSync(projectFile, "{unfinished");
    await open((component) => {
      assert.doesNotMatch(screen(component), /overridden by project/);
      component.handleInput("\r");
      assert.doesNotMatch(screen(component), /project:/);
    });
    assert.equal(readFileSync(projectFile, "utf8"), "{unfinished");
    assert.deepEqual(
      readdirSync(join(cwd, ".pi")),
      ["maestro.json"],
      "the damaged file must stay put for the owner to fix"
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
