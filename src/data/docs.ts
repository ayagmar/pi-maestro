/**
 * The documentation site renders the repository's markdown files directly, so
 * the files are the single source of truth. This list only adds navigation
 * metadata. A slug is the lowercased file name, which is also how
 * scripts/rehype-docs.mjs routes links between the files.
 */
export type DocPage = {
  slug: string;
  title: string;
  description: string;
  group: string;
  /** Repository-relative markdown source. */
  file: string;
};

export const docs: DocPage[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    description: "Install Maestro, check the environment, and run a first goal.",
    group: "Start here",
    file: "docs/getting-started.md",
  },
  {
    slug: "how-it-works",
    title: "How it works",
    description: "Roles, task lifecycle, review, failures, and isolation.",
    group: "Start here",
    file: "docs/how-it-works.md",
  },
  {
    slug: "commands",
    title: "Command reference",
    description: "Every /maestro command, the dashboard keys, and the cost reports.",
    group: "Use",
    file: "docs/commands.md",
  },
  {
    slug: "configuration",
    title: "Configuration",
    description: "Settings, presets, tiers, budgets, and trusted verification profiles.",
    group: "Use",
    file: "docs/configuration.md",
  },
  {
    slug: "operations",
    title: "Operations and recovery",
    description: "What each drive stop means and the safe next step.",
    group: "Use",
    file: "docs/operations.md",
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "Module ownership and the invariants the runtime keeps.",
    group: "Project",
    file: "docs/architecture.md",
  },
  {
    slug: "security",
    title: "Security",
    description:
      "Supported versions, how to report a vulnerability, and what Maestro does not isolate.",
    group: "Project",
    file: "SECURITY.md",
  },
  {
    slug: "contributing",
    title: "Contributing",
    description: "Repository layout, checks, test layers, and how releases are cut.",
    group: "Project",
    file: "CONTRIBUTING.md",
  },
  {
    slug: "changelog",
    title: "Changelog",
    description: "Release notes.",
    group: "Project",
    file: "CHANGELOG.md",
  },
];

export function getDoc(slug: string): DocPage {
  const doc = docs.find((item) => item.slug === slug);
  if (doc) return doc;
  throw new Error(`Unknown documentation page: ${slug}`);
}
