import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const STOP_GUARD_PATH = join(import.meta.dirname, "hook.ts");
/** `.claude/hooks`, one level above this `stop-guard` directory. */
const HOOKS_DIR = resolve(import.meta.dirname, "..");
const STATE_DIR = join(HOOKS_DIR, ".state");

const tmpDir = mkdtempSync(join(tmpdir(), "muhely-stop-guard-"));
const stateFilesToClean: string[] = [];

mkdirSync(STATE_DIR, { recursive: true });

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  for (const filePath of stateFilesToClean) {
    rmSync(filePath, { force: true });
  }
});

/** Registers a `test-*` state file path for cleanup and returns it. */
function stateFileFor(sessionId: string): string {
  const filePath = join(STATE_DIR, `${sessionId}.json`);
  stateFilesToClean.push(filePath);
  return filePath;
}

function assistantBlocks(
  blocks: ReadonlyArray<Record<string, unknown>>,
): string {
  return JSON.stringify({ type: "assistant", message: { content: blocks } });
}

function toolUse(name: string): Record<string, unknown> {
  return { type: "tool_use", name, input: {} };
}

function writeTranscript(
  fileName: string,
  lines: ReadonlyArray<string>,
): string {
  const transcriptPath = join(tmpDir, fileName);
  writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  return transcriptPath;
}

/** Ten tool_use blocks across assistant lines, with no TaskCreate among them. */
function tenToolUsesNoTaskCreate(): string[] {
  const names = [
    "Read",
    "Grep",
    "Edit",
    "Write",
    "Bash",
    "Glob",
    "Read",
    "Grep",
    "Edit",
    "Write",
  ];
  return names.map((name) => assistantBlocks([toolUse(name)]));
}

function runStopGuard(payload: Record<string, unknown>) {
  return spawnSync(process.execPath, [STOP_GUARD_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

function stopHookPayload(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    hook_event_name: "Stop",
    stop_hook_active: false,
    ...overrides,
  };
}

test("a nonexistent transcript allows the stop", () => {
  const sessionId = "test-nonexistent";
  stateFileFor(sessionId);
  const result = runStopGuard(
    stopHookPayload({
      session_id: sessionId,
      transcript_path: join(tmpDir, "does-not-exist.jsonl"),
      cwd: tmpDir,
    }),
  );
  assert.equal(result.status, 0);
});

test("10 tool uses with no TaskCreate blocks once, then allows on the next call", () => {
  const sessionId = "test-todo-nudge";
  const stateFile = stateFileFor(sessionId);
  const transcriptPath = writeTranscript(
    "todo.jsonl",
    tenToolUsesNoTaskCreate(),
  );
  const payload = stopHookPayload({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: tmpDir,
  });

  const first = runStopGuard(payload);
  assert.equal(first.status, 2);
  assert.match(first.stderr, /Mandatory Todo task list/);
  assert.equal(existsSync(stateFile), true);

  const second = runStopGuard(payload);
  assert.equal(second.status, 0);
});

test("stop_hook_active true always allows, even with a nudge-worthy transcript", () => {
  const sessionId = "test-active";
  stateFileFor(sessionId);
  const transcriptPath = writeTranscript(
    "active.jsonl",
    tenToolUsesNoTaskCreate(),
  );
  const result = runStopGuard(
    stopHookPayload({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: tmpDir,
      stop_hook_active: true,
    }),
  );
  assert.equal(result.status, 0);
});

test("an unsafe session id is skipped without writing outside .state", () => {
  const sessionId = "../evil";
  const transcriptPath = writeTranscript(
    "evil.jsonl",
    tenToolUsesNoTaskCreate(),
  );
  const result = runStopGuard(
    stopHookPayload({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: tmpDir,
    }),
  );
  assert.equal(result.status, 0);
  assert.match(result.stderr, /invalid session id, skipping/);
  const escapedPath = join(HOOKS_DIR, "evil.json");
  assert.equal(existsSync(escapedPath), false);
});

test("a corrupt state file still nudges for the missing Todo list", () => {
  const sessionId = "test-corrupt-state";
  const stateFile = stateFileFor(sessionId);
  writeFileSync(stateFile, "{not valid json", "utf8");
  const transcriptPath = writeTranscript(
    "corrupt.jsonl",
    tenToolUsesNoTaskCreate(),
  );
  const result = runStopGuard(
    stopHookPayload({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: tmpDir,
    }),
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Mandatory Todo task list/);
});
