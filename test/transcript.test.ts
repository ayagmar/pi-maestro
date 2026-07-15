import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseLogLine, TranscriptTail, toolPreview } from "../src/transcript.js";

test("toolPreview formats bash, paths, and generic args", () => {
  assert.equal(toolPreview("bash", { command: "ls -la" }), "$ ls -la");
  assert.equal(toolPreview("read", { path: "src/index.ts" }), "read src/index.ts");
  assert.equal(toolPreview("write", { file_path: "a.txt" }), "write a.txt");
  assert.match(toolPreview("grep", { pattern: "foo" }), /^grep \{"pattern":"foo"\}$/);
});

test("parseLogLine maps events to transcript items", () => {
  assert.deepEqual(
    parseLogLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "make test" },
      })
    ),
    [{ kind: "tool", text: "$ make test" }]
  );
  assert.deepEqual(
    parseLogLine(JSON.stringify({ type: "tool_execution_end", toolName: "edit", isError: true })),
    [{ kind: "tool_error", text: "edit failed" }]
  );
  assert.deepEqual(
    parseLogLine(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      })
    ),
    [{ kind: "text", text: "Done." }]
  );
  assert.deepEqual(parseLogLine(JSON.stringify({ type: "agent_end" })), [
    { kind: "status", text: "— agent finished —" },
  ]);
  assert.deepEqual(parseLogLine(JSON.stringify({ type: "turn_start" })), []);
  assert.deepEqual(parseLogLine("not json"), []);
});

test("TranscriptTail reads incrementally across polls", () => {
  const dir = mkdtempSync(join(tmpdir(), "maestro-tail-"));
  const file = join(dir, "log.jsonl");
  try {
    const event1 = JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "ls" },
    });
    writeFileSync(file, `${event1}\n`);

    const tail = new TranscriptTail(file);
    tail.poll();
    assert.equal(tail.items.length, 1);
    assert.equal(tail.items[0]?.text, "$ ls");

    const event2 = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "listed files" }] },
    });
    writeFileSync(file, `${event1}\n${event2}\n`);
    tail.poll();
    assert.equal(tail.items.length, 2);
    assert.equal(tail.items[1]?.text, "listed files");

    // No new bytes: poll is a no-op
    tail.poll();
    assert.equal(tail.items.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TranscriptTail tolerates a missing file", () => {
  const tail = new TranscriptTail("/nonexistent/path/log.jsonl");
  tail.poll();
  assert.equal(tail.items.length, 0);
});
