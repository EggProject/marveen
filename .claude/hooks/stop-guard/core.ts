import type { TranscriptStats } from "../common/transcript.ts";
/**
 * Pure decision logic for the Stop hook: whether the session should be
 * allowed to stop, or nudged to create a Todo list.
 * Kept free of I/O so it can be unit tested directly.
 */
import { isBoolean, isRecord } from "../common/typeguards.ts";

/** Minimum total tool uses before a missing Todo list is nudged. */
export const TODO_MIN_TOOL_USES = 8;

/** Per-session guard state persisted between Stop hook invocations. */
export interface SessionGuardState {
  readonly todoNudged: boolean;
}

/** Default guard state for a session with no prior nudges. */
export const DEFAULT_SESSION_GUARD_STATE: SessionGuardState = {
  todoNudged: false,
};

/**
 * Narrows an unknown value to a valid {@link SessionGuardState}. Tolerant of
 * extra keys, so an older state file still validates as long as `todoNudged`
 * is a boolean.
 */
export function isSessionGuardState(v: unknown): v is SessionGuardState {
  return isRecord(v) && isBoolean(v["todoNudged"]);
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
 * stopping. The only rule: a missing Todo list once tool use crosses the
 * threshold. Otherwise allow.
 */
export function decideStopAction(
  stats: TranscriptStats,
  state: SessionGuardState,
): StopDecision {
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
