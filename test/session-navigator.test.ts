import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionNavigator } from "../src/session-navigator.js";

function navigatorContext(current: string, cancelled: boolean) {
  const switched: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: () => {} },
    sessionManager: { getSessionFile: () => current },
    switchSession: async (sessionFile: string) => {
      switched.push(sessionFile);
      return { cancelled };
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, switched };
}

const idle = { hasActiveDrive: () => false, liveRunCount: () => 0, isTaskLive: () => false };

test("back keeps its return target when the session switch is cancelled", async () => {
  const navigator = new SessionNavigator(idle);
  navigator.setPrevious("/sessions/supervisor.jsonl");

  const cancelled = navigatorContext("/sessions/executor.jsonl", true);
  await navigator.back(cancelled.ctx);
  assert.deepEqual(cancelled.switched, ["/sessions/supervisor.jsonl"]);

  // The retry still targets the supervisor, not the session it never left.
  const retry = navigatorContext("/sessions/executor.jsonl", false);
  await navigator.back(retry.ctx);
  assert.deepEqual(retry.switched, ["/sessions/supervisor.jsonl"]);

  // A completed switch makes the session it left the next return target.
  const returned = navigatorContext("/sessions/supervisor.jsonl", false);
  await navigator.back(returned.ctx);
  assert.deepEqual(returned.switched, ["/sessions/executor.jsonl"]);
});
