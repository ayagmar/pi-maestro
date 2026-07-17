export type DocPage = {
  slug: string;
  title: string;
  description: string;
  group: string;
  content: string[];
};

export const docs: DocPage[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    description: "Install Maestro, check the environment, and run your first reviewed goal.",
    group: "Start here",
    content: [
      "Install Maestro with pi install, then open the project control center with /maestro.",
      "A first run is safest when the task brief, write scope, success criteria, and verification command are explicit.",
    ],
  },
  {
    slug: "how-it-works",
    title: "How it works",
    description: "Understand the advisor, executor, reviewer, and human control loop.",
    group: "Start here",
    content: [
      "The current pi session plans and supervises. Every delegated task gets a fresh executor context, then an independent reviewer checks the result before approval.",
      "The durable board is the single source of truth; UI status is a projection of that state.",
    ],
  },
  {
    slug: "configuration",
    title: "Configuration",
    description:
      "Tune models, concurrency, review policy, worktrees, budgets, and verification profiles.",
    group: "Operate",
    content: [
      "Configuration resolves from defaults, operator-owned user settings, then non-executable project settings.",
      "Verification commands are trusted operator configuration only. Repository configuration can select a known profile but cannot define commands.",
    ],
  },
  {
    slug: "operations",
    title: "Operations & recovery",
    description: "Pause, resume, inspect, retry, recover, and reconcile without losing evidence.",
    group: "Operate",
    content: [
      "Maestro preserves board state, attempts, logs, sessions, and checkpoint branches across interruptions.",
      "Use timeline, board, doctor, and reconcile before changing state.",
    ],
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "The ownership boundaries and correctness transactions behind the extension.",
    group: "Build with Maestro",
    content: [
      "Deterministic policy, persisted state, runtime adapters, and UI stay separate.",
      "The composition entry is deliberately thin; board, runner, Git, execution, review, and integration each have one owner.",
    ],
  },
  {
    slug: "security",
    title: "Security & trust",
    description: "Know what Maestro isolates, what it does not, and how to report a vulnerability.",
    group: "Build with Maestro",
    content: [
      "Executors and verification commands run with the current user's permissions.",
      "Git worktrees provide isolation and recovery, not a security sandbox.",
    ],
  },
  {
    slug: "contributing",
    title: "Contributing",
    description: "Repository layout, verification expectations, and safe contract changes.",
    group: "Build with Maestro",
    content: [
      "Keep modules readable and local. Behavioral tests are required for bug fixes.",
      "Run the full check twice and confirm both runs report the same test count.",
    ],
  },
  {
    slug: "command-reference",
    title: "Command reference",
    description: "The complete human-operated command surface for planning, driving, and recovery.",
    group: "Reference",
    content: [
      "Slash commands provide operational controls without expanding the model-facing API.",
      "Dashboard shortcuts and command families cover plan, drive, inspection, recovery, recipes, workflows, and configuration.",
    ],
  },
  {
    slug: "changelog",
    title: "Changelog",
    description: "Release notes for the 0.1.x line.",
    group: "Reference",
    content: [
      "0.1.0 introduced reviewed planning, fresh-context RPC executors, fallbacks, worktrees, dashboard evidence, and recovery controls.",
    ],
  },
];

export function getDoc(slug: string): DocPage {
  const doc = docs.find((item) => item.slug === slug);
  if (doc) return doc;
  const fallback = docs[0];
  if (!fallback) throw new Error("Documentation index is empty");
  return fallback;
}
