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

export function parseCommand(args: string): {
  subcommand: string;
  rest: string;
  restParts: string[];
} {
  const [subcommand = "", ...restParts] = args.trim().split(/\s+/);
  return { subcommand: subcommand.toLowerCase(), rest: restParts.join(" "), restParts };
}
