import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeQuarantineNotice, loadBoard } from "../../src/board.js";
import { validateConfig } from "../../src/config.js";
import { parseDiscoveryOutput } from "../../src/discovery.js";
import { importPlan } from "../../src/plan-serialization.js";
import { expandRecipe, parseRecipe, parseRecipeInput } from "../../src/recipes.js";

/**
 * A deterministic corpus of valid and damaged persisted files. Every case runs
 * through the public entry point that reads that format, so the recorded
 * accept/reject decisions outlive any change to how validation is implemented.
 */

type Path = Array<string | number>;
type Container = Record<string | number, unknown>;

interface Operation {
  label: string;
  /** Likely to keep the file valid, so random combinations also produce accepted files. */
  soft: boolean;
  apply(root: { value: unknown }): void;
}

export interface CorpusCase {
  label: string;
  value: unknown;
}

export interface Decision {
  accepted: boolean;
  /** Canonical result of a successful read, proving the same meaning and not just acceptance. */
  output?: string;
}

const hex = (character: string, length = 64) => character.repeat(length);
const usage = { input: 10, output: 5, cost: 0.25, turns: 2 };
const failure = { kind: "provider_failure", message: "quota", retryable: true };
const sections = [{ name: "brief", characters: 120, omitted: false }];
const hashes = {
  contract: hex("a"),
  execution: hex("b"),
  verification: hex("c"),
  dependencies: hex("d"),
};
const convergence = {
  policy: "confirm",
  status: "approved",
  requiredApprovals: 2,
  actualApprovals: 2,
  reviewerCount: 2,
  summary: "two approvals",
  decidedAt: 1_700_000_000_500,
  cause: "gate",
};
const reviewLaunch = {
  id: "R1",
  reviewerIndex: 1,
  role: "confirmer",
  verdict: "approve",
  costTier: "economy",
  escalationReason: "risk path",
  criterionEvidence: [{ criterion: 1, passed: true, evidence: "tests pass" }],
  candidateTree: hex("e", 40),
  taskFingerprint: hex("f"),
  model: "cheap",
  provider: "stub",
  sessionFile: "review.jsonl",
  logFile: "review.log",
  startedAt: 1_700_000_000_100,
  endedAt: 1_700_000_000_200,
  exitCode: 0,
  errorMessage: "none",
  failureReason: failure,
  usage,
  finalReport: "APPROVE",
  promptCharacters: 400,
  promptApproximateTokens: 100,
  promptSections: sections,
};
const attempt = {
  index: 1,
  sessionFile: "session.jsonl",
  sessionDir: "sessions/T1",
  logFile: "T1-attempt-1.jsonl",
  model: "stub/model",
  provider: "stub",
  resumed: false,
  detached: true,
  pid: 4242,
  processStartId: "start-1",
  transportId: "transport-1",
  controlFile: "control.json",
  exitFile: "exit.json",
  stderrFile: "stderr.log",
  thinking: "low",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_000_050,
  exitCode: 0,
  errorMessage: "none",
  failureReason: failure,
  executionFingerprint: hex("1"),
  executionComponentHashes: hashes,
  consumesAttempt: true,
  providerFailure: false,
  usage,
  finalReport: "done",
  promptCharacters: 800,
  promptApproximateTokens: 200,
  promptSections: sections,
  diff: "diff --git",
  worktreePath: "/tmp/worktree",
  branch: "maestro/T1",
  reviewReport: "APPROVE",
  reviewNotes: "fine",
  reviewModel: "cheap",
  reviewProvider: "stub",
  reviewLaunches: [reviewLaunch],
  reviewConvergence: convergence,
  reviewConvergenceHistory: [convergence],
  reviewUsage: usage,
  reviewSessionFile: "review.jsonl",
  touchedFiles: ["src/a.ts"],
};
const fullTask = {
  id: "T1",
  title: "Full task",
  brief: "Every persisted field",
  commitMessage: "feat: a",
  reviewGuidance: "check a",
  supersededBy: "T9",
  supersedes: "T0",
  tier: "standard",
  status: "approved",
  dependsOn: ["T2"],
  writePaths: ["src/a.ts"],
  successCriteria: ["works"],
  verificationProfile: "unit",
  reviewPolicy: "confirm",
  findings: [
    { fingerprint: "f1", message: "fix", status: "open", firstAttempt: 1, lastAttempt: 1 },
  ],
  reviewNotes: "fine",
  approvalKind: "reviewed",
  reviewedPatchHash: "legacy",
  integratedCommit: hex("2", 40),
  verificationSummary: "passed",
  provenance: {
    candidateTree: hex("3", 40),
    capturedAt: 1_700_000_000_300,
    reviewedAt: 1_700_000_000_400,
    integratedCommit: hex("4", 40),
    integratedTree: hex("5", 40),
    verifiedAt: 1_700_000_000_450,
    verificationProfile: "unit",
  },
  approvedProvenance: {
    version: 1,
    executionShape: 2,
    fingerprint: hex("6"),
    componentHashes: hashes,
    artifact: { kind: "git-tree", identity: hex("7", 40) },
    dependencyIdentities: [
      { taskId: "T2", kind: "report", identity: hex("8") },
      { taskId: "T3", kind: "git-tree", identity: hex("9") },
    ],
    approvedAt: 1_700_000_000_600,
  },
  reviewRejections: 1,
  reviewStagnantRejections: 0,
  dispatchClaim: {
    id: "claim-1",
    kind: "review",
    claimedAt: 1_700_000_000_700,
    expiresAt: 1_700_000_000_800,
    ownerPid: 4242,
    ownerStart: "start-1",
  },
  dispatchNote: "skipped",
  attempts: [attempt],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_900,
};
const minimalTask = {
  id: "T2",
  title: "Legacy task",
  brief: "No optional fields",
  tier: "standard",
  status: "todo",
  dependsOn: [],
  attempts: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};
const discoveryTask = {
  ...minimalTask,
  id: "T3",
  kind: "investigation",
  writePaths: [],
  discovery: { allowedWritePaths: ["src/**"] },
};
const fullBoard = {
  version: 1,
  revision: 7,
  nextTaskNumber: 4,
  goal: "Ship it",
  ownerSessions: ["session-1"],
  planPending: false,
  scaleApproval: { signature: "sig", confirmedAt: 1_700_000_000_000 },
  pausedDrive: { taskIds: ["T1"], ownerSession: "session-1", reason: "provider_blocked" },
  activeDecision: {
    id: "decision-1",
    ownerSession: "session-1",
    kind: "escalation",
    taskIds: ["T1"],
    evidence: "needs a human",
    allowedInterventions: ["handoff", "abort", "steer"],
    awaitingHuman: { kind: "scale_confirmation", since: 1_700_000_000_000, signature: "sig" },
    createdAt: 1_700_000_000_000,
    deliveredAt: 1_700_000_000_100,
    deliveryClaim: { id: "delivery-1", claimedAt: 1_700_000_000_050 },
    resolution: { intervention: "resume", resolvedAt: 1_700_000_000_200 },
  },
  activeDrive: {
    id: "drive-1",
    ownerSession: "session-1",
    taskIds: ["T1"],
    startedAt: 1_700_000_000_000,
    waiting: { until: 1_700_000_100_000, reason: "quota", taskIds: ["T1"] },
  },
  tasks: [fullTask, minimalTask, discoveryTask],
};

const fullConfig = {
  maxParallel: 4,
  planGate: true,
  livePanes: false,
  useWorktrees: true,
  detachedExecutors: false,
  autoCommit: true,
  pushOnIntegration: false,
  maxAttempts: 3,
  maxPlanTasks: 64,
  maxDiscoveryGeneratedTasks: 16,
  maxTotalLaunchesPerRun: 100,
  maxRoundsPerRun: 50,
  confirmationPlanTasks: 32,
  confirmationTotalLaunches: 50,
  reviewPolicy: "confirm",
  reviewRequiredApprovals: 2,
  maxReviewerLaunches: 4,
  maxCostPerTask: 1.5,
  maxCostPerReview: 0.5,
  reviewCheapModel: "stub/cheap",
  reviewEscalation: "risk",
  maxRunCost: 10,
  reviewRejectionLimit: 3,
  retryContext: "resume",
  statusWaitSeconds: 30,
  decisionNudgeMinutes: 10,
  logEvents: "compact",
  maxLogBytesPerRun: 1_000_000,
  providerQuotaWaitMinutes: 300,
  watchdogIdleSeconds: 120,
  watchdogWarningTurns: 5,
  watchdogTerminationTurns: 3,
  handoffContextRatio: 0.8,
  cleanupCompletedTasks: false,
  verificationProfiles: { unit: { command: "npm test", timeoutSeconds: 60 } },
  defaultVerificationProfile: "unit",
  tiers: {
    standard: {
      model: "stub/model",
      fallbacks: ["stub/other"],
      thinking: "low",
      tools: "read,edit",
      watchdogIdleSeconds: 60,
      watchdogWarningTurns: 2,
      watchdogTerminationTurns: 1,
    },
    review: { thinking: "high" },
  },
};

const recipeTask = {
  id: "A",
  title: "Build {{input.target}}",
  brief: "Do the work",
  tier: "standard",
  dependsOn: [],
  writePaths: ["src/a.ts"],
  successCriteria: ["works"],
  verificationProfile: "unit",
  reviewPolicy: "single",
  commitMessage: "feat: a",
};
const fullRecipe = {
  kind: "pi-maestro-recipe",
  version: 1,
  name: "full.recipe-1",
  description: "Every field",
  inputs: {
    target: { description: "What to build", required: true, default: "api" },
    count: { default: 2 },
    flag: { default: false },
  },
  tasks: [
    recipeTask,
    {
      id: "B",
      title: "Look",
      brief: "Investigate the code",
      kind: "investigation",
      tier: "standard",
      dependsOn: ["A"],
      writePaths: [],
      successCriteria: ["reported"],
      discovery: { allowedWritePaths: ["src/**"] },
    },
  ],
};

const fullPlan = {
  kind: "pi-maestro-plan",
  version: 1,
  tasks: [
    {
      id: "T1",
      title: "Build",
      brief: "Do the work",
      tier: "standard",
      dependsOn: [],
      writePaths: ["src/a.ts"],
      successCriteria: ["works"],
      verificationProfile: "unit",
      reviewPolicy: "confirm",
      commitMessage: "feat: a",
      reviewGuidance: "check a",
    },
    {
      id: "T2",
      title: "Look",
      brief: "Investigate the code",
      kind: "investigation",
      tier: "standard",
      dependsOn: ["T1"],
      writePaths: [],
      successCriteria: ["reported"],
      cancelled: true,
      discovery: { allowedWritePaths: ["src/**"] },
    },
  ],
};

const fullDiscovery = {
  kind: "pi-maestro-discovery",
  version: 1,
  items: [
    {
      key: "first-item",
      title: " Build ",
      brief: "Do the work",
      tier: "standard",
      writePaths: ["src/a.ts"],
      successCriteria: ["works", "works"],
      dependsOn: ["t1"],
      verificationProfile: "unit",
      reviewPolicy: "single",
      commitMessage: "feat: a",
    },
  ],
};

const WRONG_VALUES: Array<[string, unknown]> = [
  ["null", null],
  ["true", true],
  ["zero", 0],
  ["negative", -1],
  ["fraction", 1.5],
  ["huge", 1e300],
  ["infinity", Number.POSITIVE_INFINITY],
  ["negative-infinity", Number.NEGATIVE_INFINITY],
  ["empty-string", ""],
  ["blank-string", " \t ﻿"],
  ["text", "x"],
  ["empty-array", []],
  ["string-array", ["x"]],
  ["empty-object", {}],
  ["singleton-handoff", ["handoff"]],
  ["nested-resume", [["resume"]]],
];
const IN_MEMORY_VALUES: Array<[string, unknown]> = [
  ["nan", Number.NaN],
  ["undefined", undefined],
];

/** Alternative members for enum-like keys, including near misses. */
const ENUM_VALUES: Record<string, string[]> = {
  status: [
    "todo",
    "running",
    "ready_for_review",
    "changes_requested",
    "failed",
    "cancelled",
    "open",
    "verified",
    "disagreement",
    "operational_failure",
    "TODO",
  ],
  kind: [
    "git-tree",
    "report",
    "execute",
    "review",
    "investigation",
    "implementation",
    "scale_confirmation",
    "cost_cap",
    "stalled",
    "user_abort",
  ],
  role: ["single", "finder", "refuter", "judge"],
  verdict: ["request_changes", "reject"],
  costTier: ["premium", "free"],
  policy: ["single", "find-and-refute", "none"],
  reviewPolicy: ["single", "confirm", "find-and-refute", "none"],
  approvalKind: ["manual", "auto"],
  reason: ["paused", "provider_blocked", "escalation_required", "other"],
  intervention: ["handoff", "abort", "steer", "resume", "other"],
  retryContext: ["fresh", "other"],
  reviewEscalation: ["off", "doubt", "always", "other"],
  logEvents: ["full", "verbose"],
  thinking: ["off", "minimal", "medium", "xhigh", "max", "ultra"],
};

/** UTF-16 string bounds by key; each is probed at and just past the limit. */
const STRING_BOUNDS: Record<string, number[]> = {
  evidence: [500, 12_064],
  reason: [400],
  summary: [2_000],
  taskId: [64],
  title: [500],
  brief: [20_000],
  id: [500],
  tier: [500],
  key: [64, 500],
  name: [64],
  description: [300, 500],
  verificationProfile: [64],
  commitMessage: [500],
  command: [1_000],
};

/** Array bounds by key. */
const ARRAY_BOUNDS: Record<string, number[]> = {
  taskIds: [64],
  dependencyIdentities: [512],
  allowedWritePaths: [64],
  tasks: [64, 100],
  items: [32],
  writePaths: [64],
};

/** Object-size bounds by key. */
const RECORD_BOUNDS: Record<string, number> = { inputs: 32, verificationProfiles: 32 };

const NUMBER_RANGES: Record<string, [number, number]> = {
  maxParallel: [1, 64],
  maxAttempts: [1, 100],
  maxPlanTasks: [1, 512],
  maxDiscoveryGeneratedTasks: [1, 128],
  maxTotalLaunchesPerRun: [1, 4_096],
  maxRoundsPerRun: [1, 1_000],
  confirmationPlanTasks: [1, 512],
  confirmationTotalLaunches: [1, 4_096],
  reviewRequiredApprovals: [2, 8],
  maxReviewerLaunches: [1, 16],
  maxCostPerTask: [0, 1_000_000],
  maxCostPerReview: [0, 1_000_000],
  maxRunCost: [0, 1_000_000],
  reviewRejectionLimit: [1, 10],
  statusWaitSeconds: [0, 240],
  decisionNudgeMinutes: [0, 240],
  maxLogBytesPerRun: [0, 1_000_000_000],
  providerQuotaWaitMinutes: [0, 1_440],
  watchdogIdleSeconds: [0, 86_400],
  watchdogWarningTurns: [0, 10_000],
  watchdogTerminationTurns: [0, 10_000],
  handoffContextRatio: [0, 1],
  timeoutSeconds: [0, 3_600],
  reviewerIndex: [0, 1],
  criterion: [0, 1],
};

/** Keys a valid file must carry; deleting any other key should keep it valid. */
const REQUIRED_KEYS = new Set([
  "version",
  "kind",
  "nextTaskNumber",
  "tasks",
  "id",
  "title",
  "brief",
  "tier",
  "status",
  "dependsOn",
  "attempts",
  "createdAt",
  "updatedAt",
  "index",
  "logFile",
  "thinking",
  "startedAt",
  "usage",
  "touchedFiles",
  "name",
  "writePaths",
  "successCriteria",
  "key",
  "items",
]);

const WRITE_PATH_VALUES: Array<[string, string]> = [
  ["absolute", "/etc/passwd"],
  ["parent", "../outside"],
  ["blank", "   "],
  ["backslash", "src\\a.ts"],
  ["dot-prefixed", "./src/a.ts"],
  ["at-limit", "a".repeat(240)],
  ["past-limit", "a".repeat(241)],
];

function astral(length: number): string {
  return `${"😀".repeat(Math.floor(length / 2))}${length % 2 === 1 ? "a" : ""}`;
}

function pathsOf(value: unknown, prefix: Path = []): Path[] {
  const children =
    typeof value === "object" && value !== null
      ? Object.keys(value).flatMap((key) => {
          const step = Array.isArray(value) ? Number(key) : key;
          return pathsOf((value as Container)[key], [...prefix, step]);
        })
      : [];
  return [prefix, ...children];
}

function pathLabel(path: Path): string {
  return path.length === 0 ? "(root)" : path.join(".");
}

function replaceAt(root: { value: unknown }, path: Path, replace: (old: unknown) => unknown): void {
  if (path.length === 0) {
    root.value = replace(root.value);
    return;
  }
  let parent: unknown = root.value;
  for (const step of path.slice(0, -1)) {
    if (typeof parent !== "object" || parent === null) return;
    parent = (parent as Container)[step];
  }
  if (typeof parent !== "object" || parent === null) return;
  const key = path.at(-1) as string | number;
  if (!Object.hasOwn(parent, key)) return;
  (parent as Container)[key] = replace((parent as Container)[key]);
}

function deleteAt(root: { value: unknown }, path: Path): void {
  let parent: unknown = root.value;
  for (const step of path.slice(0, -1)) {
    if (typeof parent !== "object" || parent === null) return;
    parent = (parent as Container)[step];
  }
  if (typeof parent !== "object" || parent === null || Array.isArray(parent)) return;
  delete (parent as Container)[path.at(-1) as string];
}

function addOwnKey(target: unknown, key: string, value: unknown): unknown {
  if (typeof target !== "object" || target === null || Array.isArray(target)) return target;
  // defineProperty so that "__proto__" lands as an own key, as JSON.parse creates it.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return target;
}

function operationsFor(base: unknown, inMemory: boolean): Operation[] {
  const operations: Operation[] = [];
  const add = (label: string, soft: boolean, apply: Operation["apply"]) =>
    operations.push({ label, soft, apply });
  const set = (path: Path, name: string, value: unknown, soft = false) =>
    add(`${pathLabel(path)} = ${name}`, soft, (root) =>
      replaceAt(root, path, () => structuredClone(value))
    );

  for (const path of pathsOf(base)) {
    const node = path.reduce<unknown>((current, step) => (current as Container)[step], base);
    const key = [...path].reverse().find((step) => typeof step === "string");
    for (const [name, value] of WRONG_VALUES) set(path, name, value);
    if (inMemory) for (const [name, value] of IN_MEMORY_VALUES) set(path, name, value);

    if (typeof path.at(-1) === "string") {
      const required = REQUIRED_KEYS.has(path.at(-1) as string);
      add(`delete ${pathLabel(path)}`, !required, (root) => deleteAt(root, path));
    }
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
      add(`${pathLabel(path)} + extra field`, true, (root) =>
        replaceAt(root, path, (old) => addOwnKey(old, "extraFieldFromTheFuture", { a: 1 }))
      );
      add(`${pathLabel(path)} + __proto__ key`, false, (root) =>
        replaceAt(root, path, (old) => addOwnKey(old, "__proto__", { polluted: true }))
      );
      add(`${pathLabel(path)} + blank key`, false, (root) =>
        replaceAt(root, path, (old) => addOwnKey(old, " ", structuredClone(Object.values(node)[0])))
      );
      const firstValue = Object.values(node)[0];
      for (const length of [64, 65]) {
        add(`${pathLabel(path)} + key of ${length}`, false, (root) =>
          replaceAt(root, path, (old) =>
            addOwnKey(old, "k".repeat(length), structuredClone(firstValue))
          )
        );
        add(`${pathLabel(path)} + astral key of ${length}`, false, (root) =>
          replaceAt(root, path, (old) =>
            addOwnKey(old, astral(length), structuredClone(firstValue))
          )
        );
      }
      const limit = typeof key === "string" ? RECORD_BOUNDS[key] : undefined;
      if (limit !== undefined && path.at(-1) === key) {
        for (const size of [limit, limit + 1]) {
          add(`${pathLabel(path)} with ${size} entries`, false, (root) =>
            replaceAt(root, path, () =>
              Object.fromEntries(
                Array.from({ length: size }, (_, index) => [
                  `entry${index}`,
                  structuredClone(firstValue),
                ])
              )
            )
          );
        }
      }
    }
    if (Array.isArray(node)) {
      add(`${pathLabel(path)} + null item`, false, (root) =>
        replaceAt(root, path, (old) => (Array.isArray(old) ? [...old, null] : old))
      );
      add(`${pathLabel(path)} doubled`, false, (root) =>
        replaceAt(root, path, (old) =>
          Array.isArray(old) ? [...old, ...structuredClone(old)] : old
        )
      );
      const bounds = typeof key === "string" && path.at(-1) === key ? ARRAY_BOUNDS[key] : undefined;
      const seed = node[0] ?? "src/a.ts";
      for (const bound of bounds ?? []) {
        for (const size of [bound, bound + 1]) {
          add(`${pathLabel(path)} with ${size} items`, false, (root) =>
            replaceAt(root, path, () =>
              Array.from({ length: size }, (_, index) => {
                const item = structuredClone(seed) as unknown;
                return typeof item === "object" && item !== null && "id" in item
                  ? { ...item, id: `T${index + 1}` }
                  : item;
              })
            )
          );
        }
      }
    }
    if (typeof node === "string") {
      set(path, "other-text", `${node} edited`, true);
      for (const member of (typeof key === "string" ? ENUM_VALUES[key] : undefined) ?? []) {
        set(path, `enum ${member}`, member);
      }
      for (const bound of (typeof key === "string" ? STRING_BOUNDS[key] : undefined) ?? []) {
        for (const length of [bound, bound + 1]) {
          set(path, `ascii of ${length}`, "a".repeat(length));
          set(path, `astral of ${length}`, astral(length));
        }
      }
      if (/^[a-f0-9]{40,64}$/.test(node)) {
        set(path, "digest-40", hex("a", 40));
        set(path, "digest-64", hex("a"));
        set(path, "digest-63", hex("a", 63));
        set(path, "digest-uppercase", hex("A"));
        set(path, "digest-newline", `${hex("a")}\n`);
      }
      if (key === "writePaths" || key === "allowedWritePaths") {
        for (const [name, value] of WRITE_PATH_VALUES) set(path, `path ${name}`, value);
      }
    }
    if (typeof node === "number") {
      set(path, "other-number", node + 1, true);
      const range = typeof key === "string" ? NUMBER_RANGES[key] : undefined;
      if (range) {
        const [minimum, maximum] = range;
        for (const [name, value] of [
          ["below-range", minimum - 1],
          ["minimum", minimum],
          ["maximum", maximum],
          ["above-range", maximum + 1],
          ["fractional-in-range", minimum + (maximum - minimum) / 2 + 0.25],
        ] as const) {
          set(path, name, value);
        }
      }
    }
  }
  return operations;
}

/** mulberry32: small, seedable, and identical on every platform. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function casesFor(
  bases: Array<[string, unknown]>,
  options: { inMemory?: boolean; seed: number; combinations: number }
): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const next = random(options.seed);
  for (const [name, base] of bases) {
    cases.push({ label: `${name}: unchanged`, value: base });
    const operations = operationsFor(base, options.inMemory ?? false);
    const soft = operations.filter((operation) => operation.soft);
    const applied = (selected: Operation[]) => {
      const root = { value: structuredClone(base) };
      for (const operation of selected) operation.apply(root);
      return root.value;
    };
    for (const operation of operations) {
      cases.push({ label: `${name}: ${operation.label}`, value: applied([operation]) });
    }
    const pick = (from: Operation[]) => from[Math.floor(next() * from.length)] as Operation;
    for (let index = 0; index < options.combinations; index += 1) {
      // Half stay soft so that deep combinations of tolerated changes get accepted too.
      const from = index % 2 === 0 ? soft : operations;
      const selected = Array.from({ length: 2 + Math.floor(next() * 4) }, () => pick(from));
      const label = selected.map((operation) => operation.label).join(" & ");
      cases.push({ label: `${name}: #${index} ${label}`, value: applied(selected) });
    }
  }
  return cases;
}

/** JSON text, with the non-finite numbers that JSON.parse can still produce written as 1e999. */
export function toFileText(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (item === Number.POSITIVE_INFINITY) return "__POSITIVE_INFINITY__";
    if (item === Number.NEGATIVE_INFINITY) return "__NEGATIVE_INFINITY__";
    return item;
  });
  return (text ?? "null")
    .replaceAll('"__POSITIVE_INFINITY__"', "1e999")
    .replaceAll('"__NEGATIVE_INFINITY__"', "-1e999");
}

/** Stable text for hashing, keeping what JSON would lose from in-memory values. */
function caseText(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined) return "__UNDEFINED__";
      if (typeof item === "number" && !Number.isFinite(item)) return `__${item}__`;
      return item;
    }) ?? "__UNDEFINED__"
  );
}

function canonical(value: unknown, ignored: ReadonlySet<string> = new Set()): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (ignored.has(key)) return undefined;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    );
  });
}

function attempt_(read: () => unknown, ignored?: ReadonlySet<string>): Decision {
  try {
    return { accepted: true, output: canonical(read(), ignored) };
  } catch {
    return { accepted: false };
  }
}

const TIMESTAMPS = new Set(["createdAt", "updatedAt"]);
const TIERS = ["standard", "review"];
const PROFILES = ["unit"];

function readBoard(root: string, index: number, value: unknown): Decision {
  // A directory per case: the board cache is keyed by path and file identity.
  const cwd = join(root, String(index));
  mkdirSync(join(cwd, ".pi", "maestro"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "maestro", "board.json"), toFileText(value));
  const board = loadBoard(cwd);
  const quarantined = consumeQuarantineNotice();
  rmSync(cwd, { recursive: true, force: true });
  return quarantined ? { accepted: false } : { accepted: true, output: canonical(board) };
}

export interface CorpusFormat {
  name: string;
  cases(): CorpusCase[];
  read(value: unknown, index: number, scratch: string): Decision;
}

export const CORPUS_FORMATS: CorpusFormat[] = [
  {
    name: "board",
    cases: () =>
      casesFor(
        [
          ["full", fullBoard],
          ["legacy", { version: 1, nextTaskNumber: 3, tasks: [minimalTask] }],
          ["empty", { version: 1, nextTaskNumber: 1, tasks: [] }],
        ],
        { seed: 1, combinations: 1_500 }
      ),
    read: (value, index, scratch) => readBoard(scratch, index, value),
  },
  {
    name: "config",
    cases: () =>
      casesFor(
        [
          ["full", fullConfig],
          ["empty", {}],
          ["tier", { tiers: { standard: { thinking: "low" } } }],
        ],
        { seed: 2, combinations: 1_500, inMemory: true }
      ),
    read: (value) => {
      const error = validateConfig(value);
      return error === undefined ? { accepted: true, output: "" } : { accepted: false };
    },
  },
  {
    name: "recipe",
    cases: () =>
      casesFor(
        [
          ["full", fullRecipe],
          [
            "minimal",
            { kind: "pi-maestro-recipe", version: 1, name: "minimal", tasks: [recipeTask] },
          ],
        ],
        { seed: 3, combinations: 800 }
      ),
    read: (value) => attempt_(() => parseRecipe(toFileText(value))),
  },
  {
    name: "recipe-expansion",
    cases: () =>
      [
        ["short", "api"],
        ["title at limit", "a".repeat(482)],
        ["title past limit", "a".repeat(600)],
        ["astral past limit", "😀".repeat(300)],
        ["blank", "   "],
        ["number", 7],
        ["boolean", true],
        ["unexpanded", "{{input.other}}"],
      ].map(([label, target]) => ({ label: String(label), value: { target } })),
    read: (value) =>
      attempt_(() => {
        const recipe = parseRecipe(toFileText(fullRecipe));
        const input = value as { target: string };
        return expandRecipe(recipe, input, TIERS, PROFILES, 64, "single");
      }, TIMESTAMPS),
  },
  {
    name: "recipe-input",
    cases: () =>
      casesFor([["input", { target: "api", count: 2, flag: false }]], {
        seed: 4,
        combinations: 100,
      }),
    read: (value) => attempt_(() => parseRecipeInput(toFileText(value))),
  },
  {
    name: "plan",
    cases: () => casesFor([["full", fullPlan]], { seed: 5, combinations: 800 }),
    read: (value) => attempt_(() => importPlan(toFileText(value), TIERS, PROFILES, 64), TIMESTAMPS),
  },
  {
    name: "discovery",
    cases: () => casesFor([["full", fullDiscovery]], { seed: 6, combinations: 500 }),
    read: (value) => attempt_(() => parseDiscoveryOutput(toFileText(value))),
  },
];

export interface FormatResult {
  corpusSha256: string;
  outputsSha256: string;
  decisions: string;
  labels: string[];
}

export function evaluateFormat(format: CorpusFormat): FormatResult {
  const scratch = mkdtempSync(join(tmpdir(), "maestro-corpus-"));
  const corpus = createHash("sha256");
  const outputs = createHash("sha256");
  let decisions = "";
  const labels: string[] = [];
  try {
    for (const [index, { label, value }] of format.cases().entries()) {
      corpus.update(`${label}\n${caseText(value)}\n`);
      const decision = format.read(value, index, scratch);
      decisions += decision.accepted ? "1" : "0";
      labels.push(label);
      if (decision.output !== undefined) outputs.update(`${index}:${decision.output}\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return {
    corpusSha256: corpus.digest("hex"),
    outputsSha256: outputs.digest("hex"),
    decisions,
    labels,
  };
}
