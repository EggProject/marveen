/**
 * Session transcript scanning for muhely Claude Code hooks: counts tool
 * uses, `TaskCreate` calls, and the tool-use count at the most recent
 * retrospective run.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

import { isRecord, isString } from "./typeguards.ts";

/** Aggregate counters derived from a session transcript. */
export interface TranscriptStats {
  readonly toolUseTotal: number;
  readonly taskCreateCount: number;
  readonly lastRetrospectiveAtToolCount: number;
}

/** Name of the skill invocation that runs a session retrospective. */
export const RETROSPECTIVE_SKILL_NAME = "retrospective";

/** Name of the tool used to create Todo tasks. */
export const TASK_CREATE_TOOL_NAME = "TaskCreate";

/**
 * Matches a `/retrospective` slash-command marker in a transcript, allowing
 * an optional leading slash and an optional `<namespace>:` prefix (e.g.
 * `<command-name>packages/shared:retrospective</command-name>`).
 */
export const RETROSPECTIVE_COMMAND_MARKER_PATTERN =
  /<command-name>\/?(?:[^<:]*:)?retrospective<\/command-name>/;

/** A single content block on an assistant transcript message. */
interface ToolUseBlock {
  readonly type: "tool_use";
  readonly name: string;
  readonly input: Record<string, unknown>;
}

function isToolUseBlock(v: unknown): v is ToolUseBlock {
  return (
    isRecord(v) &&
    v["type"] === "tool_use" &&
    isString(v["name"]) &&
    isRecord(v["input"])
  );
}

/** A single text content block on a user transcript message. */
interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

function isTextBlock(v: unknown): v is TextBlock {
  return isRecord(v) && v["type"] === "text" && isString(v["text"]);
}

/** Extracts the plain text of a user message's `content` field, string or block-array form. */
function extractUserMessageText(content: unknown): string {
  if (isString(content)) {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n");
}

/**
 * True when a `Skill` tool_use input's `skill` value names the retrospective
 * skill, allowing an optional `<namespace>:` prefix (e.g.
 * `packages/shared:retrospective`).
 */
export function isRetrospectiveSkillInput(
  input: Record<string, unknown>,
): boolean {
  const skill = input["skill"];
  if (!isString(skill)) {
    return false;
  }
  const lastColon = skill.lastIndexOf(":");
  const name = lastColon === -1 ? skill : skill.slice(lastColon + 1);
  return name === RETROSPECTIVE_SKILL_NAME;
}

/**
 * Streams a transcript `.jsonl` file line by line, counting tool_use blocks,
 * TaskCreate invocations, and the running tool-use count at the most recent
 * retrospective run (either a `retrospective` skill invocation or a
 * user-typed `/retrospective` slash command). Unparsable lines are skipped.
 * A missing file yields all zeros. On a stream or read error, the counters
 * accumulated so far are returned rather than thrown.
 */
export async function scanTranscript(
  transcriptPath: string,
): Promise<TranscriptStats> {
  if (!existsSync(transcriptPath)) {
    return {
      toolUseTotal: 0,
      taskCreateCount: 0,
      lastRetrospectiveAtToolCount: 0,
    };
  }

  let toolUseTotal = 0;
  let taskCreateCount = 0;
  let lastRetrospectiveAtToolCount = 0;

  try {
    const stream = createReadStream(transcriptPath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }

      if (parsed["type"] === "user") {
        const message = parsed["message"];
        const text = isRecord(message)
          ? extractUserMessageText(message["content"])
          : "";
        if (RETROSPECTIVE_COMMAND_MARKER_PATTERN.test(text)) {
          lastRetrospectiveAtToolCount = toolUseTotal;
        }
        continue;
      }

      if (parsed["type"] !== "assistant") {
        continue;
      }
      const message = parsed["message"];
      if (!isRecord(message) || !Array.isArray(message["content"])) {
        continue;
      }
      for (const block of message["content"]) {
        if (!isToolUseBlock(block)) {
          continue;
        }
        toolUseTotal += 1;
        if (block.name === TASK_CREATE_TOOL_NAME) {
          taskCreateCount += 1;
        }
        if (block.name === "Skill" && isRetrospectiveSkillInput(block.input)) {
          lastRetrospectiveAtToolCount = toolUseTotal;
        }
      }
    }
  } catch (error) {
    process.stderr.write(`[hook-io] scanTranscript error: ${String(error)}\n`);
  }

  return { toolUseTotal, taskCreateCount, lastRetrospectiveAtToolCount };
}
