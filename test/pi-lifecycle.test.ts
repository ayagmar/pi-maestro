import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadBoard, saveBoard } from "../src/board.js";

interface RpcMessage {
  id?: string;
  type: string;
  success?: boolean;
  data?: Record<string, unknown>;
}

class RpcClient {
  private buffer = "";
  private readonly messages: RpcMessage[] = [];

  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    process.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.messages.push(JSON.parse(line) as RpcMessage);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  async request(type: string, fields: Record<string, unknown> = {}): Promise<RpcMessage> {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.process.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return await this.waitFor((message) => message.type === "response" && message.id === id);
  }

  private async waitFor(match: (message: RpcMessage) => boolean): Promise<RpcMessage> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(match);
      if (index !== -1) {
        const [message] = this.messages.splice(index, 1);
        if (!message) throw new Error("Matched Pi RPC response disappeared");
        return message;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error("Timed out waiting for Pi RPC response");
  }
}

async function waitForBoard(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Timed out waiting for the lifecycle board update");
}

test("real Pi reload preserves owner-only decision delivery and foreign drive ownership", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-maestro-lifecycle-"));
  const sessionDir = join(cwd, "sessions");
  const agentDir = join(cwd, "agent");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const repository = resolve(import.meta.dirname, "..");
  const child = spawn(
    "pi",
    [
      "--mode",
      "rpc",
      "--offline",
      "--approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--session-dir",
      sessionDir,
      "--extension",
      join(repository, "src/index.ts"),
      "--extension",
      join(repository, "test/fixtures/pi-lifecycle-extension.ts"),
    ],
    {
      cwd,
      env: {
        HOME: join(cwd, "home"),
        PATH: process.env.PATH,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
      },
    }
  );
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    const rpc = new RpcClient(child);
    const state = await rpc.request("get_state");
    assert.equal(state.success, true, Buffer.concat(stderr).toString("utf8"));
    const ownerSession = state.data?.sessionFile;
    assert.equal(typeof ownerSession, "string");

    const decisionId = "persisted-before-real-reload";
    const seed = await rpc.request("prompt", {
      message: `/seed-lifecycle-message ${decisionId}`,
    });
    assert.equal(seed.success, true);
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      tasks: [],
      activeDecision: {
        id: decisionId,
        ownerSession: ownerSession as string,
        kind: "blocked",
        taskIds: [],
        evidence: "Must not be delivered twice after reload",
        allowedInterventions: ["handoff"],
        createdAt: Date.now(),
        deliveryClaim: { id: "interrupted-real-delivery", claimedAt: Date.now() },
      },
    });

    const reload = await rpc.request("prompt", { message: "/reload-lifecycle" });
    assert.equal(reload.success, true);
    await waitForBoard(() => loadBoard(cwd).activeDecision?.deliveredAt !== undefined);
    const messages = await rpc.request("get_messages");
    assert.ok(Array.isArray(messages.data?.messages));
    const persistedMessages = messages.data.messages.filter(
      (message) => message.customType === "pi-lifecycle-test"
    );
    assert.equal(persistedMessages.length, 1);

    const foreignDecisionId = "foreign-real-reload";
    saveBoard(cwd, {
      version: 1,
      nextTaskNumber: 1,
      tasks: [],
      activeDecision: {
        id: foreignDecisionId,
        ownerSession: "/foreign/session.jsonl",
        kind: "blocked",
        taskIds: [],
        evidence: "Foreign decision",
        allowedInterventions: ["handoff"],
        createdAt: Date.now(),
      },
      activeDrive: {
        id: "foreign-drive",
        ownerSession: "/foreign/session.jsonl",
        startedAt: Date.now(),
      },
    });

    const foreignReload = await rpc.request("prompt", { message: "/reload-lifecycle" });
    assert.equal(foreignReload.success, true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const foreignBoard = loadBoard(cwd);
    assert.equal(foreignBoard.activeDecision?.deliveredAt, undefined);
    assert.equal(foreignBoard.activeDrive?.id, "foreign-drive");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", () => resolveExit());
    });
    rmSync(cwd, { recursive: true, force: true });
  }
});
