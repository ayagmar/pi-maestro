import { createHash } from "node:crypto";
import { truncateText } from "./format.js";
import {
  type ApprovedProvenance,
  type Attempt,
  type Board,
  type MaestroConfig,
  type Task,
  type TierConfig,
} from "./types.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value);

function tierIdentity(tier: TierConfig | undefined): object | undefined {
  if (!tier) return undefined;
  return {
    model: tier.model ?? null,
    fallbacks: tier.fallbacks ?? [],
    thinking: tier.thinking,
    tools: tier.tools ?? null,
  };
}

function authoritativeArtifact(task: Task): ApprovedProvenance["artifact"] | undefined {
  const latestAttempt = task.attempts.at(-1);
  // Empty write scope normally means a report-only investigation. If an
  // executor nevertheless changed files, keep the approval proof anchored to
  // the Git artifact rather than silently treating those edits as report text.
  const hasFileWork =
    (task.writePaths?.length ?? 0) > 0 || (latestAttempt?.touchedFiles.length ?? 0) > 0;
  if (hasFileWork) {
    const tree = task.provenance?.candidateTree;
    return tree ? { kind: "git-tree", identity: tree } : undefined;
  }
  const report = latestAttempt?.finalReport;
  return report ? { kind: "report", identity: digest(report) } : undefined;
}

export interface TaskFingerprint {
  fingerprint: string;
  componentHashes: ApprovedProvenance["componentHashes"];
  dependencyIdentities: ApprovedProvenance["dependencyIdentities"];
}

export function taskFingerprint(
  board: Board,
  task: Task,
  config: MaestroConfig
): TaskFingerprint | undefined {
  return fingerprintTask(board, task, config, new Set(), new Map());
}

function fingerprintTask(
  board: Board,
  task: Task,
  config: MaestroConfig,
  visited: ReadonlySet<string>,
  freshnessCache: Map<string, CompletionFreshness>
): TaskFingerprint | undefined {
  if (visited.has(task.id)) return undefined;
  const nextVisited = new Set(visited).add(task.id);
  const taskTier = config.tiers[task.tier];
  const reviewTier = config.tiers.review;
  if (!taskTier || !reviewTier) return undefined;
  const profileName = task.verificationProfile ?? config.defaultVerificationProfile;
  const profile = profileName ? config.verificationProfiles?.[profileName] : undefined;
  if (profileName && !profile) return undefined;
  const dependencyIds = [...new Set(task.dependsOn.map((id) => id.trim().toUpperCase()))].sort(
    (left, right) => left.localeCompare(right, undefined, { numeric: true })
  );
  const dependencyIdentities: ApprovedProvenance["dependencyIdentities"] = [];
  for (const dependencyId of dependencyIds) {
    const dependency = board.tasks.find((candidate) => candidate.id === dependencyId);
    const artifact = dependency?.approvedProvenance?.artifact;
    if (dependency?.status !== "approved" || !artifact) return undefined;
    if (freshness(board, dependency, config, nextVisited, freshnessCache).state !== "fresh") {
      return undefined;
    }
    dependencyIdentities.push({
      taskId: dependency.id.trim().toUpperCase(),
      kind: artifact.kind,
      identity: artifact.identity,
    });
  }
  const normalizedPaths = (paths: readonly string[]) =>
    [...new Set(paths.map((path) => path.trim().replaceAll("\\", "/")).filter(Boolean))].sort();
  const contract = {
    title: task.title,
    brief: task.brief,
    // Included only when set so legacy implementation-task fingerprints
    // (captured before the kind field existed) remain stable.
    ...(task.kind ? { kind: task.kind } : {}),
    successCriteria: task.successCriteria ?? [],
    writePaths: normalizedPaths(task.writePaths ?? []),
    discovery: task.discovery
      ? { allowedWritePaths: normalizedPaths(task.discovery.allowedWritePaths) }
      : null,
    dependsOn: dependencyIds,
  };
  const execution = {
    tier: task.tier,
    taskTier: tierIdentity(taskTier),
    reviewTier: tierIdentity(reviewTier),
    reviewPolicy: task.reviewPolicy ?? "single",
    confirmApprovals: task.reviewPolicy === "confirm" ? config.reviewRequiredApprovals : null,
  };
  const verification = {
    name: profileName ?? null,
    command: profile?.command ?? null,
    timeoutSeconds: profile?.timeoutSeconds ?? null,
  };
  const components = {
    contract: digest(canonical(contract)),
    execution: digest(canonical(execution)),
    verification: digest(canonical(verification)),
    dependencies: digest(canonical(dependencyIdentities)),
  };
  return {
    fingerprint: digest(canonical({ version: 1, ...components })),
    componentHashes: components,
    dependencyIdentities,
  };
}

export type CompletionFreshness =
  | { state: "not-approved"; reason: string }
  | { state: "fresh"; reason: string }
  | { state: "stale" | "legacy" | "unavailable"; reason: string };

export function completionFreshness(
  board: Board,
  task: Task,
  config: MaestroConfig,
  cache: Map<string, CompletionFreshness> = new Map()
): CompletionFreshness {
  return freshness(board, task, config, new Set(), cache);
}

function freshness(
  board: Board,
  task: Task,
  config: MaestroConfig,
  visited: ReadonlySet<string>,
  cache: Map<string, CompletionFreshness>
): CompletionFreshness {
  const cached = cache.get(task.id);
  if (cached) return cached;
  if (task.status !== "approved") return { state: "not-approved", reason: "task is not approved" };
  if (!task.approvedProvenance) {
    return { state: "legacy", reason: "approved completion has no versioned fingerprint proof" };
  }
  if (visited.has(task.id))
    return { state: "unavailable", reason: "dependency cycle prevents reuse" };
  const nextVisited = new Set(visited).add(task.id);
  for (const dependencyId of task.dependsOn) {
    const dependency = board.tasks.find((candidate) => candidate.id === dependencyId);
    if (!dependency)
      return { state: "unavailable", reason: `dependency ${dependencyId} is missing` };
    const dependencyFreshness = freshness(board, dependency, config, nextVisited, cache);
    if (dependencyFreshness.state !== "fresh") {
      const result: CompletionFreshness = {
        state: "stale",
        reason: `dependency ${dependencyId} is ${dependencyFreshness.state}: ${dependencyFreshness.reason}`,
      };
      cache.set(task.id, result);
      return result;
    }
  }
  const current = fingerprintTask(board, task, config, visited, cache);
  if (!current)
    return { state: "unavailable", reason: "effective execution inputs are unavailable" };
  const approved = task.approvedProvenance;
  const priorities: Array<keyof ApprovedProvenance["componentHashes"]> = [
    "contract",
    "execution",
    "verification",
    "dependencies",
  ];
  for (const component of priorities) {
    if (current.componentHashes[component] !== approved.componentHashes[component]) {
      const result: CompletionFreshness = {
        state: "stale",
        reason: `${component} inputs changed after approval`,
      };
      cache.set(task.id, result);
      return result;
    }
  }
  const artifact = authoritativeArtifact(task);
  if (!artifact)
    return { state: "unavailable", reason: "authoritative approved artifact is unavailable" };
  if (
    artifact.kind !== approved.artifact.kind ||
    artifact.identity !== approved.artifact.identity
  ) {
    return { state: "stale", reason: "approved artifact identity changed" };
  }
  if (current.fingerprint !== approved.fingerprint) {
    return { state: "stale", reason: "fingerprint changed after approval" };
  }
  const result: CompletionFreshness = {
    state: "fresh",
    reason: "approved fingerprint and artifact identities match",
  };
  cache.set(task.id, result);
  return result;
}

export function captureApprovedProvenance(
  board: Board,
  task: Task,
  config: MaestroConfig,
  approvedAt = Date.now()
): ApprovedProvenance | undefined {
  const fingerprint = taskFingerprint(board, task, config);
  const artifact = authoritativeArtifact(task);
  if (!fingerprint || !artifact) return undefined;
  return { version: 1, ...fingerprint, artifact, approvedAt };
}

function pathInWriteScope(path: string, writePaths: string[]): boolean {
  return writePaths.some((scope) =>
    scope.endsWith("/**") ? path.startsWith(scope.slice(0, -2)) : path === scope
  );
}

export function pathsOutsideWriteScope(task: Task, attempt: Attempt): string[] {
  if (!task.writePaths) return [];
  return attempt.touchedFiles.filter((path) => !pathInWriteScope(path, task.writePaths ?? []));
}

export function artifactFindings(task: Task, attempt: Attempt): Task["findings"] {
  const findings: NonNullable<Task["findings"]> = [];
  const add = (fingerprint: string, message: string) => {
    findings.push({
      fingerprint,
      message: truncateText(message, 500),
      status: "open",
      firstAttempt: attempt.index,
      lastAttempt: attempt.index,
    });
  };
  const diff = attempt.diff ?? "";
  const paths = attempt.touchedFiles;

  if (task.writePaths) {
    if (task.writePaths.length > 0 && paths.length === 0) {
      add("empty-artifact", "Expected file work produced no attributable Git changes.");
    }
  }
  const deletedPaths = diff
    .split(/^diff --git /m)
    .slice(1)
    .filter((block) => /(^|\n)deleted file mode/m.test(block))
    .map((block) => block.split("\n", 1)[0] ?? "")
    .map((header) => header.match(/^a\/(.+?) b\//)?.[1]?.replaceAll("\\", "/"))
    .filter((path): path is string => path !== undefined);
  const deletedTests = deletedPaths.some(
    (path) => /(^|\/)(test|tests)(\/|\.|$)/.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path)
  );
  if (deletedTests && !/delete|remove/i.test(task.brief)) {
    add("deleted-tests", "Existing tests were deleted without explicit task scope.");
  }
  if (/^[+-].*(testMatch|testRegex|include|exclude).*(narrow|ignore|exclude)/im.test(diff)) {
    add("test-discovery", "Test discovery or configuration appears narrowed.");
  }
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(diff)) {
    add("conflict-markers", "Unresolved merge conflict markers remain in the artifact.");
  }
  return findings;
}
