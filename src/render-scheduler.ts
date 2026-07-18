/**
 * Leading-edge throttle with trailing coalescing for hot render paths.
 *
 * The first call in a quiet period runs synchronously, so single-shot
 * callers (commands, tests) observe their effect immediately. Calls that
 * arrive inside the interval are coalesced into exactly one trailing run
 * with the most recent arguments.
 *
 * The clock and timer functions are injectable so tests can drive the
 * trailing edge deterministically.
 */
export interface RenderSchedulerOptions {
  intervalMs: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export function createRenderThrottle<TArgs extends unknown[]>(
  render: (...args: TArgs) => void,
  options: RenderSchedulerOptions
): { schedule: (...args: TArgs) => void; flush: () => void; cancel: () => void } {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
  const clearTimer = options.clearTimer ?? ((timer: NodeJS.Timeout) => clearTimeout(timer));

  let lastRunAt = Number.NEGATIVE_INFINITY;
  let pending: { timer: NodeJS.Timeout; args: TArgs } | undefined;

  const run = (args: TArgs) => {
    lastRunAt = now();
    render(...args);
  };

  return {
    schedule: (...args: TArgs) => {
      const elapsed = now() - lastRunAt;
      if (pending) {
        // A trailing run is queued; refresh its arguments.
        pending.args = args;
        return;
      }
      if (elapsed >= options.intervalMs) {
        run(args);
        return;
      }
      const timer = setTimer(() => {
        const queued = pending;
        pending = undefined;
        if (queued) run(queued.args);
      }, options.intervalMs - elapsed);
      pending = { timer, args };
    },
    flush: () => {
      const queued = pending;
      if (!queued) return;
      clearTimer(queued.timer);
      pending = undefined;
      run(queued.args);
    },
    cancel: () => {
      if (!pending) return;
      clearTimer(pending.timer);
      pending = undefined;
    },
  };
}
