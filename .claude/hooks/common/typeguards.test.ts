import assert from "node:assert/strict";
import { test } from "node:test";

import { hasErrorCode, isSafeSessionId } from "./typeguards.ts";

test("isSafeSessionId accepts a UUID", () => {
  assert.equal(isSafeSessionId("d210ebb9-f75b-41f2-a0f1-f11992161cb3"), true);
});

test("isSafeSessionId rejects an empty string", () => {
  assert.equal(isSafeSessionId(""), false);
});

test("isSafeSessionId rejects a path traversal segment", () => {
  assert.equal(isSafeSessionId("../x"), false);
});

test("isSafeSessionId rejects an embedded path separator", () => {
  assert.equal(isSafeSessionId("a/b"), false);
});

test("isSafeSessionId rejects a string longer than 128 characters", () => {
  assert.equal(isSafeSessionId("a".repeat(129)), false);
});

test("hasErrorCode accepts a Node ErrnoException-shaped error", () => {
  assert.equal(
    hasErrorCode(Object.assign(new Error("x"), { code: "ENOENT" })),
    true,
  );
});

test("hasErrorCode rejects an error with no code property", () => {
  assert.equal(hasErrorCode(new Error("x")), false);
});

test("hasErrorCode rejects a non-object value", () => {
  assert.equal(hasErrorCode("nope"), false);
});
