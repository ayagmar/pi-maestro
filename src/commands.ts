import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMMAND } from "./constants.js";

export const MAESTRO_COMMANDS = [
  "start",
  "handoff",
  "back",
  "drive",
  "retry",
  "pause",
  "resume",
  "abort",
  "board",
  "dash",
  "dashboard",
  "plan",
  "plan export",
  "plan import",
  "plan diff",
  "plan compare",
  "recipe list",
  "recipe inspect",
  "recipe preview",
  "recipe save",
  "recipe run",
  "recipe remove",
  "list",
  "costs",
  "simulate",
  "discover",
  "open",
  "config",
  "config project",
  "config show",
  "doctor",
  "doctor cleanup",
  "doctor cleanup confirm",
  "history",
  "timeline",
  "reconcile",
  "replay",
  "reset",
] as const;

export function registerMaestroCommand(
  pi: ExtensionAPI,
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
): void {
  pi.registerCommand(COMMAND, {
    description: "Plan, delegate, review, and monitor work across fresh executor contexts",
    getArgumentCompletions: (prefix) => {
      const matches = MAESTRO_COMMANDS.filter((command) =>
        command.startsWith(prefix.toLowerCase())
      );
      return matches.map((command) => ({ value: command, label: command }));
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
