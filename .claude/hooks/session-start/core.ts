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

/** Worktree paths + branch names that a previous session created but never cleaned up. */
export interface SessionLeftoverState {
  readonly worktreePaths: readonly string[];
  readonly branchNames: readonly string[];
}

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
 * Builds the leftover-state section listing session-created worktrees
 * and merged-but-undeleted branches that a prior session left behind.
 * The Stop hook will block the next session from ending until these are
 * cleaned up, so surfacing them here gives the next session an early
 * chance to act (rather than carrying the burden into the Stop hook).
 */
function buildLeftoverSection(leftover: SessionLeftoverState): string {
  const lines: string[] = [];
  for (const p of leftover.worktreePaths) {
    lines.push(`  - worktree: ${p}`);
  }
  for (const b of leftover.branchNames) {
    lines.push(`  - branch: ${b}`);
  }
  return `[muhely leftover worktrees / branches]
A previous Claude Code session created these resources and did not clean them up. They block the Stop hook from allowing the next session to end. Clean them up first:
- worktrees: \`git worktree remove <path> --force\`, then \`git worktree prune\`
- branches: \`git branch -d <branch>\` (safe when merged into refactor/classbase)
See \`.claude/rules/worktree-cleanup.md\` for the full cleanup protocol.
${lines.join("\n")}`;
}

/**
 * Builds the full SessionStart stdout payload from four parts, in order:
 * 1. Current session transcript line (when known)
 * 2. Shared memory section (when memory index has content)
 * 3. Leftover-state section (when a prior session left resources)
 * 4. Pending retrospectives section (when unprocessed sessions exist)
 * Returns an empty string when every part is empty.
 */
export function buildSessionStartMessage(
  memoryIndexContent: string | undefined,
  pending: readonly UnprocessedSession[],
  currentTranscriptPath: string | undefined,
  leftover?: SessionLeftoverState,
): string {
  const parts: string[] = [];
  if (currentTranscriptPath !== undefined) {
    parts.push(`Current session transcript: ${currentTranscriptPath}`);
  }
  if (memoryIndexContent !== undefined && memoryIndexContent.length > 0) {
    parts.push(buildMemorySection(memoryIndexContent));
  }
  if (
    leftover !== undefined &&
    (leftover.worktreePaths.length > 0 || leftover.branchNames.length > 0)
  ) {
    parts.push(buildLeftoverSection(leftover));
  }
  if (pending.length > 0) {
    parts.push(buildPendingSection(pending));
  }
  return parts.join("\n\n");
}