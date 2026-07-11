import { existsSync, readFileSync } from "node:fs";
import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { loadBoard } from "./board.js";
import {
  configFile,
  describeTier,
  loadConfig,
  matchingPreset,
  resolveTierModel,
} from "./config.js";
import { inspectGit, inspectManagedWorktrees } from "./worktree.js";

function inspectConfigFile(scope: "user" | "project", file: string): string {
  if (!existsSync(file)) return `${scope}: ${file} (not present)`;
  try {
    JSON.parse(readFileSync(file, "utf-8"));
    return `${scope}: ${file} (loaded)`;
  } catch {
    return `${scope}: ${file} (INVALID JSON — fix or remove it; maestro normally archives it on load)`;
  }
}

export function buildDoctorReport(
  cwd: string,
  modelRegistry: ModelRegistry,
  preferredModel?: { provider: string; id: string },
  liveTaskIds: ReadonlySet<string> = new Set()
): string {
  const userFile = configFile("user", cwd);
  const projectFile = configFile("project", cwd);
  const configFiles = [
    inspectConfigFile("user", userFile),
    inspectConfigFile("project", projectFile),
  ];
  const config = loadConfig(cwd);
  const git = inspectGit(cwd);
  const lines = [
    "Maestro doctor",
    "",
    "Config (defaults → user → project):",
    ...configFiles.map((file) => `  ${file}`),
    `  effective preset: ${matchingPreset(config)}`,
    `  plan gate: ${config.planGate ? "on" : "off"} · attempts: ${config.maxAttempts} · parallelism: ${config.maxParallel}`,
    `  task cost cap: ${config.maxCostPerTask === 0 ? "off" : `$${config.maxCostPerTask}`} · run cost cap: ${config.maxRunCost === 0 ? "off" : `$${config.maxRunCost}`}`,
    `  worktrees: ${config.useWorktrees ? "on" : "off"} · automatic commits: ${config.autoCommit ? "on" : "off"}`,
    "",
    "Models:",
  ];

  for (const [name, tier] of Object.entries(config.tiers)) {
    lines.push(`  ${name}: ${describeTier(tier)}`);
    const configuredModels = [
      { label: "primary", pattern: tier.model },
      ...(tier.fallbacks ?? []).map((pattern, index) => ({
        label: `fallback ${index + 1}`,
        pattern,
      })),
    ];

    for (const { label, pattern } of configuredModels) {
      if (pattern === undefined) {
        const inherited = preferredModel
          ? `${preferredModel.provider}/${preferredModel.id}`
          : "pi default model (availability determined by pi)";
        lines.push(`    ✓ ${label}: available via ${inherited}`);
        continue;
      }
      if (pattern.length === 0) {
        lines.push(`    ✗ ${label}: unavailable — empty model pattern; fix it in /maestro config.`);
        continue;
      }

      const resolution = resolveTierModel(
        name,
        { model: pattern, thinking: tier.thinking },
        modelRegistry,
        preferredModel?.provider
      );
      if (resolution.ok) {
        lines.push(`    ✓ ${label} "${pattern}": available as ${resolution.modelArg}`);
      } else {
        lines.push(`    ✗ ${label} "${pattern}": unavailable`);
        lines.push(`      ${resolution.error}`);
      }
    }
  }

  lines.push("", "Git/worktrees:", `  ${git.ok ? "✓" : "✗"} ${git.summary}`);
  if (!git.ok && (config.useWorktrees || config.autoCommit)) {
    lines.push("  Initialize and commit the repository, or disable worktrees/automatic commits.");
  }

  if (git.ok) {
    const worktrees = inspectManagedWorktrees(cwd, loadBoard(cwd), liveTaskIds);
    if (worktrees.length === 0) {
      lines.push("  ✓ no managed worktrees need attention");
    } else {
      for (const entry of worktrees) {
        const task = entry.taskId ? ` · ${entry.taskId} attempt ${entry.attemptIndex}` : "";
        const presence = entry.exists ? "" : " · checkout missing";
        lines.push(
          `  ${entry.state}: ${entry.ref.worktreePath}${task}${presence}\n    ${entry.reason}`
        );
      }
      if (worktrees.some((entry) => entry.state === "orphaned" || entry.state === "stale")) {
        lines.push(
          `  Cleanup available: /maestro doctor cleanup (removes only rechecked stale/orphaned entries after confirmation).`
        );
      }
    }
  }
  return lines.join("\n");
}
