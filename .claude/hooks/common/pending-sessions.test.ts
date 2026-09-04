import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  findUnprocessedSessions,
  type UnprocessedSessionsOptions,
} from "./pending-sessions.ts";

const tmpDir = mkdtempSync(join(tmpdir(), "muhely-hooks-"));

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const canTestUnreadableFile = process.getuid?.() !== 0;

/** Creates a fresh transcripts/retrospectives directory pair under `tmpDir`. */
function makeSessionDirs(name: string): {
  transcriptsDir: string;
  retrospectivesDir: string;
} {
  const base = join(tmpDir, name);
  const transcriptsDir = join(base, "transcripts");
  const retrospectivesDir = join(base, "retrospectives");
  mkdirSync(transcriptsDir, { recursive: true });
  mkdirSync(retrospectivesDir, { recursive: true });
  return { transcriptsDir, retrospectivesDir };
}

/** A transcript with `count` plain tool_use blocks, one per assistant line. */
function transcriptWithToolUses(count: number): string {
  const lines = Array.from({ length: count }, () =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
    }),
  );
  return `${lines.join("\n")}\n`;
}

/**
 * A transcript with `total` tool_use blocks where the block at position
 * `retroAt` (1-based) is a `retrospective` skill invocation.
 */
function transcriptWithLateRetrospective(
  total: number,
  retroAt: number,
): string {
  const lines = Array.from({ length: total }, (_unused, index) => {
    const position = index + 1;
    const isRetro = position === retroAt;
    return JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: isRetro ? "Skill" : "Read",
            input: isRetro ? { skill: "retrospective" } : {},
          },
        ],
      },
    });
  });
  return `${lines.join("\n")}\n`;
}

/** Writes a transcript file with the given tool-use count and mtime (in ms). */
function writeTranscriptFile(
  dir: string,
  sessionId: string,
  content: string,
  mtimeMs: number,
): string {
  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, content, "utf8");
  utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

/** Writes a retrospective marker file with an explicit mtime (in ms). */
function writeMarkerFile(
  retrospectivesDir: string,
  fileName: string,
  content: string,
  mtimeMs: number,
): string {
  const filePath = join(retrospectivesDir, fileName);
  writeFileSync(filePath, content, "utf8");
  utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

const NOW = 2_000_000_000_000;
const IDLE_MS = 60_000;
const MAX_AGE_MS = 1000 * 60 * 60 * 24;
const MIN_TOOL_USES = 5;
const QUALIFYING_MTIME = NOW - IDLE_MS - 1000;

function baseOptions(
  transcriptsDir: string,
  retrospectivesDir: string,
): UnprocessedSessionsOptions {
  return {
    transcriptsDir,
    retrospectivesDir,
    currentSessionId: "current-session",
    now: NOW,
    minToolUses: MIN_TOOL_USES,
    idleMs: IDLE_MS,
    maxAgeMs: MAX_AGE_MS,
    limit: 10,
  };
}

test("findUnprocessedSessions lists a qualifying session", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs("qualifying");
  const transcriptPath = writeTranscriptFile(
    transcriptsDir,
    "session-a",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.sessionId, "session-a");
  assert.equal(result[0]?.transcriptPath, transcriptPath);
  assert.equal(result[0]?.toolUseTotal, 10);
});

test("findUnprocessedSessions skips the current session", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs("current");
  writeTranscriptFile(
    transcriptsDir,
    "current-session",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.deepEqual(result, []);
});

test("findUnprocessedSessions skips a session with a fresh (possibly live) mtime", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs("fresh");
  writeTranscriptFile(
    transcriptsDir,
    "session-fresh",
    transcriptWithToolUses(10),
    NOW - 10,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.deepEqual(result, []);
});

test("findUnprocessedSessions skips a session older than the max age", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs("too-old");
  writeTranscriptFile(
    transcriptsDir,
    "session-old",
    transcriptWithToolUses(10),
    NOW - MAX_AGE_MS - 1000,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.deepEqual(result, []);
});

test("findUnprocessedSessions skips a session below the minimum tool uses", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs("too-few");
  writeTranscriptFile(
    transcriptsDir,
    "session-few",
    transcriptWithToolUses(2),
    QUALIFYING_MTIME,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.deepEqual(result, []);
});

test("findUnprocessedSessions skips a session with an existing retrospective marker and no new activity since it", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs("has-md");
  writeTranscriptFile(
    transcriptsDir,
    "abcdefgh-ijkl",
    transcriptWithLateRetrospective(10, 8),
    QUALIFYING_MTIME,
  );
  writeMarkerFile(
    retrospectivesDir,
    "2026-01-01-abcdefgh.md",
    "content",
    QUALIFYING_MTIME - 5000,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.deepEqual(result, []);
});

test("findUnprocessedSessions skips a session with an existing skipped marker and no new activity since it", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs("has-skip");
  writeTranscriptFile(
    transcriptsDir,
    "abcdefgh-ijkl",
    transcriptWithLateRetrospective(10, 8),
    QUALIFYING_MTIME,
  );
  writeMarkerFile(
    retrospectivesDir,
    "2026-01-01-abcdefgh.skipped.md",
    "Skipped by user.",
    QUALIFYING_MTIME - 5000,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.deepEqual(result, []);
});

test("findUnprocessedSessions matches a marker file name that starts with the id prefix with no leading dash", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs(
    "marker-prefix-no-dash",
  );
  writeTranscriptFile(
    transcriptsDir,
    "abcdefgh-noleaddash",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME,
  );
  writeMarkerFile(
    retrospectivesDir,
    "abcdefgh.md",
    "content",
    QUALIFYING_MTIME + 5000,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.deepEqual(result, []);
});

test(
  "findUnprocessedSessions skips a .skipped.md session without scanning its unreadable transcript",
  { skip: !canTestUnreadableFile },
  async (t) => {
    const { transcriptsDir, retrospectivesDir } =
      makeSessionDirs("skipped-unreadable");
    const transcriptPath = writeTranscriptFile(
      transcriptsDir,
      "abcdefgh-unreadable",
      transcriptWithToolUses(10),
      QUALIFYING_MTIME,
    );
    writeMarkerFile(
      retrospectivesDir,
      "2026-01-01-abcdefgh.skipped.md",
      "Skipped by user.",
      QUALIFYING_MTIME - 5000,
    );
    chmodSync(transcriptPath, 0o000);

    const stderrWrite = t.mock.method(process.stderr, "write", () => true);

    try {
      const result = await findUnprocessedSessions(
        baseOptions(transcriptsDir, retrospectivesDir),
      );
      assert.deepEqual(result, []);
      assert.equal(stderrWrite.mock.callCount(), 0);
    } finally {
      chmodSync(transcriptPath, 0o644);
    }
  },
);

test("findUnprocessedSessions skips a session whose marker is newer than the transcript, even with no in-transcript retrospective", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs(
    "marker-newer-than-transcript",
  );
  writeTranscriptFile(
    transcriptsDir,
    "dddddddd-freshmarker",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME,
  );
  writeMarkerFile(
    retrospectivesDir,
    "2026-01-01-dddddddd.md",
    "content",
    QUALIFYING_MTIME + 5000,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.deepEqual(result, []);
});

test("findUnprocessedSessions re-offers a session with a marker older than the transcript once enough new tool use happened after its recorded retrospective", async () => {
  const { transcriptsDir, retrospectivesDir } =
    makeSessionDirs("marker-reoffer");
  writeTranscriptFile(
    transcriptsDir,
    "bbbbbbbb-reoffer",
    transcriptWithLateRetrospective(90, 40),
    QUALIFYING_MTIME,
  );
  writeMarkerFile(
    retrospectivesDir,
    "2026-01-01-bbbbbbbb.md",
    "content",
    QUALIFYING_MTIME - 5000,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.sessionId, "bbbbbbbb-reoffer");
});

test("findUnprocessedSessions skips a session with a marker older than the transcript when the recorded retrospective is near the end", async () => {
  const { transcriptsDir, retrospectivesDir } =
    makeSessionDirs("marker-near-end");
  writeTranscriptFile(
    transcriptsDir,
    "eeeeeeee-nearend",
    transcriptWithLateRetrospective(90, 85),
    QUALIFYING_MTIME,
  );
  writeMarkerFile(
    retrospectivesDir,
    "2026-01-01-eeeeeeee.md",
    "content",
    QUALIFYING_MTIME - 5000,
  );

  const result = await findUnprocessedSessions({
    ...baseOptions(transcriptsDir, retrospectivesDir),
    minToolUses: 10,
  });

  assert.deepEqual(result, []);
});

test("findUnprocessedSessions skips a session with an older .skipped.md marker even when new tool use since the marker would otherwise re-offer it", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs(
    "marker-skipped-overrides-reoffer",
  );
  writeTranscriptFile(
    transcriptsDir,
    "ffffffff-declined",
    transcriptWithLateRetrospective(90, 40),
    QUALIFYING_MTIME,
  );
  writeMarkerFile(
    retrospectivesDir,
    "2026-01-01-ffffffff.skipped.md",
    "Skipped by user.",
    QUALIFYING_MTIME - 5000,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.deepEqual(result, []);
});

test("findUnprocessedSessions does not throw on a session id containing regex metacharacters", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs("metachar");
  const transcriptPath = writeTranscriptFile(
    transcriptsDir,
    "ab(cd-1111",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.transcriptPath, transcriptPath);
});

test("findUnprocessedSessions skips a session where a retrospective already ran near the end", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs("late-retro");
  writeTranscriptFile(
    transcriptsDir,
    "session-late",
    transcriptWithLateRetrospective(10, 8),
    QUALIFYING_MTIME,
  );

  const result = await findUnprocessedSessions(
    baseOptions(transcriptsDir, retrospectivesDir),
  );

  assert.deepEqual(result, []);
});

test("findUnprocessedSessions applies the limit and sorts newest mtime first", async () => {
  const { transcriptsDir, retrospectivesDir } = makeSessionDirs("ordering");
  writeTranscriptFile(
    transcriptsDir,
    "session-oldest",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME - 2000,
  );
  writeTranscriptFile(
    transcriptsDir,
    "session-newest",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME,
  );
  writeTranscriptFile(
    transcriptsDir,
    "session-middle",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME - 1000,
  );

  const result = await findUnprocessedSessions({
    ...baseOptions(transcriptsDir, retrospectivesDir),
    limit: 2,
  });

  assert.equal(result.length, 2);
  assert.equal(result[0]?.sessionId, "session-newest");
  assert.equal(result[1]?.sessionId, "session-middle");
});

test("findUnprocessedSessions sorts candidates by mtime before scanning and skips disqualified ones without consuming the limit", async () => {
  const { transcriptsDir, retrospectivesDir } =
    makeSessionDirs("order-and-limit");
  writeTranscriptFile(
    transcriptsDir,
    "session-a-newest",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME,
  );
  writeTranscriptFile(
    transcriptsDir,
    "session-b-disqualified",
    transcriptWithToolUses(2),
    QUALIFYING_MTIME - 1000,
  );
  writeTranscriptFile(
    transcriptsDir,
    "session-c-qualifies",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME - 2000,
  );
  writeTranscriptFile(
    transcriptsDir,
    "session-d-oldest",
    transcriptWithToolUses(10),
    QUALIFYING_MTIME - 3000,
  );

  const result = await findUnprocessedSessions({
    ...baseOptions(transcriptsDir, retrospectivesDir),
    limit: 2,
  });

  assert.equal(result.length, 2);
  assert.equal(result[0]?.sessionId, "session-a-newest");
  assert.equal(result[1]?.sessionId, "session-c-qualifies");
});

test("findUnprocessedSessions returns an empty list for missing directories", async () => {
  const result = await findUnprocessedSessions(
    baseOptions(
      join(tmpDir, "does-not-exist-transcripts"),
      join(tmpDir, "does-not-exist-retrospectives"),
    ),
  );

  assert.deepEqual(result, []);
});
