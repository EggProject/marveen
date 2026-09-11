import type { TranscriptStats } from "../common/transcript.ts";
/**
 * Pure decision logic for the Stop hook: whether the session should be
 * allowed to stop, or nudged to create a Todo list, commit uncommitted
 * shared-memory/retrospective files, or clean up leftover session-created
 * worktrees/branches. Kept free of I/O so it can be unit tested directly.
 */
import { isBoolean, isRecord } from "../common/typeguards.ts";

/** Minimum total tool uses before a missing Todo list is nudged. */
export const TODO_MIN_TOOL_USES = 8;

/** Per-session guard state persisted between Stop hook invocations. */
export interface SessionGuardState {
  readonly todoNudged: boolean;
  readonly uncommittedMemoryNudged: boolean;
  /** Current-audit-state, not lifetime-blocked: resets to false on every clean stop. */
  readonly worktreeCleanupNudged: boolean;
}

/** Default guard state for a session with no prior nudges. */
export const DEFAULT_SESSION_GUARD_STATE: SessionGuardState = {
  todoNudged: false,
  uncommittedMemoryNudged: false,
  worktreeCleanupNudged: false,
};

/** Relative paths of untracked `.md` files under shared-memory or retrospectives. */
export type UncommittedMemoryFiles = readonly string[];

/**
 * Session-created resources that should be cleaned up before session-end.
 * Both lists are populated by the entrypoint via shell commands. The
 * pure decision function only reads them.
 */
export interface SessionResourceLeaks {
  readonly worktreePaths: readonly string[];
  readonly branchNames: readonly string[];
}

/** Maximum number of leaks reported in a single block reason before truncation. */
export const MAX_LEAKS_REPORTED = 10;

/**
 * Narrows an unknown value to a valid {@link SessionGuardState}. Requires
 * all three nudges to be booleans. Tolerant of extra keys.
 */
export function isSessionGuardState(v: unknown): v is SessionGuardState {
  return (
    isRecord(v) &&
    isBoolean(v["todoNudged"]) &&
    isBoolean(v["uncommittedMemoryNudged"]) &&
    isBoolean(v["worktreeCleanupNudged"])
  );
}

/** Outcome of {@link decideStopAction}: allow the stop, or block it with a reason and new state. */
export type StopDecision =
  | {
      readonly kind: "allow";
      /** Carries the current-audit-state worktree flag (always false on allow). */
      readonly nextState: SessionGuardState;
    }
  | {
      readonly kind: "block";
      readonly reason: string;
      readonly nextState: SessionGuardState;
    };

/** Per-line formatter for the leak list in a block reason. */
function formatLeakList(
  worktreePaths: readonly string[],
  branchNames: readonly string[],
): string {
  const lines: string[] = [];
  for (const p of worktreePaths) {
    lines.push(`  - worktree: ${p}`);
  }
  for (const b of branchNames) {
    lines.push(`  - branch: ${b}`);
  }
  return lines.join("\n");
}

/**
 * Decides whether a Stop hook invocation should block the session from
 * stopping. Three rules, evaluated in order:
 * 1. Uncommitted shared-memory or retrospective files (no threshold) —
 *    block once per session. Release-blocker.
 * 2. Leftover session-created worktrees or merged-but-undeleted branches —
 *    block on ANY leak. The `worktreeCleanupNudged` flag is
 *    current-audit-state (NOT lifetime-blocked): it is set true while a
 *    leak exists, and reset to false the next time the audit comes back
 *    clean. A session that creates a new worktree after a prior cleanup
 *    is blocked again.
 * 3. Missing Todo list once tool use crosses the threshold — block once
 *    per session.
 * Otherwise allow.
 */
export function decideStopAction(
  stats: TranscriptStats,
  state: SessionGuardState,
  uncommittedMemoryFiles: UncommittedMemoryFiles,
  leaks: SessionResourceLeaks,
): StopDecision {
  // Rule 1: uncommitted memory (release-blocker, once-per-session)
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

  // Rule 2: worktree / branch leftover (release-blocker, current-audit-state)
  const totalLeaks = leaks.worktreePaths.length + leaks.branchNames.length;
  if (totalLeaks > 0) {
    const reportedWorktrees = leaks.worktreePaths.slice(0, MAX_LEAKS_REPORTED);
    const reportedBranches = leaks.branchNames.slice(0, MAX_LEAKS_REPORTED);
    const truncated = totalLeaks > MAX_LEAKS_REPORTED;
    const tail = truncated
      ? `\n  ... and ${totalLeaks - MAX_LEAKS_REPORTED} more (run \`git worktree list\` and \`git branch --merged refactor/classbase\` for the full list)`
      : "";
    return {
      kind: "block",
      reason:
        `Leftover session-created worktrees or branches detected:\n` +
        formatLeakList(reportedWorktrees, reportedBranches) +
        tail +
        `\nClean them up: \`git worktree remove <path> --force\`, then \`git worktree prune\`, then \`git branch -d <branch>\`. ` +
        `Per .claude/rules/worktree-cleanup.md, these must be cleaned up before session end.`,
      nextState: { ...state, worktreeCleanupNudged: true },
    };
  }

  // No leaks: reset worktreeCleanupNudged to current-audit-state (false)
  const baseState: SessionGuardState = {
    ...state,
    worktreeCleanupNudged: false,
  };

  // Rule 3: Todo (reminder, once-per-session)
  if (
    stats.toolUseTotal >= TODO_MIN_TOOL_USES &&
    stats.taskCreateCount === 0 &&
    !state.todoNudged
  ) {
    return {
      kind: "block",
      reason:
        "Mandatory Todo task list is missing. Create it now with TaskCreate (with dependencies via TaskUpdate addBlockedBy/addBlocks), then continue the work.",
      nextState: { ...baseState, todoNudged: true },
    };
  }

  return { kind: "allow", nextState: baseState };
}