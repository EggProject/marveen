import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { scanTranscript } from "./transcript.ts";

const tmpDir = mkdtempSync(join(tmpdir(), "muhely-hooks-"));

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("scanTranscript counts tool uses, TaskCreate, and the last retrospective marker", async () => {
  const transcriptPath = join(tmpDir, "transcript.jsonl");
  const assistantBlocks = (blocks: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify({ type: "assistant", message: { content: blocks } });

  const toolUse = (name: string, input: Record<string, unknown> = {}) => ({
    type: "tool_use",
    name,
    input,
  });

  const lines = [
    "{not valid json",
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    assistantBlocks([toolUse("Read"), toolUse("TaskCreate"), toolUse("Grep")]),
    assistantBlocks([toolUse("Skill", { skill: "retrospective" })]),
    assistantBlocks([toolUse("Edit"), toolUse("Write")]),
  ];
  writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

  const stats = await scanTranscript(transcriptPath);
  assert.equal(stats.toolUseTotal, 6);
  assert.equal(stats.taskCreateCount, 1);
  assert.equal(stats.lastRetrospectiveAtToolCount, 4);
});

test("scanTranscript returns zeros for a missing file", async () => {
  const stats = await scanTranscript(join(tmpDir, "does-not-exist.jsonl"));
  assert.deepEqual(stats, {
    toolUseTotal: 0,
    taskCreateCount: 0,
    lastRetrospectiveAtToolCount: 0,
  });
});

const canTestUnreadableFile = process.getuid?.() !== 0;

test(
  "scanTranscript tolerates an unreadable transcript file and returns zeros",
  { skip: !canTestUnreadableFile },
  async () => {
    const transcriptPath = join(tmpDir, "unreadable.jsonl");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
    });
    writeFileSync(transcriptPath, `${line}\n`, "utf8");
    chmodSync(transcriptPath, 0o000);
    try {
      const stats = await scanTranscript(transcriptPath);
      assert.deepEqual(stats, {
        toolUseTotal: 0,
        taskCreateCount: 0,
        lastRetrospectiveAtToolCount: 0,
      });
    } finally {
      chmodSync(transcriptPath, 0o644);
    }
  },
);

test("scanTranscript treats a namespaced retrospective skill invocation as a retrospective run", async () => {
  const transcriptPath = join(tmpDir, "transcript-namespaced-skill.jsonl");
  const assistantBlocks = (blocks: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify({ type: "assistant", message: { content: blocks } });
  const toolUse = (name: string, input: Record<string, unknown> = {}) => ({
    type: "tool_use",
    name,
    input,
  });

  const lines = [
    assistantBlocks([toolUse("Read"), toolUse("Grep")]),
    assistantBlocks([
      toolUse("Skill", { skill: "packages/shared:retrospective" }),
    ]),
    assistantBlocks([toolUse("Edit")]),
  ];
  writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

  const stats = await scanTranscript(transcriptPath);
  assert.equal(stats.toolUseTotal, 4);
  assert.equal(stats.lastRetrospectiveAtToolCount, 3);
});

test("scanTranscript treats a slashless /retrospective command marker as a retrospective run", async () => {
  const transcriptPath = join(tmpDir, "transcript-slashless-command.jsonl");
  const assistantBlocks = (blocks: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify({ type: "assistant", message: { content: blocks } });
  const toolUse = (name: string) => ({ type: "tool_use", name, input: {} });

  const lines = [
    assistantBlocks([toolUse("Read")]),
    JSON.stringify({
      type: "user",
      message: { content: "<command-name>retrospective</command-name>" },
    }),
    assistantBlocks([toolUse("Edit"), toolUse("Write")]),
  ];
  writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

  const stats = await scanTranscript(transcriptPath);
  assert.equal(stats.toolUseTotal, 3);
  assert.equal(stats.lastRetrospectiveAtToolCount, 1);
});

test("scanTranscript treats a /retrospective slash command (string content) as a retrospective run", async () => {
  const transcriptPath = join(tmpDir, "transcript-slash-string.jsonl");
  const assistantBlocks = (blocks: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify({ type: "assistant", message: { content: blocks } });
  const toolUse = (name: string) => ({ type: "tool_use", name, input: {} });

  const lines = [
    assistantBlocks([toolUse("Read"), toolUse("Grep")]),
    JSON.stringify({
      type: "user",
      message: {
        content:
          "<command-name>/retrospective</command-name>\n<command-message>retrospective</command-message>",
      },
    }),
    assistantBlocks([toolUse("Edit")]),
  ];
  writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

  const stats = await scanTranscript(transcriptPath);
  assert.equal(stats.toolUseTotal, 3);
  assert.equal(stats.lastRetrospectiveAtToolCount, 2);
});

test("scanTranscript treats a /retrospective slash command (text-block content) as a retrospective run", async () => {
  const transcriptPath = join(tmpDir, "transcript-slash-blocks.jsonl");
  const assistantBlocks = (blocks: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify({ type: "assistant", message: { content: blocks } });
  const toolUse = (name: string) => ({ type: "tool_use", name, input: {} });

  const lines = [
    assistantBlocks([toolUse("Read")]),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "text",
            text: "<command-name>/retrospective</command-name>",
          },
        ],
      },
    }),
    assistantBlocks([toolUse("Edit"), toolUse("Write")]),
  ];
  writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

  const stats = await scanTranscript(transcriptPath);
  assert.equal(stats.toolUseTotal, 3);
  assert.equal(stats.lastRetrospectiveAtToolCount, 1);
});
