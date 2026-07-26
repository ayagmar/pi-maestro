import { type Attempt } from "../../src/types.js";
import { type ExecutorHandle, type RunOutcome } from "../../src/runner.js";
import { type StartExecutor } from "../../src/workflow.js";

/** A launch with no recorded work, used as the starting point for a fake run. */
export function executorAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    index: 0,
    logFile: "test.jsonl",
    thinking: "low",
    startedAt: Date.now(),
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    touchedFiles: [],
    ...overrides,
  };
}

export function runOutcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    exitCode: 0,
    usage: { input: 1, output: 1, cost: 0, turns: 1 },
    finalReport: "done",
    touchedFiles: [],
    aborted: false,
    ...overrides,
  };
}

/** True when a launch id belongs to a reviewer rather than an executor. */
export function isReviewLaunch(runId: string): boolean {
  return runId.includes("-review-");
}

/**
 * An executor that settles immediately: executors report work, reviewers
 * approve. This is the "nothing goes wrong" baseline most drive tests want,
 * so they can assert scheduling and settlement rather than restate it.
 */
export function settlingExecutor(
  overrides: (runId: string) => Partial<RunOutcome> = () => ({})
): StartExecutor {
  return (options) => ({
    attempt: executorAttempt(),
    outcome: Promise.resolve(
      runOutcome({
        finalReport: isReviewLaunch(options.runId) ? "VERDICT: APPROVE" : "done",
        ...overrides(options.runId),
      })
    ),
    steer: () => {},
    followUp: () => {},
    abort: () => {},
  });
}

export interface HeldRun {
  runId: string;
  handle: ExecutorHandle;
  settle(outcome?: Partial<RunOutcome>): void;
}

/**
 * Executors that stay live until the test settles them, for asserting
 * behavior *during* a run: live panes, steering, pause, and abort.
 */
export function heldExecutors(): {
  start: StartExecutor;
  runs: HeldRun[];
  steered: string[];
  followedUp: string[];
  settleAll(outcome?: Partial<RunOutcome>): void;
} {
  const runs: HeldRun[] = [];
  const steered: string[] = [];
  const followedUp: string[] = [];

  const start: StartExecutor = (options) => {
    let settle: (outcome: RunOutcome) => void = () => {};
    const outcome = new Promise<RunOutcome>((resolve) => {
      settle = resolve;
    });
    const handle: ExecutorHandle = {
      attempt: executorAttempt({ logFile: `${options.runId}.jsonl` }),
      outcome,
      steer: (message) => steered.push(`${options.runId}:${message}`),
      followUp: (message) => followedUp.push(`${options.runId}:${message}`),
      abort: () => settle(runOutcome({ exitCode: 1, aborted: true, failureCause: "user_abort" })),
    };
    runs.push({
      runId: options.runId,
      handle,
      settle: (partial) =>
        settle(
          runOutcome({
            finalReport: isReviewLaunch(options.runId) ? "VERDICT: APPROVE" : "done",
            ...partial,
          })
        ),
    });
    return handle;
  };

  return {
    start,
    runs,
    steered,
    followedUp,
    settleAll: (outcome) => {
      for (const run of runs) run.settle(outcome);
    },
  };
}

/** Poll until a condition holds, for state a background drive reaches asynchronously. */
export async function waitFor(
  predicate: () => boolean,
  message: string,
  attempts = 200
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}`);
}
