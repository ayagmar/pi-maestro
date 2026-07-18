import assert from "node:assert/strict";
import test from "node:test";
import { createRenderThrottle } from "../src/render-scheduler.js";

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
}

function fakeScheduler(startAt = 0) {
  let currentTime = startAt;
  const timers: FakeTimer[] = [];
  return {
    now: () => currentTime,
    advance(ms: number) {
      currentTime += ms;
      for (const timer of timers.splice(0)) {
        if (!timer.cleared) timer.callback();
      }
    },
    setTimer: (callback: () => void, delayMs: number) => {
      const timer: FakeTimer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer: NodeJS.Timeout) => {
      (timer as unknown as FakeTimer).cleared = true;
    },
    pendingDelays: () => timers.filter((timer) => !timer.cleared).map((timer) => timer.delayMs),
  };
}

test("leading call renders synchronously and bursts coalesce into one trailing render", () => {
  const scheduler = fakeScheduler();
  const rendered: string[] = [];
  const throttle = createRenderThrottle((value: string) => rendered.push(value), {
    intervalMs: 100,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  // First call in a quiet period is synchronous.
  throttle.schedule("first");
  assert.deepEqual(rendered, ["first"]);

  // Burst inside the interval: queued once, latest arguments win.
  throttle.schedule("second");
  throttle.schedule("third");
  throttle.schedule("fourth");
  assert.deepEqual(rendered, ["first"]);
  assert.equal(scheduler.pendingDelays().length, 1);

  scheduler.advance(100);
  assert.deepEqual(rendered, ["first", "fourth"]);

  // Quiet period over: next call is synchronous again.
  scheduler.advance(100);
  throttle.schedule("fifth");
  assert.deepEqual(rendered, ["first", "fourth", "fifth"]);
});

test("flush runs the queued trailing render immediately and cancel drops it", () => {
  const scheduler = fakeScheduler();
  const rendered: string[] = [];
  const throttle = createRenderThrottle((value: string) => rendered.push(value), {
    intervalMs: 50,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  throttle.schedule("lead");
  throttle.schedule("queued");
  throttle.flush();
  assert.deepEqual(rendered, ["lead", "queued"]);
  // Flushing with nothing queued is a no-op.
  throttle.flush();
  assert.deepEqual(rendered, ["lead", "queued"]);

  throttle.schedule("next-lead");
  assert.deepEqual(rendered, ["lead", "queued"]);
  scheduler.advance(50);
  assert.deepEqual(rendered, ["lead", "queued", "next-lead"]);

  throttle.schedule("cancelled");
  throttle.cancel();
  scheduler.advance(1000);
  assert.deepEqual(rendered, ["lead", "queued", "next-lead"]);
});

test("real-timer defaults render the leading edge synchronously", () => {
  const rendered: number[] = [];
  const throttle = createRenderThrottle((value: number) => rendered.push(value), {
    intervalMs: 10_000,
  });
  throttle.schedule(1);
  assert.deepEqual(rendered, [1]);
  throttle.schedule(2);
  throttle.cancel(); // do not leave a timer pending in the test process
  assert.deepEqual(rendered, [1]);
});
