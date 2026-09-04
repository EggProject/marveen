/**
 * Turns a Claude Code session transcript (`.jsonl`) into the listings the
 * retrospective skill reads: user prompts, slash commands, tool-use counts,
 * skill invocations, failed tool results and bash commands.
 *
 * It lives next to SKILL.md because it is the skill's own tool, and it is
 * pure text in, text out so the shared suite can cover it. The reason it
 * exists at all: the extraction used to be an inline `node -e` one-liner in
 * SKILL.md, which every retrospective run had to load into context and
 * re-type correctly.
 *
 * `jq` and line-oriented filters cannot replace it. One JSONL line holds a
 * whole multi-line blob (a `<task-notification>`, a slash command's stdout),
 * so the noise has to be recognised per message, not per line.
 *
 * The two type guards below are local on purpose. The workspace's other
 * copies live in `.claude/hooks/common/typeguards.ts`, a separate tsconfig
 * project under `.claude/`; reaching into it from a skill's script directory
 * would tie this skill bundle to a tree it has nothing else to do with.
 */

/** Narrows an unknown value to a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows an unknown value to a string. */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Most items shown per listing; the rest are counted, not printed. */
export const SECTION_ITEM_LIMIT = 150;

/** Characters kept from one user prompt. */
export const PROMPT_TEXT_LIMIT = 1200;

/** Characters kept from one failed tool result or bash command. */
export const SNIPPET_TEXT_LIMIT = 300;

/** A `<system-reminder>` block: injected by the harness, not by the user. */
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Markers of a user message carrying machine output, not user text. */
const MACHINE_TEXT_MARKERS = [
  "<task-notification>",
  "<local-command",
  "[Request interrupted by user",
] as const;

/** A slash command invocation recorded in a user message. */
const COMMAND_NAME_PATTERN = /<command-name>([^<]*)<\/command-name>/;

/** The arguments recorded alongside a slash command invocation. */
const COMMAND_ARGS_PATTERN = /<command-args>([^<]*)<\/command-args>/;

/**
 * A tool result worth reading as a failure, for the ones the harness did not
 * flag itself: a line that opens with an error label, a non-zero exit code, a
 * runner's `N failed` tally, or a command the shell could not run.
 *
 * The words `error` and `failed` on their own are deliberately not enough. A
 * bare substring match cannot tell a failure from text about failures, so it
 * listed this skill's own prose, its source, and earlier reports; on one
 * session that was about a third of the listing.
 */
const FAILURE_TEXT_PATTERN =
  /(?:^|\n)[ \t]*(?:[A-Za-z]*(?:Error|Exception)\s*:|error\s*:|FAIL(?:ED)?\b|Failed\b)|\b[Ee]xit code (?!0\b)\d+\b|\b\d+ failed\b|\bcommand not found\b/;

/** One capped listing of the report. */
export interface Section<TItem> {
  /** Heading printed above the items. */
  readonly title: string;
  /** How many items the transcript held, before capping. */
  readonly total: number;
  /** The items that fit under the cap. */
  readonly items: readonly TItem[];
  /** True when `total` exceeded the cap and items were dropped. */
  readonly truncated: boolean;
}

/** One user message that carries actual user text. */
export interface UserPrompt {
  /** 1-based position among the user prompts of the session. */
  readonly index: number;
  /** The prompt text, system reminders stripped, capped. */
  readonly text: string;
}

/** One slash command the user typed. */
export interface CommandInvocation {
  /** Command name as recorded, e.g. `/effort`. */
  readonly name: string;
  /** Arguments passed with it, empty when there were none. */
  readonly args: string;
}

/** How often one tool was called. */
export interface ToolUseCount {
  readonly name: string;
  readonly count: number;
}

/** One `Skill` tool call. */
export interface SkillInvocation {
  readonly skill: string;
  readonly args: string;
}

/** Everything the retrospective reads out of one transcript. */
export interface TranscriptReport {
  readonly prompts: Section<UserPrompt>;
  readonly commands: Section<CommandInvocation>;
  readonly toolUses: Section<ToolUseCount>;
  readonly skills: Section<SkillInvocation>;
  readonly failures: Section<string>;
  readonly bashCommands: Section<string>;
  /** JSON objects read from the file. */
  readonly entryCount: number;
  /** Non-empty lines that were not a JSON object. */
  readonly unparsableLines: number;
}

/** Caps a listing at `limit` items, remembering how many there were. */
export function capSection<TItem>(
  title: string,
  items: readonly TItem[],
  limit: number,
): Section<TItem> {
  return {
    title,
    total: items.length,
    items: items.slice(0, limit),
    truncated: items.length > limit,
  };
}

/** Shortens `text` to `limit` characters, marking where it was cut. */
function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)} [...]` : text;
}

/** Characters of lead-in kept before a failure the words matched. */
const FAILURE_LEAD_IN = 80;

/**
 * The part of a tool result worth quoting. A result the harness flagged has
 * its failure at the top, so it is cut from the start; one that matched on
 * its text can have the match thousands of characters in (inside a file the
 * Read tool returned, say), so the window opens just before it instead.
 */
function failureSnippet(text: string, match: RegExpExecArray | null): string {
  if (match === null || match.index <= FAILURE_LEAD_IN) {
    return truncate(singleLine(text), SNIPPET_TEXT_LIMIT);
  }
  const start = match.index - FAILURE_LEAD_IN;
  return `[...] ${truncate(singleLine(text.slice(start)), SNIPPET_TEXT_LIMIT)}`;
}

/** Collapses runs of whitespace so one item stays on one line. */
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Reads a `content` field that is either a string or a block array. */
function contentText(content: unknown): string {
  if (isString(content)) {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const texts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block["type"] === "text" &&
      isString(block["text"])
    ) {
      texts.push(block["text"]);
    }
  }
  return texts.join("\n");
}

/** True when a user message's text is harness output rather than user words. */
function isMachineText(text: string): boolean {
  return MACHINE_TEXT_MARKERS.some((marker) => text.includes(marker));
}

/** The report as the CLI prints it, and as a reader quotes it. */
export function formatSection<TItem>(
  section: Section<TItem>,
  render: (item: TItem) => string,
): string {
  const lines = [`=== ${section.title} (${section.total}) ===`];
  if (section.total === 0) {
    lines.push("(none)");
  }
  for (const item of section.items) {
    lines.push(render(item));
  }
  if (section.truncated) {
    const dropped = section.total - section.items.length;
    lines.push(`[... ${dropped} more not shown, cap ${section.items.length}]`);
  }
  return lines.join("\n");
}

/** Accumulates one transcript's listings while its lines are read. */
interface Collector {
  readonly prompts: UserPrompt[];
  readonly commands: CommandInvocation[];
  readonly skills: SkillInvocation[];
  readonly failures: string[];
  readonly bashCommands: string[];
  readonly toolCounts: Map<string, number>;
}

/** Records one user message as either a prompt or a slash command. */
function collectUserText(text: string, collector: Collector): void {
  const cleaned = text.replace(SYSTEM_REMINDER_PATTERN, "").trim();
  if (cleaned.length === 0) {
    return;
  }
  const commandName = COMMAND_NAME_PATTERN.exec(cleaned)?.[1]?.trim();
  if (commandName !== undefined && commandName.length > 0) {
    const commandArgs = COMMAND_ARGS_PATTERN.exec(cleaned);
    collector.commands.push({
      name: commandName,
      args: singleLine(commandArgs?.[1] ?? ""),
    });
    return;
  }
  if (isMachineText(cleaned)) {
    return;
  }
  collector.prompts.push({
    index: collector.prompts.length + 1,
    text: truncate(cleaned, PROMPT_TEXT_LIMIT),
  });
}

/** Records the failed tool results carried by one user message. */
function collectToolResults(content: unknown, collector: Collector): void {
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "tool_result") {
      continue;
    }
    const text = contentText(block["content"]);
    const flagged = block["is_error"] === true;
    const match = flagged ? null : FAILURE_TEXT_PATTERN.exec(text);
    if (!flagged && match === null) {
      continue;
    }
    collector.failures.push(failureSnippet(text, match));
  }
}

/** Records the tool calls made in one assistant message. */
function collectToolUses(content: unknown, collector: Collector): void {
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "tool_use") {
      continue;
    }
    const name = block["name"];
    if (!isString(name)) {
      continue;
    }
    collector.toolCounts.set(name, (collector.toolCounts.get(name) ?? 0) + 1);
    const input = isRecord(block["input"]) ? block["input"] : {};
    if (name === "Bash" && isString(input["command"])) {
      collector.bashCommands.push(
        truncate(singleLine(input["command"]), SNIPPET_TEXT_LIMIT),
      );
    }
    if (name === "Skill" && isString(input["skill"])) {
      collector.skills.push({
        skill: input["skill"],
        args: truncate(
          singleLine(isString(input["args"]) ? input["args"] : ""),
          SNIPPET_TEXT_LIMIT,
        ),
      });
    }
  }
}

/**
 * Reads every line of `transcript`, skipping `isMeta` entries (skill bodies
 * and caveats the harness injects as user messages) and anything that is not
 * a JSON object. `itemLimit` caps every listing.
 */
export function buildReport(
  transcript: string,
  itemLimit: number = SECTION_ITEM_LIMIT,
): TranscriptReport {
  const collector: Collector = {
    prompts: [],
    commands: [],
    skills: [],
    failures: [],
    bashCommands: [],
    toolCounts: new Map<string, number>(),
  };
  let entryCount = 0;
  let unparsableLines = 0;

  for (const line of transcript.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      unparsableLines += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      unparsableLines += 1;
      continue;
    }
    entryCount += 1;
    if (parsed["isMeta"] === true) {
      continue;
    }
    const message = parsed["message"];
    if (!isRecord(message)) {
      continue;
    }
    if (parsed["type"] === "user") {
      collectUserText(contentText(message["content"]), collector);
      collectToolResults(message["content"], collector);
      continue;
    }
    if (parsed["type"] === "assistant") {
      collectToolUses(message["content"], collector);
    }
  }

  const toolUses = [...collector.toolCounts]
    .map(([name, count]): ToolUseCount => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    prompts: capSection("USER PROMPTS", collector.prompts, itemLimit),
    commands: capSection("SLASH COMMANDS", collector.commands, itemLimit),
    toolUses: capSection("TOOL USE COUNTS", toolUses, itemLimit),
    skills: capSection("SKILL INVOCATIONS", collector.skills, itemLimit),
    failures: capSection("FAILED TOOL RESULTS", collector.failures, itemLimit),
    bashCommands: capSection(
      "BASH COMMANDS",
      collector.bashCommands,
      itemLimit,
    ),
    entryCount,
    unparsableLines,
  };
}

/** Renders the whole report as the text the retrospective agent reads. */
export function formatReport(report: TranscriptReport): string {
  const toolCallTotal = report.toolUses.items.reduce(
    (sum, tool) => sum + tool.count,
    0,
  );
  return [
    `transcript: ${report.entryCount} entries, ` +
      `${report.unparsableLines} unparsable lines, ${toolCallTotal} tool calls`,
    formatSection(
      report.prompts,
      (prompt) => `--- #${prompt.index} ---\n${prompt.text}`,
    ),
    formatSection(report.commands, (command) =>
      command.args.length > 0
        ? `${command.name} ${command.args}`
        : command.name,
    ),
    formatSection(report.toolUses, (tool) => `${tool.name} ${tool.count}`),
    formatSection(report.skills, (skill) =>
      skill.args.length > 0 ? `${skill.skill} | ${skill.args}` : skill.skill,
    ),
    formatSection(report.failures, (failure) => `- ${failure}`),
    formatSection(report.bashCommands, (command) => `- ${command}`),
    "",
  ].join("\n\n");
}
