/**
 * Pure message-building logic for the SessionStart hook, kept free of I/O
 * so it can be unit tested directly.
 */
import type { UnprocessedSession } from "../common/pending-sessions.ts";

/** Minimum total tool uses a finished session needs before it is offered for a retrospective. */
export const RETRO_MIN_TOOL_USES = 40;

/** A session younger than this is still possibly live and is never offered. */
export const RETRO_IDLE_MS = 30 * 60 * 1000;

/** A session older than this is no longer offered. */
export const RETRO_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Maximum number of pending sessions offered at once. */
export const RETRO_LIMIT = 3;

/** Formats one pending-session line for the SessionStart message. */
function formatPendingSessionLine(session: UnprocessedSession): string {
  const lastActive = new Date(session.modifiedAt).toISOString();
  return `- ${session.sessionId} (${session.toolUseTotal} tool calls, last active ${lastActive}): ${session.transcriptPath}`;
}

/** Builds the section listing finished sessions with work no retrospective covers. */
function buildPendingSection(pending: readonly UnprocessedSession[]): string {
  const lines = pending.map(formatPendingSessionLine).join("\n");
  return `[muhely pending retrospectives]
The following finished sessions have work no retrospective covers, including sessions whose existing retrospective file predates that work. Before starting new work, ask the user once with AskUserQuestion which of them to process. For each approved session invoke the Skill tool with skill="retrospective" and args="<transcriptPath>" (it runs as a forked background agent). For each declined session create the marker file .claude/retrospectives/<YYYY-MM-DD>-<id8>.skipped.md containing "Skipped by user." so it is not offered again.
${lines}`;
}

/** Builds the shared memory section pointing at the `claude:memory` CLI. */
function buildMemorySection(memoryIndexContent: string): string {
  return `[muhely shared memory]
Read one topic with \`pnpm claude:memory read <topic>\`, search with \`pnpm claude:memory search "<query>"\`. Do not open these files directly.
${memoryIndexContent}`;
}

/**
 * Builds the full SessionStart stdout payload from only the parts that have
 * content, in order: a line naming the current session's transcript path
 * when known, a shared memory section when the memory index has content,
 * and a pending retrospectives section when there are unprocessed finished
 * sessions. Returns an empty string when every part is empty.
 */
export function buildSessionStartMessage(
  memoryIndexContent: string | undefined,
  pending: readonly UnprocessedSession[],
  currentTranscriptPath: string | undefined,
): string {
  const parts: string[] = [];
  if (currentTranscriptPath !== undefined) {
    parts.push(`Current session transcript: ${currentTranscriptPath}`);
  }
  if (memoryIndexContent !== undefined && memoryIndexContent.length > 0) {
    parts.push(buildMemorySection(memoryIndexContent));
  }
  if (pending.length > 0) {
    parts.push(buildPendingSection(pending));
  }
  return parts.join("\n\n");
}
