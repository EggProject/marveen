import assert from "node:assert/strict";
import { test } from "node:test";

import type { UnprocessedSession } from "../common/pending-sessions.ts";
import {
  buildSessionStartMessage,
  RETRO_IDLE_MS,
  RETRO_LIMIT,
  RETRO_MAX_AGE_MS,
  RETRO_MIN_TOOL_USES,
} from "./core.ts";

function session(overrides: Partial<UnprocessedSession>): UnprocessedSession {
  return {
    sessionId: "s-test",
    toolUseTotal: 50,
    modifiedAt: 1_700_000_000_000,
    transcriptPath: "/tmp/t.jsonl",
    ...overrides,
  };
}

const EMPTY_LEFTOVER = { worktreePaths: [], branchNames: [] };

// --- Memory section ---

test("message is empty when every part is empty", () => {
  const m = buildSessionStartMessage(undefined, [], undefined, EMPTY_LEFTOVER);
  assert.equal(m, "");
});

test("message omits the memory section when no content is given", () => {
  const m = buildSessionStartMessage(undefined, [], "/tmp/t.jsonl", EMPTY_LEFTOVER);
  assert.match(m, /Current session transcript/);
  assert.equal(m.includes("shared memory"), false);
});

test("message omits the memory section when the content is an empty string", () => {
  const m = buildSessionStartMessage("", [], "/tmp/t.jsonl", EMPTY_LEFTOVER);
  assert.equal(m.includes("shared memory"), false);
});

test("message includes the memory section when content is given", () => {
  const m = buildSessionStartMessage(
    "topic-a: details",
    [],
    undefined,
    EMPTY_LEFTOVER,
  );
  assert.match(m, /shared memory/);
  assert.match(m, /topic-a: details/);
});

// --- Pending retrospectives section ---

test("message omits the pending retrospectives section when pending is empty", () => {
  const m = buildSessionStartMessage(undefined, [], undefined, EMPTY_LEFTOVER);
  assert.equal(m.includes("pending retrospectives"), false);
});

test("message includes the pending retrospectives section when pending is non-empty", () => {
  const m = buildSessionStartMessage(undefined, [session({})], undefined, EMPTY_LEFTOVER);
  assert.match(m, /pending retrospectives/);
  assert.match(m, /s-test/);
});

// --- Current transcript line ---

test("message omits the current transcript line when currentTranscriptPath is undefined", () => {
  const m = buildSessionStartMessage("mem", [], undefined, EMPTY_LEFTOVER);
  assert.equal(m.includes("Current session transcript"), false);
});

test("message includes the current transcript line when currentTranscriptPath is given", () => {
  const m = buildSessionStartMessage("mem", [], "/tmp/t.jsonl", EMPTY_LEFTOVER);
  assert.match(m, /Current session transcript: \/tmp\/t\.jsonl/);
});

// --- Assembly order ---

test("message assembles all four parts in order when all are present", () => {
  const m = buildSessionStartMessage(
    "mem",
    [session({ sessionId: "s-other", transcriptPath: "/tmp/o.jsonl" })],
    "/tmp/t.jsonl",
    { worktreePaths: ["/Users/eggp/claw-x"], branchNames: ["refactor/y"] },
  );
  const transcriptIdx = m.indexOf("Current session transcript");
  const memoryIdx = m.indexOf("shared memory");
  const leftoverIdx = m.indexOf("leftover worktrees");
  const pendingIdx = m.indexOf("pending retrospectives");
  assert.notEqual(transcriptIdx, -1);
  assert.notEqual(memoryIdx, -1);
  assert.notEqual(leftoverIdx, -1);
  assert.notEqual(pendingIdx, -1);
  assert.ok(transcriptIdx < memoryIdx);
  assert.ok(memoryIdx < leftoverIdx);
  assert.ok(leftoverIdx < pendingIdx);
});

// --- Leftover worktrees / branches section (NEW) ---

test("leftover section is omitted when both lists are empty", () => {
  const m = buildSessionStartMessage(undefined, [], undefined, EMPTY_LEFTOVER);
  assert.equal(m.includes("leftover"), false);
});

test("leftover section appears when worktree paths are present", () => {
  const m = buildSessionStartMessage(undefined, [], undefined, {
    worktreePaths: ["/Users/eggp/claw-test"],
    branchNames: [],
  });
  assert.match(m, /leftover worktrees/);
  assert.match(m, /worktree: \/Users\/eggp\/claw-test/);
  assert.match(m, /worktree-cleanup\.md/);
});

test("leftover section appears when branch names are present", () => {
  const m = buildSessionStartMessage(undefined, [], undefined, {
    worktreePaths: [],
    branchNames: ["refactor/old-session-branch"],
  });
  assert.match(m, /branch: refactor\/old-session-branch/);
});

test("leftover section lists both worktrees and branches in one block", () => {
  const m = buildSessionStartMessage(undefined, [], undefined, {
    worktreePaths: ["/Users/eggp/claw-x"],
    branchNames: ["refactor/y"],
  });
  assert.match(m, /worktree: \/Users\/eggp\/claw-x/);
  assert.match(m, /branch: refactor\/y/);
});

test("leftover section appears before pending retrospectives section", () => {
  const m = buildSessionStartMessage(
    undefined,
    [session({})],
    undefined,
    { worktreePaths: ["/Users/eggp/claw-x"], branchNames: [] },
  );
  const leftoverIdx = m.indexOf("leftover worktrees");
  const pendingIdx = m.indexOf("pending retrospectives");
  assert.ok(leftoverIdx >= 0);
  assert.ok(pendingIdx >= 0);
  assert.ok(leftoverIdx < pendingIdx);
});

test("leftover parameter can be undefined (back-compat with prior callers)", () => {
  const m = buildSessionStartMessage(undefined, [], undefined);
  assert.equal(m.includes("leftover"), false);
});