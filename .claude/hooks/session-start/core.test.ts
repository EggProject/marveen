import assert from "node:assert/strict";
import { test } from "node:test";

import type { UnprocessedSession } from "../common/pending-sessions.ts";
import { buildSessionStartMessage } from "./core.ts";

const SAMPLE_SESSION: UnprocessedSession = {
  sessionId: "d210ebb9-f75b-41f2-a0f1-f11992161cb3",
  transcriptPath:
    "/fixtures/transcripts/d210ebb9-f75b-41f2-a0f1-f11992161cb3.jsonl",
  toolUseTotal: 55,
  modifiedAt: 1_700_000_000_000,
};

test("message is empty when every part is empty", () => {
  const message = buildSessionStartMessage(undefined, [], undefined);
  assert.equal(message, "");
});

test("message omits the memory section when no content is given", () => {
  const message = buildSessionStartMessage(undefined, [], undefined);
  assert.doesNotMatch(message, /\[muhely shared memory\]/);
});

test("message omits the memory section when the content is an empty string", () => {
  const message = buildSessionStartMessage("", [], undefined);
  assert.doesNotMatch(message, /\[muhely shared memory\]/);
});

test("message includes the memory section when content is given", () => {
  const message = buildSessionStartMessage("remembered fact", [], undefined);
  assert.match(message, /\[muhely shared memory\]/);
  assert.match(message, /remembered fact/);
  assert.match(message, /pnpm claude:memory read <topic>/);
  assert.match(message, /pnpm claude:memory search "<query>"/);
  assert.match(message, /Do not open these files directly\./);
});

test("message omits the pending retrospectives section when pending is empty", () => {
  const message = buildSessionStartMessage(undefined, [], undefined);
  assert.doesNotMatch(message, /\[muhely pending retrospectives\]/);
});

test("message includes the pending retrospectives section when pending is non-empty", () => {
  const message = buildSessionStartMessage(
    undefined,
    [SAMPLE_SESSION],
    undefined,
  );
  assert.match(message, /\[muhely pending retrospectives\]/);
  assert.ok(message.includes(SAMPLE_SESSION.transcriptPath));
  assert.match(message, /AskUserQuestion/);
  assert.match(message, /skill="retrospective"/);
  assert.match(message, /\.skipped\.md/);
});

test("message omits the current transcript line when currentTranscriptPath is undefined", () => {
  const message = buildSessionStartMessage(undefined, [], undefined);
  assert.doesNotMatch(message, /Current session transcript:/);
});

test("message includes the current transcript line when currentTranscriptPath is given", () => {
  const message = buildSessionStartMessage(
    undefined,
    [],
    "/fixtures/transcripts/current.jsonl",
  );
  assert.match(
    message,
    /Current session transcript: \/fixtures\/transcripts\/current\.jsonl/,
  );
});

test("message assembles all three parts in order when all are present", () => {
  const message = buildSessionStartMessage(
    "remembered fact",
    [SAMPLE_SESSION],
    "/fixtures/transcripts/current.jsonl",
  );
  const transcriptIndex = message.indexOf("Current session transcript:");
  const memoryIndex = message.indexOf("[muhely shared memory]");
  const pendingIndex = message.indexOf("[muhely pending retrospectives]");
  assert.ok(transcriptIndex >= 0);
  assert.ok(memoryIndex > transcriptIndex);
  assert.ok(pendingIndex > memoryIndex);
});
