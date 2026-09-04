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
  );
  assert.equal(decision.kind, "allow");
});

test("todo rule fires once, then allows on the next call with the updated state", () => {
  const first = decideStopAction(
    stats({ toolUseTotal: 8, taskCreateCount: 0 }),
    DEFAULT_SESSION_GUARD_STATE,
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
  );
  assert.equal(second.kind, "allow");
});

test("allows once a Todo list already exists", () => {
  const decision = decideStopAction(
    stats({ toolUseTotal: 20, taskCreateCount: 1 }),
    DEFAULT_SESSION_GUARD_STATE,
  );
  assert.equal(decision.kind, "allow");
});

test("isSessionGuardState accepts an old state file with extra keys", () => {
  assert.equal(
    isSessionGuardState({ todoNudged: true, retroNudgeAt: 240 }),
    true,
  );
});

test("isSessionGuardState rejects a non-boolean todoNudged", () => {
  assert.equal(isSessionGuardState({ todoNudged: "yes" }), false);
});
