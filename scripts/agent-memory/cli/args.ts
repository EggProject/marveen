/**
 * Command line parsing for the shared memory CLI. Pure: no I/O, no exits.
 *
 * Topic names are validated here rather than in the io layer, so a name that
 * could escape the memory directory is rejected before any path is built from
 * it.
 */
import { DEFAULT_LIMIT } from "../search/search";
import {
  INDEX_MAX_BYTES,
  INDEX_MAX_LINES,
  SUMMARY_MAX_LENGTH,
} from "../store/index";
import {
  RETROSPECTIVE_FILES_DEFAULT,
  RETROSPECTIVE_LINES_DEFAULT,
  SINCE_DATE_PATTERN,
} from "../store/retrospective";
import { isTopicName, TOPIC_PATTERN, TOPIC_RULE } from "../store/topic";

/** Create or replace one topic and its index entry. */
export interface WriteCommand {
  readonly kind: "write";
  readonly topic: string;
  readonly summary: string;
  readonly content: string;
}

/** A fully parsed invocation. */
export type Command =
  | { readonly kind: "list" }
  | {
      readonly kind: "search";
      readonly query: string;
      readonly limit: number;
      /** Retrospective reports given snippets on this page. */
      readonly retrospectiveFilesPerPage: number;
      /** Snippet lines printed per shown retrospective report. */
      readonly retrospectiveLinesPerReport: number;
      /** 1-based page over the ranked retrospective report list. */
      readonly retrospectivePage: number;
      /** Only reports dated on or after this date; undefined means no filter. */
      readonly retrospectiveSince: string | undefined;
    }
  | { readonly kind: "read"; readonly topic: string }
  | WriteCommand
  | { readonly kind: "remove"; readonly topic: string }
  | { readonly kind: "status" }
  | { readonly kind: "reviewed" };

/** Outcome of parsing argv. */
export type ParseResult =
  | { readonly kind: "command"; readonly command: Command }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export const HELP = `Usage:
  pnpm claude:memory <command> [options]

The workspace's shared memory: an index at .claude/shared-memory/MEMORY.md
plus one file per topic beside it. The SessionStart hook injects only the
index, so a topic file is read on demand, which is what these commands are
for. Read them through this tool rather than opening the files.

Commands:
  list                    Print the index verbatim.
  search <query>          Case-insensitive substring search over the index and
                          every topic file, ranked by how many lines of a file
                          matched, printed first; then reports from
                          .claude/retrospectives, raw session evidence nobody
                          curated, ranked by report: the report with the most
                          matching lines first, ties broken by the newest
                          report first. Prints <path>:<line> and the matching
                          line, paged so one dense report cannot crowd out
                          every other report that matched.
    --limit <n>           Maximum memory hits to print. Default ${DEFAULT_LIMIT}.
    --retrospective-files <n>
                          Retrospective reports given snippets on one page.
                          Default ${RETROSPECTIVE_FILES_DEFAULT}.
    --retrospective-lines <n>
                          Snippet lines printed per shown retrospective
                          report. Default ${RETROSPECTIVE_LINES_DEFAULT}.
    --retrospective-page <n>
                          1-based page over the ranked retrospective report
                          list. Default 1.
    --retrospective-since <YYYY-MM-DD>
                          Only retrospective reports dated on or after this
                          date. A report whose file name carries no date is
                          never filtered out.
  read <topic>            Print one topic file, or list the known topics when
                          there is no such topic.
  write <topic> --summary "<one line>" --content "<body>"
                          Create or replace a topic file and its index entry.
  remove <topic>          Delete a topic file and its index entry.
  status                  Print the entry count, the index size against both
                          caps, the last review date, and whether a review is
                          due, with the reason.
  reviewed                Stamp the index with today's date and the current
                          entry count as the last review. Run by the
                          memory-review skill at the end of a completed
                          review; not for running by hand after an abandoned
                          one.
  -h, --help              Print this help.

write and remove change committed memory. Run them only after the
retrospective skill has proposed the change and the user has approved it.
Neither is for notes a session decides on its own to keep.

Limits:
  topic    ${TOPIC_PATTERN.source}, so it is always a safe path segment
  summary  one line, at most ${SUMMARY_MAX_LENGTH} characters
  index    at most ${INDEX_MAX_LINES} lines and ${INDEX_MAX_BYTES} bytes, which is the SessionStart
           hook's own injection cap, so this tool can never write an index
           the hook would silently truncate

Exit codes:
  0  success, including a search that matched nothing
  1  a usage error, or a topic that does not exist
  2  an unexpected internal failure`;

function ok(command: Command): ParseResult {
  return { kind: "command", command };
}

function fail(message: string): ParseResult {
  return { kind: "error", message };
}

/** Splits `--flag=value` into its two halves; a bare flag has no value. */
function splitFlag(argument: string): readonly [string, string | undefined] {
  const separator = argument.indexOf("=");
  return separator === -1
    ? [argument, undefined]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}

/** The single topic argument `read` and `remove` take, or why it is not one. */
function parseTopic(
  command: string,
  argv: readonly string[],
): string | ParseResult {
  const [topic, ...extra] = argv;
  if (topic === undefined) return fail(`${command} needs a topic name.`);
  if (extra.length > 0) {
    return fail(`${command} takes one topic; unexpected: ${extra.join(" ")}`);
  }
  if (!isTopicName(topic)) {
    return fail(`Rejected topic name "${topic}": ${TOPIC_RULE}.`);
  }
  return topic;
}

/**
 * The value for a flag, taken from `--flag=value` or from the next argv entry.
 * A next entry that is itself a flag is left where it is, so a typo surfaces
 * as a missing value instead of being swallowed as one. `consumed` says
 * whether the caller should skip that entry.
 */
function takeFlagValue(
  inlineValue: string | undefined,
  next: string | undefined,
): { readonly value: string | undefined; readonly consumed: boolean } {
  if (inlineValue !== undefined) return { value: inlineValue, consumed: false };
  if (next === undefined || next.startsWith("--")) {
    return { value: undefined, consumed: false };
  }
  return { value: next, consumed: true };
}

/** Parses a `--limit`-shaped flag's value into a positive integer. */
function parsePositiveInt(
  flag: string,
  value: string | undefined,
): number | ParseResult {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1) {
    return fail(`${flag} needs a positive integer, got: ${value ?? "nothing"}`);
  }
  return parsed;
}

/** Parses a `--retrospective-since`-shaped flag's value into a YYYY-MM-DD date. */
function parseSinceDate(
  flag: string,
  value: string | undefined,
): string | ParseResult {
  if (value === undefined || !SINCE_DATE_PATTERN.test(value)) {
    return fail(`${flag} needs a YYYY-MM-DD date, got: ${value ?? "nothing"}`);
  }
  return value;
}

/** Flags whose value is a positive integer count, `--limit` included. */
const COUNT_FLAGS: ReadonlySet<string> = new Set([
  "--limit",
  "--retrospective-files",
  "--retrospective-lines",
  "--retrospective-page",
]);

/** The four count-flag totals `parseSearch` accumulates while it scans argv. */
interface CountFlagValues {
  readonly limit: number;
  readonly retrospectiveFilesPerPage: number;
  readonly retrospectiveLinesPerReport: number;
  readonly retrospectivePage: number;
}

/**
 * Applies one parsed count flag's value to the running totals, returning the
 * updated set. Each of the four flags in COUNT_FLAGS gets its own explicit
 * branch here; a flag added to that set without a matching branch throws
 * instead of silently landing on `--retrospective-page`, which is what a bare
 * trailing `else` used to do. Exported only so a direct test can pin the
 * throw, since COUNT_FLAGS itself never admits an unhandled flag.
 */
export function applyCountFlag(
  flag: string,
  parsed: number,
  current: CountFlagValues,
): CountFlagValues {
  if (flag === "--limit") return { ...current, limit: parsed };
  if (flag === "--retrospective-files") {
    return { ...current, retrospectiveFilesPerPage: parsed };
  }
  if (flag === "--retrospective-lines") {
    return { ...current, retrospectiveLinesPerReport: parsed };
  }
  if (flag === "--retrospective-page") {
    return { ...current, retrospectivePage: parsed };
  }
  throw new Error(`Unhandled count flag: ${flag}`);
}

function parseSearch(argv: readonly string[]): ParseResult {
  let query: string | undefined;
  let counts: CountFlagValues = {
    limit: DEFAULT_LIMIT,
    retrospectiveFilesPerPage: RETROSPECTIVE_FILES_DEFAULT,
    retrospectiveLinesPerReport: RETROSPECTIVE_LINES_DEFAULT,
    retrospectivePage: 1,
  };
  let retrospectiveSince: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    const [flag, inlineValue] = splitFlag(argument);

    if (COUNT_FLAGS.has(flag)) {
      const { value, consumed } = takeFlagValue(inlineValue, argv[index + 1]);
      if (consumed) index++;
      const parsed = parsePositiveInt(flag, value);
      if (typeof parsed !== "number") return parsed;
      counts = applyCountFlag(flag, parsed, counts);
      continue;
    }
    if (flag === "--retrospective-since") {
      const { value, consumed } = takeFlagValue(inlineValue, argv[index + 1]);
      if (consumed) index++;
      const parsed = parseSinceDate(flag, value);
      if (typeof parsed !== "string") return parsed;
      retrospectiveSince = parsed;
      continue;
    }
    if (argument.startsWith("--")) {
      return fail(`Unknown option for search: ${argument}`);
    }
    if (query !== undefined) {
      return fail("search takes one query; quote it if it has spaces.");
    }
    query = argument;
  }

  if (!query) {
    return fail('search needs a query, for example: search "porta workflow".');
  }
  return ok({
    kind: "search",
    query,
    limit: counts.limit,
    retrospectiveFilesPerPage: counts.retrospectiveFilesPerPage,
    retrospectiveLinesPerReport: counts.retrospectiveLinesPerReport,
    retrospectivePage: counts.retrospectivePage,
    retrospectiveSince,
  });
}

function parseWrite(argv: readonly string[]): ParseResult {
  let topic: string | undefined;
  let summary: string | undefined;
  let content: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    const [flag, inlineValue] = splitFlag(argument);

    if (flag === "--summary" || flag === "--content") {
      const { value, consumed } = takeFlagValue(inlineValue, argv[index + 1]);
      if (consumed) index++;
      if (value === undefined) return fail(`Missing value for ${flag}.`);
      if (flag === "--summary") summary = value;
      else content = value;
      continue;
    }
    if (argument.startsWith("--")) {
      return fail(`Unknown option for write: ${argument}`);
    }
    if (topic !== undefined) return fail("write takes one topic.");
    topic = argument;
  }

  if (topic === undefined) return fail("write needs a topic name.");
  if (!isTopicName(topic)) {
    return fail(`Rejected topic name "${topic}": ${TOPIC_RULE}.`);
  }
  if (summary === undefined) return fail('write needs --summary "<one line>".');
  if (content === undefined) return fail('write needs --content "<body>".');
  return ok({ kind: "write", topic, summary, content });
}

/** Parses argv into a command, a help request, or a message. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const [name, ...rest] = argv;

  if (name === undefined || name === "-h" || name === "--help") {
    return { kind: "help" };
  }

  switch (name) {
    case "list":
      return rest.length === 0
        ? ok({ kind: "list" })
        : fail(`list takes no arguments; unexpected: ${rest.join(" ")}`);
    case "search":
      return parseSearch(rest);
    case "write":
      return parseWrite(rest);
    case "read": {
      const topic = parseTopic("read", rest);
      return typeof topic === "string" ? ok({ kind: "read", topic }) : topic;
    }
    case "remove": {
      const topic = parseTopic("remove", rest);
      return typeof topic === "string" ? ok({ kind: "remove", topic }) : topic;
    }
    case "status":
      return rest.length === 0
        ? ok({ kind: "status" })
        : fail(`status takes no arguments; unexpected: ${rest.join(" ")}`);
    case "reviewed":
      return rest.length === 0
        ? ok({ kind: "reviewed" })
        : fail(`reviewed takes no arguments; unexpected: ${rest.join(" ")}`);
    default:
      return fail(`Unknown command: ${name}`);
  }
}
