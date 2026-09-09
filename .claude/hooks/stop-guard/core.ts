import type { TranscriptStats } from "../common/transcript.ts";
/**
 * Pure decision logic for the Stop hook: whether the session should be
 * allowed to stop, or nudged to create a Todo list or commit uncommitted
 * shared-memory/retrospective files. Kept free of I/O so it can be unit
 * tested directly.
 */
import { isBoolean, isRecord } from "../common/typeguards.ts";

/** Minimum total tool uses before a missing Todo list is nudged. */
export const TODO_MIN_TOOL_USES = 8;

/** Per-session guard state persisted between Stop hook invocations. */
export interface SessionGuardState {
  readonly todoNudged: boolean;
  readonly uncommittedMemoryNudged: boolean;
}

/** Default guard state for a session with no prior nudges. */
export const DEFAULT_SESSION_GUARD_STATE: SessionGuardState = {
  todoNudged: false,
  uncommittedMemoryNudged: false,
};

/** Relative paths of untracked `.md` files under shared-memory or retrospectives. */
export type UncommittedMemoryFiles = readonly string[];

/**
 * Narrows an unknown value to a valid {@link SessionGuardState}. Requires
 * both `todoNudged` and `uncommittedMemoryNudged` to be booleans. Tolerant
 * of extra keys, so a state file with extra fields still validates.
 */
export function isSessionGuardState(v: unknown): v is SessionGuardState {
  return (
    isRecord(v) &&
    isBoolean(v["todoNudged"]) &&
    isBoolean(v["uncommittedMemoryNudged"])
  );
}

/** Outcome of {@link decideStopAction}: allow the stop, or block it with a reason and new state. */
export type StopDecision =
  | { readonly kind: "allow" }
  | {
      readonly kind: "block";
      readonly reason: string;
      readonly nextState: SessionGuardState;
    };

/**
 * Decides whether a Stop hook invocation should block the session from
 * stopping. Two rules, evaluated in order:
 * 1. Uncommitted shared-memory or retrospective files (no threshold) —
 *    block once per session. A release-blocker: the dual-write rule
 *    (CLAUDE.md §7) requires these files on the working branch.
 * 2. Missing Todo list once tool use crosses the threshold — block once
 *    per session.
 * Otherwise allow.
 */
export function decideStopAction(
  stats: TranscriptStats,
  state: SessionGuardState,
  uncommittedMemoryFiles: UncommittedMemoryFiles,
): StopDecision {
  if (
    uncommittedMemoryFiles.length > 0 &&
    !state.uncommittedMemoryNudged
  ) {
    const fileList = uncommittedMemoryFiles.join(", ");
    return {
      kind: "block",
      reason:
        `Uncommitted shared-memory or retrospective files detected: ${fileList}. ` +
        `Commit them with \`git add\` and \`git commit\` before stopping. ` +
        `Per .claude/rules/session-lifecycle.md, these files must land on the working branch before the session ends.`,
      nextState: { ...state, uncommittedMemoryNudged: true },
    };
  }

  if (
    stats.toolUseTotal >= TODO_MIN_TOOL_USES &&
    stats.taskCreateCount === 0 &&
    !state.todoNudged
  ) {
    return {
      kind: "block",
      reason:
        "Mandatory Todo task list is missing. Create it now with TaskCreate (with dependencies via TaskUpdate addBlockedBy/addBlocks), then continue the work.",
      nextState: { ...state, todoNudged: true },
    };
  }

  return { kind: "allow" };
}