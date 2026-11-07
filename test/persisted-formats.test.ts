import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { consumeQuarantineNotice, loadBoard } from "../src/board.js";
import { CORPUS_FORMATS, evaluateFormat } from "./helpers/persisted-corpus.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Accept/reject decisions recorded from the hand-written guards that validated
 * these formats before pi-schema. Files on users' disks were accepted by those
 * guards, so a difference here is a compatibility break, not a stale fixture.
 * Re-record (MAESTRO_RECORD_DECISIONS=1) only for an intended format change.
 */
const decisionsFile = join(testDirectory, "fixtures", "persisted-decisions.json");

interface Recorded {
  corpusSha256: string;
  outputsSha256: string;
  decisions: string;
}

if (process.env.MAESTRO_RECORD_DECISIONS) {
  const recorded: Record<string, Recorded> = {};
  for (const format of CORPUS_FORMATS) {
    const { labels: _labels, ...result } = evaluateFormat(format);
    recorded[format.name] = result;
  }
  writeFileSync(decisionsFile, `${JSON.stringify(recorded, null, 2)}\n`);
}

const recorded = JSON.parse(readFileSync(decisionsFile, "utf-8")) as Record<string, Recorded>;

for (const format of CORPUS_FORMATS) {
  test(`${format.name} files keep their recorded accept/reject decisions`, () => {
    const expected = recorded[format.name] as Recorded;
    const actual = evaluateFormat(format);
    assert.equal(actual.corpusSha256, expected.corpusSha256, "the generated corpus changed");
    const differences = actual.labels.flatMap((label, index) =>
      actual.decisions[index] === expected.decisions[index]
        ? []
        : [`${expected.decisions[index] === "1" ? "now rejects" : "now accepts"}: ${label}`]
    );
    assert.deepEqual(differences, []);
    assert.equal(actual.outputsSha256, expected.outputsSha256, "an accepted file changed meaning");
  });
}

/**
 * Boards persisted by commit 8023ad8, the previous release line, captured from
 * its own write path. Together they cover every field path that build wrote.
 */
const releasedBoards = join(testDirectory, "fixtures", "boards-8023ad8");

for (const name of readdirSync(releasedBoards)) {
  test(`released board ${name} loads unchanged`, () => {
    const contents = readFileSync(join(releasedBoards, name), "utf-8");
    const cwd = mkdtempSync(join(tmpdir(), "maestro-released-board-"));
    try {
      mkdirSync(join(cwd, ".pi", "maestro"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "maestro", "board.json"), contents);
      assert.deepEqual(loadBoard(cwd), JSON.parse(contents));
      assert.equal(consumeQuarantineNotice(), undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
