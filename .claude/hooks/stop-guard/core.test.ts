import assert from "node:assert/strict";
import { test } from "node:test";

import type { TranscriptStats } from "../common/transcript.ts";
import {
  decideStopAction,
  DEFAULT_SESSION_GUARD_STATE,
  isSessionGuardState,
  MAX_LEAKS_REPORTED,
} from "./core.ts";

function stats(overrides: Partial<TranscriptStats>): TranscriptStats {
  return {
    toolUseTotal: 0,
    taskCreateCount: 0,
    lastRetrospectiveAtToolCount: 0,
    ...overrides,
  };
}

const NO_LEAKS = { worktreePaths: [], branchNames: [] };

// --- Todo rule (unchanged behaviour) ---

test("allows below the todo threshold", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 5, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
    NO_LEAKS,
  );
  assert.equal(decision.kind, "allow");
});

test("todo rule fires once, then allows on the next call with the updated state", () => {
  const first = decideStopAction(
    stats({ toolUseTotal: 8, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
    NO_LEAKS,
  );
  assert.equal(first.kind, "block");
  if (first.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(first.reason, /Todo task list/);
  assert.equal(first.nextState.todoNudged, true);

  const second = decideStopAction(
    stats({ toolUseTotal: 8, taskCreateCount: 0 }),
    first.nextState,
    [],
    NO_LEAKS,
  );
  assert.equal(second.kind, "allow");
});

test("allows once a Todo list already exists", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 20, taskCreateCount: 1 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
    NO_LEAKS,
  );
  assert.equal(decision.kind, "allow");
});

// --- Uncommitted memory rule (unchanged behaviour) ---

test("uncommitted-memory rule fires once, then allows on the next call with the updated state", () => {
  const first = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [".claude/shared-memory/x.md"],
    NO_LEAKS,
  );
  assert.equal(first.kind, "block");
  if (first.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(first.reason, /Uncommitted shared-memory or retrospective files detected/);
  assert.match(first.reason, /\.claude\/shared-memory\/x\.md/);
  assert.match(first.reason, /session-lifecycle\.md/);
  assert.equal(first.nextState.uncommittedMemoryNudged, true);
  assert.equal(first.nextState.todoNudged, false);

  const second = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    first.nextState,
    [".claude/shared-memory/x.md"],
    NO_LEAKS,
  );
  assert.equal(second.kind, "allow");
});

test("uncommitted-memory rule takes precedence over todo rule when both would fire", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 8, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [".claude/retrospectives/y.md"],
    NO_LEAKS,
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(decision.reason, /Uncommitted shared-memory or retrospective files detected/);
});

test("uncommitted-memory rule lists all offending paths in the reason", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [".claude/shared-memory/a.md", ".claude/retrospectives/b.md"],
    NO_LEAKS,
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(decision.reason, /\.claude\/shared-memory\/a\.md/);
  assert.match(decision.reason, /\.claude\/retrospectives\/b\.md/);
});

// --- Worktree / branch leak rule ---

test("worktree leak blocks with current-audit-state flag set", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
    { worktreePaths: ["/Users/eggp/claw-test"], branchNames: [] },
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(decision.reason, /Leftover session-created worktrees or branches detected/);
  assert.match(decision.reason, /worktree: \/Users\/eggp\/claw-test/);
  assert.match(decision.reason, /worktree-cleanup\.md/);
  assert.equal(decision.nextState.worktreeCleanupNudged, true);
  assert.equal(decision.nextState.todoNudged, false);
  assert.equal(decision.nextState.uncommittedMemoryNudged, false);
});

test("branch leak blocks", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
    { worktreePaths: [], branchNames: ["refactor/old-session-branch"] },
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(decision.reason, /branch: refactor\/old-session-branch/);
});

test("both worktree and branch leaks block together with both items in reason", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
    { worktreePaths: ["/Users/eggp/claw-x"], branchNames: ["refactor/y"] },
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(decision.reason, /worktree: \/Users\/eggp\/claw-x/);
  assert.match(decision.reason, /branch: refactor\/y/);
});

test("worktree cleanup resets the flag to current-audit-state (false) when no leaks", () => {
  // Flag starts true (post prior block) — must reset when audit comes back clean.
  const state = { ...DEFAULT_SESSION_GUARD_STATE, worktreeCleanupNudged: true };
  const decision = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    state,
    [],
    NO_LEAKS,
  );
  assert.equal(decision.kind, "allow");
  if (decision.kind !== "allow") {
    throw new Error("unreachable");
  }
  assert.equal(decision.nextState.worktreeCleanupNudged, false);
});

test("worktree leak triggers after a prior cleanup (current-audit-state, NOT lifetime-blocked)", () => {
  // Pathological sequence: cleanup → new leak in same session → must re-block.
  // After Phase-2-9e751ad flag is `true` (post prior block), then cleanup runs and
  // resets to `false`. A subsequent new leak must fire even though the flag was
  // recently `true` (avoids the FALSIFIED-bypass flagged by the verifier).
  const first = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
    { worktreePaths: ["/Users/eggp/claw-x"], branchNames: [] },
  );
  assert.equal(first.kind, "block");
  if (first.kind !== "block") {
    throw new Error("unreachable");
  }

  // Cleanup happened: no leaks → flag resets to false
  const cleanup = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    first.nextState,
    [],
    NO_LEAKS,
  );
  assert.equal(cleanup.kind, "allow");
  if (cleanup.kind !== "allow") {
    throw new Error("unreachable");
  }
  assert.equal(cleanup.nextState.worktreeCleanupNudged, false);

  // NEW leak in same session (after cleanup)
  const newLeak = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    cleanup.nextState,
    [],
    { worktreePaths: ["/Users/eggp/claw-new"], branchNames: [] },
  );
  assert.equal(newLeak.kind, "block");
  if (newLeak.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(newLeak.reason, /worktree: \/Users\/eggp\/claw-new/);
});

test("MAX_LEAKS_REPORTED truncates the reason with '... and N more' suffix", () => {
  const many = Array.from(
    { length: MAX_LEAKS_REPORTED + 5 },
    (_, i) => `/Users/eggp/claw-test-${i}`,
  );
  const decision = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
    { worktreePaths: many, branchNames: [] },
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(decision.reason, /and 5 more/);
});

test("worktree leak takes precedence over todo rule when both would fire", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 8, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
    { worktreePaths: ["/Users/eggp/claw-x"], branchNames: [] },
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(decision.reason, /Leftover session-created/);
  assert.doesNotMatch(decision.reason, /Todo task list/);
});

test("worktree leak with no uncommitted memory does not match uncommitted reason", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
    { worktreePaths: ["/Users/eggp/claw-x"], branchNames: [] },
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.doesNotMatch(decision.reason, /Uncommitted shared-memory/);
});

// --- isSessionGuardState ---

test("isSessionGuardState accepts the current state shape", () => {
  assert.equal(
    isSessionGuardState({
      todoNudged: true,
      uncommittedMemoryNudged: false,
      worktreeCleanupNudged: false,
    }),
    true,
  );
});

test("isSessionGuardState accepts an old state file with extra keys", () => {
  assert.equal(
    isSessionGuardState({
      todoNudged: true,
      uncommittedMemoryNudged: false,
      worktreeCleanupNudged: false,
      retroNudgeAt: 240,
    }),
    true,
  );
});

test("isSessionGuardState rejects a non-boolean todoNudged", () => {
  assert.equal(
    isSessionGuardState({
      todoNudged: "yes",
      uncommittedMemoryNudged: false,
      worktreeCleanupNudged: false,
    }),
    false,
  );
});

test("isSessionGuardState rejects a non-boolean uncommittedMemoryNudged", () => {
  assert.equal(
    isSessionGuardState({
      todoNudged: true,
      uncommittedMemoryNudged: "no",
      worktreeCleanupNudged: false,
    }),
    false,
  );
});

test("isSessionGuardState rejects a non-boolean worktreeCleanupNudged", () => {
  assert.equal(
    isSessionGuardState({
      todoNudged: true,
      uncommittedMemoryNudged: false,
      worktreeCleanupNudged: "yes",
    }),
    false,
  );
});

test("isSessionGuardState rejects a missing uncommittedMemoryNudged", () => {
  assert.equal(
    isSessionGuardState({
      todoNudged: true,
      worktreeCleanupNudged: false,
    }),
    false,
  );
});

test("isSessionGuardState rejects a missing worktreeCleanupNudged", () => {
  assert.equal(
    isSessionGuardState({
      todoNudged: true,
      uncommittedMemoryNudged: false,
    }),
    false,
  );
});