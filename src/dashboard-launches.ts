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
        label: `review #${review.reviewerIndex ?? index + 1} · ${review.role ?? "reviewer"}`,
      });
    }
    return launches;
  });
}
