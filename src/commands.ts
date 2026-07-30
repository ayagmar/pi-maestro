import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem } from "@earendil-works/pi-tui";
import { COMMAND } from "./constants.js";

/**
 * Subcommands offered before the user has typed anything. One entry per
 * action: aliases and nested leaves are deliberately absent so the first list
 * a newcomer sees is short enough to read.
 */
export const MAESTRO_COMMANDS = [
  "start",
  "handoff",
  "back",
  "drive",
  "retry",
  "pause",
  "resume",
  "abort",
  "agents",
  "board",
  "plan",
  "recipe",
  "costs",
  "insights",
  "simulate",
  "discover",
  "open",
  "config",
  "doctor",
  "history",
  "timeline",
  "workflows",
  "reconcile",
  "replay",
  "reset",
] as const;

/** Leaves revealed once the parent noun has been typed. */
const NESTED_COMMANDS: Record<string, string[]> = {
  plan: ["export", "import", "diff"],
  recipe: ["list", "inspect", "preview", "save", "run", "remove"],
  config: ["project", "show", "budget"],
  doctor: ["cleanup"],
  reset: ["confirm"],
};

/** Aliases that keep working but do not compete for space in the menu. */
export const MAESTRO_COMMAND_ALIASES = ["dash", "dashboard"] as const;

function completionsFor(prefix: string): AutocompleteItem[] {
  const lower = prefix.toLowerCase();
  const [parent, ...typed] = lower.split(/\s+/);
  const nested = parent ? NESTED_COMMANDS[parent] : undefined;
  // Once a parent noun is complete, offer its leaves instead of re-listing
  // every top-level command.
  if (nested && lower.startsWith(`${parent} `)) {
    const leafPrefix = typed.join(" ");
    return nested
      .filter((leaf) => leaf.startsWith(leafPrefix))
      .map((leaf) => ({ value: `${parent} ${leaf}`, label: `${parent} ${leaf}` }));
  }
  return MAESTRO_COMMANDS.filter((command) => command.startsWith(lower)).map((command) => ({
    value: command,
    label: NESTED_COMMANDS[command] ? `${command} …` : command,
  }));
}

export function registerMaestroCommand(
  pi: ExtensionAPI,
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  dynamicCompletions?: (prefix: string) => AutocompleteItem[]
): void {
  pi.registerCommand(COMMAND, {
    description: "Plan, delegate, review, and monitor work across fresh executor contexts",
    getArgumentCompletions: (prefix) => {
      const matches = completionsFor(prefix);
      try {
        const dynamic = dynamicCompletions?.(prefix) ?? [];
        const values = new Set<string>(matches.map((item) => item.value));
        return [...matches, ...dynamic.filter((item) => !values.has(item.value))];
      } catch {
        return matches;
      }
    },
    handler,
  });
}

export function parseCommand(args: string): {
  subcommand: string;
  rest: string;
  restParts: string[];
} {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const subcommand = match?.[1] ?? "";
  const rest = match?.[2] ?? "";
  const restParts = rest ? rest.split(/\s+/) : [];
  return { subcommand: subcommand.toLowerCase(), rest, restParts };
}
