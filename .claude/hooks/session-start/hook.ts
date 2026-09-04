#!/usr/bin/env node
/**
 * SessionStart hook entrypoint. Prints the shared memory index content if
 * present, and, on a `startup` or `resume` source, a list of finished
 * sessions with work no retrospective covers, to stdout for Claude's
 * context. Never blocks the session: always exits 0.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  parseSessionStartHookInput,
  readStdinJson,
} from "../common/hook-input.ts";
import {
  findUnprocessedSessions,
  type UnprocessedSession,
} from "../common/pending-sessions.ts";
import {
  RETROSPECTIVES_DIR,
  SHARED_MEMORY_DIR,
} from "../common/project-root.ts";
import { hasErrorCode } from "../common/typeguards.ts";
import {
  buildSessionStartMessage,
  RETRO_IDLE_MS,
  RETRO_LIMIT,
  RETRO_MAX_AGE_MS,
  RETRO_MIN_TOOL_USES,
} from "./core.ts";

/** Claude Code's own auto memory read limit: at most this many lines... */
const MEMORY_INDEX_MAX_LINES = 200;

/** ...or this many bytes (25KB), whichever comes first. */
const MEMORY_INDEX_MAX_BYTES = 25 * 1024;

const SHARED_MEMORY_INDEX_PATH = join(SHARED_MEMORY_DIR, "MEMORY.md");

/** Whether `byte` is a UTF-8 continuation byte (10xxxxxx). */
function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** The number of bytes a UTF-8 codepoint starting with `leadByte` occupies. */
function utf8SequenceLength(leadByte: number): number {
  if (leadByte < 0x80) return 1;
  if ((leadByte & 0xe0) === 0xc0) return 2;
  if ((leadByte & 0xf0) === 0xe0) return 3;
  if ((leadByte & 0xf8) === 0xf0) return 4;
  return 1;
}

/**
 * Truncates `buffer` to at most `maxBytes` bytes on a UTF-8 character
 * boundary, dropping a trailing codepoint whole rather than mid-sequence, so
 * the result always decodes to valid UTF-8.
 */
function truncateUtf8ToBytes(buffer: Buffer, maxBytes: number): string {
  let end = maxBytes;
  let leadIndex = end - 1;
  while (leadIndex >= 0 && isUtf8ContinuationByte(buffer[leadIndex] ?? 0)) {
    leadIndex--;
  }
  if (
    leadIndex >= 0 &&
    leadIndex + utf8SequenceLength(buffer[leadIndex] ?? 0) > end
  ) {
    end = leadIndex;
  }
  return buffer.subarray(0, end).toString("utf8");
}

/** SessionStart sources that should trigger the pending-retrospective scan. */
const SCAN_SOURCES = new Set(["startup", "resume"]);

/**
 * Reads the shared memory index, capped at MEMORY_INDEX_MAX_LINES lines or
 * MEMORY_INDEX_MAX_BYTES bytes, whichever comes first. A missing index file
 * is the normal state and is returned as undefined silently; a real read
 * error is logged to stderr.
 */
async function readMemoryIndex(): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(SHARED_MEMORY_INDEX_PATH, "utf8");
  } catch (error) {
    if (!hasErrorCode(error) || error.code !== "ENOENT") {
      process.stderr.write(
        `[session-start] shared memory index read error: ${String(error)}\n`,
      );
    }
    return undefined;
  }
  const capped = content
    .split("\n")
    .slice(0, MEMORY_INDEX_MAX_LINES)
    .join("\n");
  if (Buffer.byteLength(capped, "utf8") <= MEMORY_INDEX_MAX_BYTES) {
    return capped;
  }
  return truncateUtf8ToBytes(
    Buffer.from(capped, "utf8"),
    MEMORY_INDEX_MAX_BYTES,
  );
}

/**
 * Scans for pending retrospectives, or skips (returns an empty list) when
 * not applicable or when the scan itself fails, so a scan failure never
 * costs the caller the memory section.
 */
async function findPendingSessions(
  sessionId: string,
  transcriptsDir: string,
  source: string,
): Promise<readonly UnprocessedSession[]> {
  if (!SCAN_SOURCES.has(source)) {
    return [];
  }
  try {
    return await findUnprocessedSessions({
      transcriptsDir,
      retrospectivesDir: RETROSPECTIVES_DIR,
      currentSessionId: sessionId,
      now: Date.now(),
      minToolUses: RETRO_MIN_TOOL_USES,
      idleMs: RETRO_IDLE_MS,
      maxAgeMs: RETRO_MAX_AGE_MS,
      limit: RETRO_LIMIT,
    });
  } catch (error) {
    process.stderr.write(
      `[session-start] pending scan error: ${String(error)}\n`,
    );
    return [];
  }
}

async function main(): Promise<void> {
  const raw = await readStdinJson();
  const input = parseSessionStartHookInput(raw);
  const transcriptPath =
    input !== undefined && input.transcriptPath.length > 0
      ? input.transcriptPath
      : undefined;

  const [memoryIndexContent, pending] = await Promise.all([
    readMemoryIndex(),
    transcriptPath !== undefined && input !== undefined
      ? findPendingSessions(
          input.sessionId,
          dirname(transcriptPath),
          input.source,
        )
      : Promise.resolve<readonly UnprocessedSession[]>([]),
  ]);

  const message = buildSessionStartMessage(
    memoryIndexContent,
    pending,
    transcriptPath,
  );
  if (message.length > 0) {
    process.stdout.write(`${message}\n`);
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    process.stderr.write(`[session-start] internal error: ${String(error)}\n`);
    process.exitCode = 0;
  });
