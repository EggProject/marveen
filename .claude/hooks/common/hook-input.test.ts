import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseHookInput,
  parseSessionStartHookInput,
  parseStopHookInput,
} from "./hook-input.ts";

test("parseHookInput accepts a valid payload", () => {
  const result = parseHookInput(
    {
      hook_event_name: "Stop",
      session_id: "s1",
      transcript_path: "/t",
      cwd: "/c",
    },
    "Stop",
  );
  assert.deepEqual(result, {
    hookEventName: "Stop",
    sessionId: "s1",
    transcriptPath: "/t",
    cwd: "/c",
  });
});

test("parseHookInput rejects a missing field", () => {
  const result = parseHookInput(
    { hook_event_name: "Stop", session_id: "s1", cwd: "/c" },
    "Stop",
  );
  assert.equal(result, undefined);
});

test("parseHookInput rejects a mismatched event", () => {
  const result = parseHookInput(
    {
      hook_event_name: "SessionStart",
      session_id: "s1",
      transcript_path: "/t",
      cwd: "/c",
    },
    "Stop",
  );
  assert.equal(result, undefined);
});

test("parseStopHookInput defaults stop_hook_active to false", () => {
  const result = parseStopHookInput({
    hook_event_name: "Stop",
    session_id: "s1",
    transcript_path: "/t",
    cwd: "/c",
  });
  assert.equal(result?.stopHookActive, false);
});

test("parseStopHookInput reads stop_hook_active when present", () => {
  const result = parseStopHookInput({
    hook_event_name: "Stop",
    session_id: "s1",
    transcript_path: "/t",
    cwd: "/c",
    stop_hook_active: true,
  });
  assert.equal(result?.stopHookActive, true);
});

test("parseSessionStartHookInput defaults source to startup", () => {
  const result = parseSessionStartHookInput({
    hook_event_name: "SessionStart",
    session_id: "s1",
    transcript_path: "/t",
    cwd: "/c",
  });
  assert.equal(result?.source, "startup");
});

test("parseSessionStartHookInput reads source when present", () => {
  const result = parseSessionStartHookInput({
    hook_event_name: "SessionStart",
    session_id: "s1",
    transcript_path: "/t",
    cwd: "/c",
    source: "resume",
  });
  assert.equal(result?.source, "resume");
});
