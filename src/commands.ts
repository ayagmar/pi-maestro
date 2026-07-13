import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMMAND } from "./constants.js";

export const MAESTRO_COMMANDS = [
  "start",
  "handoff",
  "back",
  "drive",
  "pause",
  "resume",
  "abort",
  "board",
  "plan",
  "plan export",
  "plan import",
  "list",
  "costs",
  "simulate",
  "open",
  "config",
  "config project",
  "config show",
  "doctor",
  "doctor cleanup",
  "doctor cleanup confirm",
  "history",
  "timeline",
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
  const [subcommand = "", ...restParts] = args.trim().split(/\s+/);
  return { subcommand: subcommand.toLowerCase(), rest: restParts.join(" "), restParts };
}
