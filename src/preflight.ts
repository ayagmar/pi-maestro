import { createHash } from "node:crypto";
import { type Board, type MaestroConfig, type Task } from "./types.js";

export type WorkflowSize = "small" | "medium" | "large";

export interface WorkflowPreflight {
  taskCount: number;
  waves: string[][];
  configuredConcurrency: number;
  effectiveConcurrency: number;
  executorLaunchUpperBound: number;
  reviewerLaunchUpperBound: number;
  totalLaunchUpperBound: number;
  verificationProfileUsage: Array<{ profile: string; tasks: number }>;
  size: WorkflowSize;
  guidance: string;
  warnings: string[];
  requiresConfirmation: boolean;
  signature: string;
}

export function assertPlanTaskLimit(taskCount: number, config: MaestroConfig): void {
  if (taskCount > config.maxPlanTasks) {
    throw new Error(
      `Plan has ${taskCount} tasks; configured maxPlanTasks is ${config.maxPlanTasks}.`
    );
  }
}

export function preflightWorkflow(
  board: Board,
  config: MaestroConfig,
  taskIds?: readonly string[]
): WorkflowPreflight {
  const selected = selectedTasks(board, taskIds);
  assertPlanTaskLimit(selected.length, config);
  const waves = dependencyWaves(selected);
  const maximumWaveWidth = Math.max(0, ...waves.map((wave) => wave.length));
  const effectiveConcurrency = Math.min(config.maxParallel, maximumWaveWidth);
  const reviewModels = modelLaunches(config.tiers.review);
  let executorLaunchUpperBound = 0;
  let reviewerLaunchUpperBound = 0;

  for (const task of selected) {
    executorLaunchUpperBound += config.maxAttempts * modelLaunches(config.tiers[task.tier]);
    const logicalReviewers =
      task.reviewPolicy === "confirm"
        ? config.reviewRequiredApprovals
        : task.reviewPolicy === "find-and-refute"
          ? 2
          : 1;
    const rawReviewers = Math.min(config.maxReviewerLaunches, logicalReviewers * reviewModels);
    reviewerLaunchUpperBound += config.maxAttempts * rawReviewers;
  }

  const totalLaunchUpperBound = executorLaunchUpperBound + reviewerLaunchUpperBound;
  const taskThresholdExceeded = selected.length > config.confirmationPlanTasks;
  const launchThresholdExceeded = totalLaunchUpperBound > config.confirmationTotalLaunches;
  const warnings: string[] = [];
  if (taskThresholdExceeded) {
    warnings.push(
      `${selected.length} tasks exceed confirmationPlanTasks=${config.confirmationPlanTasks}`
    );
  }
  if (launchThresholdExceeded) {
    warnings.push(
      `${totalLaunchUpperBound} possible raw launches exceed confirmationTotalLaunches=${config.confirmationTotalLaunches}`
    );
  }
  if (totalLaunchUpperBound > config.maxTotalLaunchesPerRun) {
    warnings.push(`runtime will stop at maxTotalLaunchesPerRun=${config.maxTotalLaunchesPerRun}`);
  }
  const size = workflowSize(selected.length);

  return {
    taskCount: selected.length,
    waves,
    configuredConcurrency: config.maxParallel,
    effectiveConcurrency,
    executorLaunchUpperBound,
    reviewerLaunchUpperBound,
    totalLaunchUpperBound,
    verificationProfileUsage: verificationUsage(selected, config),
    size,
    guidance:
      size === "small"
        ? "small: direct inspection is usually practical"
        : size === "medium"
          ? "medium: inspect dependency waves and write-scope overlap"
          : "large: require explicit confirmation and inspect phased execution",
    warnings,
    requiresConfirmation: taskThresholdExceeded || launchThresholdExceeded,
    signature: preflightSignature(selected, config),
  };
}

export function formatWorkflowPreflight(preflight: WorkflowPreflight): string {
  const profiles = preflight.verificationProfileUsage
    .map(({ profile, tasks }) => `${profile}:${tasks}`)
    .join(", ");
  const lines = [
    `Workflow preflight · ${preflight.taskCount} task(s) · ${preflight.size}`,
    `dependency waves: ${
      preflight.waves.length === 0
        ? "none"
        : preflight.waves.map((wave, index) => `${index + 1}[${wave.join(",")}]`).join(" ")
    }`,
    `concurrency: configured ${preflight.configuredConcurrency} · effective ${preflight.effectiveConcurrency}`,
    `raw launch upper bounds: executor ${preflight.executorLaunchUpperBound} · reviewer ${preflight.reviewerLaunchUpperBound} · combined ${preflight.totalLaunchUpperBound}`,
    `verification profiles: ${profiles || "none"}`,
    preflight.guidance,
    ...(preflight.warnings.length > 0
      ? preflight.warnings.map((warning) => `warning: ${warning}`)
      : ["warnings: none"]),
    `explicit confirmation: ${preflight.requiresConfirmation ? "required" : "not required"}`,
    `reference: ${preflight.signature}`,
  ];
  const report = lines.join("\n");
  return report.length <= 4_000 ? report : `${report.slice(0, 3_980)}\n… bounded`;
}

function selectedTasks(board: Board, taskIds: readonly string[] | undefined): Task[] {
  const selected = taskIds?.length
    ? new Set(taskIds.map((id) => id.trim().toUpperCase()))
    : undefined;
  return board.tasks
    .filter(
      (task) =>
        task.status !== "approved" &&
        task.status !== "cancelled" &&
        (!selected || selected.has(task.id.toUpperCase()))
    )
    .sort((left, right) => naturalCompare(left.id, right.id));
}

function dependencyWaves(tasks: readonly Task[]): string[][] {
  const ids = new Set(tasks.map((task) => task.id.toUpperCase()));
  const remaining = new Map(tasks.map((task) => [task.id.toUpperCase(), task]));
  const completed = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining.values()]
      .filter((task) =>
        task.dependsOn.every(
          (dependency) =>
            !ids.has(dependency.toUpperCase()) || completed.has(dependency.toUpperCase())
        )
      )
      .sort((left, right) => naturalCompare(left.id, right.id));
    if (wave.length === 0) break;
    waves.push(wave.map((task) => task.id));
    for (const task of wave) {
      remaining.delete(task.id.toUpperCase());
      completed.add(task.id.toUpperCase());
    }
  }
  return waves;
}

function modelLaunches(tier: MaestroConfig["tiers"][string] | undefined): number {
  return 1 + (tier?.fallbacks?.length ?? 0);
}

function verificationUsage(
  tasks: readonly Task[],
  config: MaestroConfig
): Array<{ profile: string; tasks: number }> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const profile = task.verificationProfile ?? config.defaultVerificationProfile ?? "(none)";
    counts.set(profile, (counts.get(profile) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([profile, count]) => ({ profile, tasks: count }));
}

function workflowSize(taskCount: number): WorkflowSize {
  if (taskCount <= 8) return "small";
  if (taskCount <= 24) return "medium";
  return "large";
}

function preflightSignature(tasks: readonly Task[], config: MaestroConfig): string {
  const payload = {
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      brief: task.brief,
      tier: task.tier,
      dependsOn: task.dependsOn,
      writePaths: task.writePaths ?? [],
      successCriteria: task.successCriteria ?? [],
      verificationProfile: task.verificationProfile,
      reviewPolicy: task.reviewPolicy ?? "single",
    })),
    limits: {
      maxParallel: config.maxParallel,
      maxAttempts: config.maxAttempts,
      maxPlanTasks: config.maxPlanTasks,
      maxTotalLaunchesPerRun: config.maxTotalLaunchesPerRun,
      maxReviewerLaunches: config.maxReviewerLaunches,
      reviewRequiredApprovals: config.reviewRequiredApprovals,
      confirmationPlanTasks: config.confirmationPlanTasks,
      confirmationTotalLaunches: config.confirmationTotalLaunches,
      tiers: config.tiers,
      defaultVerificationProfile: config.defaultVerificationProfile,
    },
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
