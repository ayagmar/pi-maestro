import { type Attempt, type ReviewLaunch, type Task } from "./types.js";

export interface DashboardLaunch {
  key: string;
  kind: "execute" | "review";
  attempt: Attempt;
  review?: ReviewLaunch;
  label: string;
}

export function taskLaunches(task: Task): DashboardLaunch[] {
  return task.attempts.flatMap((attempt) => {
    const launches: DashboardLaunch[] = [
      {
        key: `${task.id}:execute:${attempt.index}`,
        kind: "execute",
        attempt,
        label: `execute #${attempt.index}`,
      },
    ];
    const legacyReview: ReviewLaunch = {
      id: `legacy-${attempt.index}`,
      role: "single",
      startedAt: attempt.endedAt ?? attempt.startedAt,
      usage: attempt.reviewUsage ?? { input: 0, output: 0, cost: 0, turns: 0 },
      ...(attempt.reviewModel ? { model: attempt.reviewModel } : {}),
      ...(attempt.reviewProvider ? { provider: attempt.reviewProvider } : {}),
      ...(attempt.reviewSessionFile ? { sessionFile: attempt.reviewSessionFile } : {}),
      ...(attempt.reviewReport ? { finalReport: attempt.reviewReport } : {}),
    };
    const reviews =
      attempt.reviewLaunches ??
      (attempt.reviewReport || attempt.reviewSessionFile || attempt.reviewModel
        ? [legacyReview]
        : []);
    for (const [index, review] of reviews.entries()) {
      launches.push({
        key: `${task.id}:review:${attempt.index}:${review.id ?? index + 1}`,
        kind: "review",
        attempt,
        review,
        // The cost ladder is only legible if the board says which side of it a
        // launch ran on, and what escalated a premium reviewer.
        label: `review #${review.reviewerIndex ?? index + 1} · ${review.role ?? "reviewer"}${review.costTier === "economy" ? " · economy" : ""}${review.escalationReason ? ` · escalated (${review.escalationReason})` : ""}`,
      });
    }
    return launches;
  });
}

/**
 * One executor or reviewer process launch. The log file is per raw launch
 * (startExecutor gives every launch its own transport id), so a later launch
 * of the same task and kind never shares it.
 */
export interface LiveLaunchIdentity {
  taskId: string;
  kind: "execute" | "review";
  logFile: string;
  /** The task attempt the launch belongs to; display only. */
  attemptIndex?: number;
}

export function sameLaunch(a: LiveLaunchIdentity, b: LiveLaunchIdentity): boolean {
  return a.taskId === b.taskId && a.kind === b.kind && a.logFile === b.logFile;
}

/** How operator prompts and notices name a launch, e.g. "T2 reviewer · attempt 1". */
export function launchTargetLabel(launch: LiveLaunchIdentity): string {
  const role = launch.kind === "review" ? "reviewer" : "executor";
  const attempt = launch.attemptIndex === undefined ? "" : ` · attempt ${launch.attemptIndex}`;
  return `${launch.taskId} ${role}${attempt}`;
}

/**
 * Why an operator action opened on `target` was not applied. The outcome
 * comes first so it survives truncation in a narrow pane.
 */
export function launchEndedNotice(
  target: LiveLaunchIdentity,
  current: LiveLaunchIdentity | undefined,
  outcome: "sent" | "aborted"
): string {
  const ended = `Nothing ${outcome}: ${launchTargetLabel(target)} ended`;
  return current ? `${ended}; ${launchTargetLabel(current)} runs now` : ended;
}
