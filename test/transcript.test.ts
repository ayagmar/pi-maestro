import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  const capped = parseLogLine(
    JSON.stringify({ type: "maestro_log_capped", maxBytes: 1_000_000, writtenBytes: 999_950 })
  );
  assert.equal(capped[0]?.kind, "notice");
  assert.match(capped[0]?.text ?? "", /1\.0 MB cap/);
  assert.match(capped[0]?.text ?? "", /run continues/);
  assert.deepEqual(parseLogLine(JSON.stringify({ type: "agent_settled" })), [
    { kind: "status", text: "— agent finished —" },
  ]);
  // A retry, compaction, or queued follow-up can follow agent_end.
  assert.deepEqual(parseLogLine(JSON.stringify({ type: "agent_end", willRetry: true })), []);
  assert.deepEqual(parseLogLine(JSON.stringify({ type: "agent_end", willRetry: false })), []);
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

test("TranscriptTail keeps a multi-byte character split across polls intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "maestro-tail-utf8-"));
  const file = join(dir, "log.jsonl");
  try {
    const line = Buffer.from(
      `${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "café ✓ done" }] },
      })}\n`
    );
    // The writer is mid-line, and mid-character, when the first poll runs.
    const split = line.indexOf(Buffer.from("é")) + 1;
    writeFileSync(file, line.subarray(0, split));
    const tail = new TranscriptTail(file);
    tail.poll();
    assert.equal(tail.items.length, 0);

    appendFileSync(file, line.subarray(split));
    tail.poll();
    assert.deepEqual(tail.items, [{ kind: "text", text: "café ✓ done" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TranscriptTail starts over when the log file is replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "maestro-tail-replace-"));
  const file = join(dir, "log.jsonl");
  const event = (command: string) =>
    `${JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command } })}\n`;
  try {
    writeFileSync(file, event("first"));
    const tail = new TranscriptTail(file);
    tail.poll();
    assert.deepEqual(
      tail.items.map((item) => item.text),
      ["$ first"]
    );

    // A replacement at least as large as what was read must not be read
    // from the old offset.
    const replacement = join(dir, "replacement.jsonl");
    writeFileSync(replacement, `${event("second")}${event("third")}`);
    renameSync(replacement, file);
    tail.poll();
    assert.deepEqual(
      tail.items.map((item) => item.text),
      ["$ second", "$ third"]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
