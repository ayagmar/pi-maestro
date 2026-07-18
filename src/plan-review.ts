import { formatWorkflowPreflight, preflightWorkflow, type WorkflowPreflight } from "./preflight.js";
import { type Board, type MaestroConfig } from "./types.js";

/** Rich read-only plan projection used at the approval gate. */
export function formatPlanReviewMarkdown(
  board: Board,
  config: MaestroConfig,
  workflowPreflight: WorkflowPreflight = preflightWorkflow(board, config)
): string {
  const tasks = board.tasks.filter((task) => task.status !== "cancelled");
  const preflight = formatWorkflowPreflight(workflowPreflight);
  const sections = tasks.map((task) => {
    const criteria = (task.successCriteria ?? []).map((item) => `- ${item}`).join("\n") || "- None";
    const writes = task.writePaths?.map((path) => `\`${path}\``).join(", ") || "None";
    const reviewPolicy = task.reviewPolicy ?? "single";
    const review =
      reviewPolicy === "confirm"
        ? `${reviewPolicy} (${config.reviewRequiredApprovals} independent approvals)`
        : reviewPolicy;
    const discoveryScope = task.discovery?.allowedWritePaths
      .map((path) => `\`${path}\``)
      .join(", ");
    return [
      `## ${task.id} · ${task.title}`,
      `**Tier:** ${task.tier}  `,
      `**Dependencies:** ${task.dependsOn.join(", ") || "None"}  `,
      `**Review:** ${review}  `,
      `**Verification:** ${task.verificationProfile ?? "None"}  `,
      `**Commit:** ${task.commitMessage ? `\`${task.commitMessage}\`` : "Automatic"}`,
      "",
      "### Brief",
      task.brief,
      "",
      "### Success criteria",
      criteria,
      "",
      "### Write scope",
      writes,
      ...(discoveryScope ? ["", "### Discovery output scope", discoveryScope] : []),
    ].join("\n");
  });
  return [
    "# Maestro plan review",
    `**${tasks.length} task${tasks.length === 1 ? "" : "s"} awaiting approval**`,
    "",
    preflight
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    "",
    ...sections,
  ].join("\n");
}
