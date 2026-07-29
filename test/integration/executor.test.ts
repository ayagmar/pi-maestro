import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTask, loadBoard, saveBoard } from "../../src/board.js";
import { DEFAULT_CONFIG, saveConfig } from "../../src/config.js";
import { startExecutor } from "../../src/runner.js";
import { type Board, type MaestroConfig } from "../../src/types.js";
import { driveBoard } from "../../src/workflow.js";
import { startStubModelServer } from "../helpers/stub-model-server.js";

/**
 * End-to-end coverage with a real `pi --mode rpc` subprocess.
 *
 * Every other suite substitutes a plain object for the executor, so the RPC
 * transport, session writing, tool execution, Git attribution, and process
 * teardown are never exercised. Four production bugs — a signing prompt that
 * froze the editor, force-removed uncommitted work, recursive transcript
 * reads, and files missing from isolated checkouts — all lived in exactly that
 * gap while the unit suites stayed green.
 *
 * The model is a local scripted HTTP endpoint, so this costs no tokens and
 * makes no outbound request.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const stubExtension = join(fixtures, "stub-provider-extension.ts");

/**
 * These spawn a real pi binary. It ships as a devDependency, so `pnpm install`
 * always provides one and CI runs these for real. Only an explicit opt-out
 * skips them; silently skipping is how a broken integration layer stays green.
 */
function missingPiBinary(): string | false {
  try {
    execFileSync("pi", ["--version"], { stdio: "ignore", timeout: 30_000 });
    return false;
  } catch {
    return "pi binary not runnable; run pnpm install";
  }
}

const skip = process.env.MAESTRO_SKIP_INTEGRATION === "1" ? "opted out" : missingPiBinary();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "maestro-executor-integration-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.com");
  writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
  writeFileSync(join(cwd, "target.txt"), "before\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");
  return cwd;
}

function integrationConfig(overrides: Partial<MaestroConfig> = {}): MaestroConfig {
  return {
    ...DEFAULT_CONFIG,
    maxParallel: 1,
    maxAttempts: 1,
    autoCommit: true,
    livePanes: false,
    statusWaitSeconds: 0,
    // A scripted model needs no thinking budget and no extra tools.
    tiers: {
      standard: { thinking: "off", model: "maestro-stub/stub-model" },
      review: { thinking: "off", model: "maestro-stub/stub-model" },
    },
    ...overrides,
  };
}

/** Route the spawned executor at the stub endpoint and keep it fully offline. */
function withStubEnvironment<T>(baseUrl: string, agentDir: string, run: () => Promise<T>) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    MAESTRO_STUB_BASE_URL: baseUrl,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_CODING_AGENT_DIR: agentDir,
    // Select the installed binary: under the test runner argv[1] is this test
    // file, which startExecutor would otherwise try to re-execute as pi.
    PI_MAESTRO_EXECUTOR_COMMAND: "pi",
    PI_MAESTRO_EXECUTOR_EXTENSIONS: stubExtension,
  });
  return run().finally(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });
}

test("a real pi executor implements, is reviewed, and is committed end to end", {
  timeout: 180_000,
  skip,
}, async () => {
  const cwd = repository();
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-integration-agent-"));
  // The executor edits a file with bash; the reviewer approves what it sees.
  const server = await startStubModelServer([
    { bash: "printf 'after\\n' > target.txt" },
    { text: "## Report\nRewrote target.txt.\n\nVERDICT: APPROVE" },
  ]);

  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    createTask(board, {
      title: "Rewrite the target file",
      brief: "Replace the contents of target.txt with the word after.",
      tier: "standard",
      writePaths: ["target.txt"],
      successCriteria: ["target.txt contains after"],
    });
    saveBoard(cwd, board);
    const config = integrationConfig();
    saveConfig("project", cwd, config);

    const summary = await withStubEnvironment(server.baseUrl, agentDir, () =>
      driveBoard({
        cwd,
        config,
        resolvedTiers: new Map([
          ["standard", config.tiers.standard as { thinking: "off"; model: string }],
          ["review", config.tiers.review as { thinking: "off"; model: string }],
        ]),
        startExecutor,
        onUpdate: () => {},
        trackRun: () => () => {},
      })
    );

    assert.equal(summary.stoppedBecause.code, "completed", summary.stoppedBecause.message);

    const task = loadBoard(cwd).tasks[0];
    assert.equal(task?.status, "approved");
    // The real subprocess produced a session transcript and a report.
    assert.ok(task?.attempts.at(-1)?.sessionFile, "the executor must record its session file");
    assert.ok(
      existsSync(task?.attempts.at(-1)?.sessionFile ?? ""),
      "the recorded session file must exist on disk"
    );
    // Its bash edit was attributed and committed, not just claimed.
    assert.match(readFileSync(join(cwd, "target.txt"), "utf-8"), /after/);
    assert.match(git(cwd, "log", "-1", "--pretty=%s"), /target file/i);
    assert.equal(git(cwd, "status", "--porcelain"), "");
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a real executor drive completes when the user requires GPG signing", {
  timeout: 180_000,
  skip,
}, async () => {
  const cwd = repository();
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-integration-agent-"));
  // The exact reported setup: signing on, signing key unusable. Before the
  // fix this blocked gpg on a pinentry prompt that could never appear and
  // froze the whole editor, because git runs synchronously on the main thread.
  git(cwd, "config", "commit.gpgsign", "true");
  git(cwd, "config", "user.signingkey", "DEADBEEFDEADBEEF");
  const server = await startStubModelServer([
    { bash: "printf 'signed-path\\n' > target.txt" },
    { text: "## Report\nRewrote target.txt.\n\nVERDICT: APPROVE" },
  ]);

  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    createTask(board, {
      title: "Rewrite under signing",
      brief: "Replace the contents of target.txt.",
      tier: "standard",
      writePaths: ["target.txt"],
      successCriteria: ["target.txt is rewritten"],
    });
    saveBoard(cwd, board);
    // Isolated checkouts are where signing actually bites: the attempt
    // checkpoint and the integration merge are both real commits.
    const config = integrationConfig({ useWorktrees: true });
    saveConfig("project", cwd, config);

    const summary = await withStubEnvironment(server.baseUrl, agentDir, () =>
      driveBoard({
        cwd,
        config,
        resolvedTiers: new Map([
          ["standard", config.tiers.standard as { thinking: "off"; model: string }],
          ["review", config.tiers.review as { thinking: "off"; model: string }],
        ]),
        startExecutor,
        onUpdate: () => {},
        trackRun: () => () => {},
      })
    );

    assert.equal(summary.stoppedBecause.code, "completed", summary.stoppedBecause.message);
    assert.equal(loadBoard(cwd).tasks[0]?.status, "approved");
    assert.match(readFileSync(join(cwd, "target.txt"), "utf-8"), /signed-path/);
    // The work landed as an unsigned commit rather than blocking on gpg.
    assert.equal(git(cwd, "log", "-1", "--pretty=%G?"), "N");
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a rejection retry resumes the real executor session with its history intact", {
  timeout: 240_000,
  skip,
}, async () => {
  const cwd = repository();
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-integration-agent-"));
  // attempt 1: edits the file wrong and reports; review 1: rejects with one
  // criterion finding; attempt 2 (resumed session): fixes it; review 2 (and
  // any overflow turns): approves.
  const server = await startStubModelServer([
    { bash: "printf 'first-pass\\n' > target.txt" },
    { text: "## Report\nWrote first-pass into target.txt." },
    { text: "VERDICT: REQUEST_CHANGES\n1. Criterion 1: target.txt must contain the word final." },
    { bash: "printf 'final\\n' > target.txt" },
    { text: "## Report\nReplaced first-pass with final as the reviewer required." },
    { text: "Verified target.txt contains final.\nVERDICT: APPROVE" },
  ]);

  try {
    const board: Board = { version: 1, nextTaskNumber: 1, tasks: [] };
    createTask(board, {
      title: "Write final into the target file",
      brief: "Replace the contents of target.txt with the word final.",
      tier: "standard",
      writePaths: ["target.txt"],
      successCriteria: ["target.txt contains final"],
    });
    saveBoard(cwd, board);
    const config = integrationConfig({ maxAttempts: 2 });
    saveConfig("project", cwd, config);

    const summary = await withStubEnvironment(server.baseUrl, agentDir, () =>
      driveBoard({
        cwd,
        config,
        resolvedTiers: new Map([
          ["standard", config.tiers.standard as { thinking: "off"; model: string }],
          ["review", config.tiers.review as { thinking: "off"; model: string }],
        ]),
        startExecutor,
        onUpdate: () => {},
        trackRun: () => () => {},
      })
    );

    assert.equal(summary.stoppedBecause.code, "completed", summary.stoppedBecause.message);
    const task = loadBoard(cwd).tasks[0];
    assert.equal(task?.status, "approved");
    assert.equal(task?.attempts.length, 2);

    // The retry appended to the first attempt's transcript instead of
    // starting a new session.
    const firstSession = task?.attempts[0]?.sessionFile;
    const secondSession = task?.attempts[1]?.sessionFile;
    assert.ok(firstSession, "attempt 1 must record its session file");
    assert.equal(secondSession, firstSession, "the retry must resume the same session");
    const transcript = readFileSync(firstSession ?? "", "utf-8");
    assert.match(transcript, /first-pass/);
    assert.match(transcript, /as the reviewer required/);

    // The resumed model request carried the conversation history (the brief
    // from attempt 1) plus the findings-only follow-up — no re-sent brief, no
    // re-reading of the repository.
    const resumedRequest = server.requests.find((request) =>
      request.includes("A reviewer rejected your work")
    );
    assert.ok(resumedRequest, "the retry must send the findings follow-up");
    assert.match(resumedRequest ?? "", /Replace the contents of target\.txt/);
    assert.equal(
      (resumedRequest ?? "").split("A reviewer rejected your work").length,
      2,
      "the follow-up must appear exactly once in the resumed request"
    );

    // Usage on the resumed attempt counts only its own new messages; replayed
    // history must not be re-billed into the attempt record.
    const retryTurns = task?.attempts[1]?.usage.turns ?? 0;
    assert.ok(retryTurns >= 1 && retryTurns <= 4, `retry recorded ${retryTurns} turns`);

    // The reviewer's demanded fix actually landed and was committed.
    assert.match(readFileSync(join(cwd, "target.txt"), "utf-8"), /final/);
    assert.equal(git(cwd, "status", "--porcelain"), "");
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
