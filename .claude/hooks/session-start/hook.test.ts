import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { SHARED_MEMORY_DIR } from "../common/project-root.ts";

const SESSION_START_PATH = join(import.meta.dirname, "hook.ts");
const SHARED_MEMORY_INDEX_PATH = join(SHARED_MEMORY_DIR, "MEMORY.md");

const tmpDir = mkdtempSync(join(tmpdir(), "muhely-session-start-"));

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Runs the session-start entrypoint with the given hook input JSON on stdin. */
function runSessionStart(input: Record<string, unknown>): {
  status: number | null;
  stdout: string;
} {
  return runSessionStartRaw(JSON.stringify(input));
}

/** Runs the session-start entrypoint with the given raw stdin content. */
function runSessionStartRaw(input: string): {
  status: number | null;
  stdout: string;
} {
  const result = spawnSync(process.execPath, [SESSION_START_PATH], {
    input,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout };
}

/**
 * Replaces the shared memory index file's content for the duration of `fn`,
 * then restores it: back to its original content if it existed before, or
 * removed again if it did not. `content` of `undefined` removes the file for
 * the duration of `fn` instead of writing it.
 */
function withSharedMemoryIndex<T>(content: string | undefined, fn: () => T): T {
  const existed = existsSync(SHARED_MEMORY_INDEX_PATH);
  const original = existed
    ? readFileSync(SHARED_MEMORY_INDEX_PATH, "utf8")
    : undefined;
  try {
    if (content === undefined) {
      rmSync(SHARED_MEMORY_INDEX_PATH, { force: true });
    } else {
      writeFileSync(SHARED_MEMORY_INDEX_PATH, content, "utf8");
    }
    return fn();
  } finally {
    if (existed) {
      writeFileSync(SHARED_MEMORY_INDEX_PATH, original ?? "", "utf8");
    } else {
      rmSync(SHARED_MEMORY_INDEX_PATH, { force: true });
    }
  }
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

/** Older than the 30-minute idle window but well within the 14-day max age. */
const QUALIFYING_MTIME = Date.now() - 31 * 60 * 1000;

test("session-start entrypoint exits 0 and prints the current session transcript line", () => {
  withSharedMemoryIndex(undefined, () => {
    const transcriptsDir = join(tmpDir, "banner");
    const result = runSessionStart({
      hook_event_name: "SessionStart",
      session_id: "test-session-start",
      transcript_path: join(transcriptsDir, "test-session-start.jsonl"),
      cwd: process.cwd(),
      source: "startup",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Current session transcript:/);
  });
});

test("session-start prints nothing on empty stdin when the shared memory index is absent", () => {
  withSharedMemoryIndex(undefined, () => {
    const result = runSessionStartRaw("");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
});

test("session-start prints nothing when the shared memory index is absent and no transcript is known", () => {
  withSharedMemoryIndex(undefined, () => {
    const result = runSessionStart({});
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
});

test("session-start includes the shared memory section when the index has content", () => {
  withSharedMemoryIndex("- [foo](foo.md): a remembered fact\n", () => {
    const result = runSessionStart({});
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[muhely shared memory\]/);
    assert.match(result.stdout, /a remembered fact/);
    assert.match(result.stdout, /pnpm claude:memory read <topic>/);
  });
});

test("shared memory index is capped at 200 lines when it has more lines than that", () => {
  const lines = Array.from({ length: 250 }, (_, i) => `line-${i}`);
  withSharedMemoryIndex(lines.join("\n"), () => {
    const result = runSessionStart({});
    assert.equal(result.status, 0);
    assert.match(result.stdout, /line-0\n/);
    assert.match(result.stdout, /line-199/);
    assert.doesNotMatch(result.stdout, /line-200/);
    assert.doesNotMatch(result.stdout, /line-249/);
  });
});

test("shared memory index is capped at 25600 bytes when it fits within 200 lines but exceeds that many bytes", () => {
  const longLine = "a".repeat(30_000);
  withSharedMemoryIndex(longLine, () => {
    const result = runSessionStart({});
    assert.equal(result.status, 0);
    const prefix =
      '[muhely shared memory]\nRead one topic with `pnpm claude:memory read <topic>`, search with `pnpm claude:memory search "<query>"`. Do not open these files directly.\n';
    assert.ok(result.stdout.startsWith(prefix));
    const capped = result.stdout.slice(prefix.length, -1);
    assert.equal(Buffer.byteLength(capped, "utf8"), 25_600);
    assert.ok(capped.length < longLine.length);
  });
});

test("shared memory index cap never splits a UTF-8 character even when the byte cap lands mid-codepoint", () => {
  const content = `x${"á".repeat(13_000)}`;
  withSharedMemoryIndex(content, () => {
    const result = runSessionStart({});
    assert.equal(result.status, 0);
    const prefix =
      '[muhely shared memory]\nRead one topic with `pnpm claude:memory read <topic>`, search with `pnpm claude:memory search "<query>"`. Do not open these files directly.\n';
    assert.ok(result.stdout.startsWith(prefix));
    const capped = result.stdout.slice(prefix.length, -1);
    assert.ok(!capped.includes("�"));
    assert.ok(Buffer.byteLength(capped, "utf8") <= 25_600);
  });
});

for (const source of ["compact", "clear", "fork"]) {
  test(`session-start does not offer pending retrospectives on source "${source}"`, () => {
    withSharedMemoryIndex(undefined, () => {
      const transcriptsDir = join(tmpDir, `no-scan-${source}`);
      mkdirSync(transcriptsDir, { recursive: true });
      const oldTranscriptPath = join(transcriptsDir, "old-session.jsonl");
      writeFileSync(oldTranscriptPath, transcriptWithToolUses(50), "utf8");
      utimesSync(
        oldTranscriptPath,
        QUALIFYING_MTIME / 1000,
        QUALIFYING_MTIME / 1000,
      );

      const result = runSessionStart({
        hook_event_name: "SessionStart",
        session_id: "current-session",
        transcript_path: join(transcriptsDir, "current-session.jsonl"),
        cwd: process.cwd(),
        source,
      });

      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stdout, /\[muhely pending retrospectives\]/);
    });
  });
}

test('session-start lists a qualifying pending session end to end on source "startup"', () => {
  withSharedMemoryIndex(undefined, () => {
    const transcriptsDir = join(tmpDir, "startup-scan");
    mkdirSync(transcriptsDir, { recursive: true });
    const oldTranscriptPath = join(transcriptsDir, "old-session.jsonl");
    writeFileSync(oldTranscriptPath, transcriptWithToolUses(50), "utf8");
    utimesSync(
      oldTranscriptPath,
      QUALIFYING_MTIME / 1000,
      QUALIFYING_MTIME / 1000,
    );

    const result = runSessionStart({
      hook_event_name: "SessionStart",
      session_id: "current-session",
      transcript_path: join(transcriptsDir, "current-session.jsonl"),
      cwd: process.cwd(),
      source: "startup",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[muhely pending retrospectives\]/);
    assert.match(result.stdout, /old-session/);
  });
});
