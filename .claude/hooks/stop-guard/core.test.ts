import assert from "node:assert/strict";
import { test } from "node:test";

import type { TranscriptStats } from "../common/transcript.ts";
import {
  decideStopAction,
  DEFAULT_SESSION_GUARD_STATE,
  isSessionGuardState,
} from "./core.ts";

function stats(overrides: Partial<TranscriptStats>): TranscriptStats {
  return {
    toolUseTotal: 0,
    taskCreateCount: 0,
    lastRetrospectiveAtToolCount: 0,
    ...overrides,
  };
}

test("allows below the todo threshold", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 5, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
  );
  assert.equal(decision.kind, "allow");
});

test("todo rule fires once, then allows on the next call with the updated state", () => {
  const first = decideStopAction(
    stats({ toolUseTotal: 8, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
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
  );
  assert.equal(second.kind, "allow");
});

test("allows once a Todo list already exists", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 20, taskCreateCount: 1 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
  );
  assert.equal(decision.kind, "allow");
});

test("uncommitted-memory rule fires once, then allows on the next call with the updated state", () => {
  const first = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [".claude/shared-memory/x.md"],
  );
  assert.equal(first.kind, "block");
  if (first.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(
    first.reason,
    /Uncommitted shared-memory or retrospective files detected/,
  );
  assert.match(first.reason, /\.claude\/shared-memory\/x\.md/);
  assert.match(first.reason, /session-lifecycle\.md/);
  assert.equal(first.nextState.uncommittedMemoryNudged, true);
  assert.equal(first.nextState.todoNudged, false);

  const second = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    first.nextState,
    [".claude/shared-memory/x.md"],
  );
  assert.equal(second.kind, "allow");
});

test("uncommitted-memory rule takes precedence over todo rule when both would fire", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 8, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [".claude/retrospectives/y.md"],
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(
    decision.reason,
    /Uncommitted shared-memory or retrospective files detected/,
  );
});

test("uncommitted-memory rule lists all offending paths in the reason", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 0, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [".claude/shared-memory/a.md", ".claude/retrospectives/b.md"],
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(decision.reason, /\.claude\/shared-memory\/a\.md/);
  assert.match(decision.reason, /\.claude\/retrospectives\/b\.md/);
});

test("uncommitted-memory rule ignores empty file list (todo rule may still fire)", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 8, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
    [],
  );
  assert.equal(decision.kind, "block");
  if (decision.kind !== "block") {
    throw new Error("unreachable");
  }
  assert.match(decision.reason, /Todo task list/);
});

test("isSessionGuardState accepts the current state shape", () => {
  assert.equal(
    isSessionGuardState({
      todoNudged: true,
      uncommittedMemoryNudged: false,
    }),
    true,
  );
});

test("isSessionGuardState accepts an old state file with extra keys", () => {
  assert.equal(
    isSessionGuardState({
      todoNudged: true,
      uncommittedMemoryNudged: false,
      retroNudgeAt: 240,
    }),
    true,
  );
});

test("isSessionGuardState rejects a non-boolean todoNudged", () => {
  assert.equal(
    isSessionGuardState({ todoNudged: "yes", uncommittedMemoryNudged: false }),
    false,
  );
});

test("isSessionGuardState rejects a non-boolean uncommittedMemoryNudged", () => {
  assert.equal(
    isSessionGuardState({ todoNudged: true, uncommittedMemoryNudged: "no" }),
    false,
  );
});

test("isSessionGuardState rejects a missing uncommittedMemoryNudged", () => {
  // Old state file shape without the new field: must NOT validate, so a
  // session with the new hook against an old state file gets the default.
  assert.equal(isSessionGuardState({ todoNudged: true }), false);
});