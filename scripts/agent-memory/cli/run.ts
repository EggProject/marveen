/**
 * Orchestration: argv in, printed output and exit code out.
 *
 * The I/O it needs arrives as an `AgentMemoryIo`, so every command can be
 * driven end to end by a test without a directory on disk.
 */
import { type AgentMemoryIo, topicPath } from "../io/io";
import { search, searchGroupedByFile, type SearchFile } from "../search/search";
import {
  extractReviewedStamp,
  INDEX_HEADER,
  INDEX_MAX_BYTES,
  INDEX_MAX_LINES,
  INDEX_PATH,
  indexSize,
  indexTooLargeProblem,
  parseIndex,
  pluralizeEntries,
  renderIndex,
  renderReviewedLine,
  summaryProblem,
  withEntry,
  withoutEntry,
  withReviewedStamp,
} from "../store/index";
import {
  matchesSince,
  newestFirst,
  retrospectiveDate,
  retrospectivePath,
} from "../store/retrospective";
import { reviewDue } from "../store/status";
import {
  extractRecordedDate,
  formatUnknownTopic,
  renderTopicFile,
} from "../store/topic";
import { type Command, HELP, parseArgs, type WriteCommand } from "./args";

/** Exit codes, so the caller and the help text cannot drift apart. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_INTERNAL = 2;

/** Prints the index as it stands, or says there is none yet. */
function runList(io: AgentMemoryIo): number {
  const index = io.readIndex();
  io.log(
    index === undefined
      ? `No shared memory yet: ${INDEX_PATH} does not exist.`
      : index.trimEnd(),
  );
  return EXIT_OK;
}

/**
 * One corpus of files for search, with the date each path prints beside a hit.
 *
 * A path present in `dates` with an undefined value is dated by its corpus but
 * carries no date of its own; a path missing from `dates` altogether is not
 * dated by that corpus at all (the index is the only one) and prints no
 * suffix. `dateSuffix` is what turns those three cases into text.
 */
interface DatedFiles {
  readonly files: readonly SearchFile[];
  readonly dates: ReadonlyMap<string, string | undefined>;
}

/**
 * Reads the index and every topic file into the shape search wants. A topic
 * file's date is its `Recorded:` line, undefined when it has none; the index
 * gets no entry, because it is not a topic file.
 */
function searchableFiles(io: AgentMemoryIo): DatedFiles {
  const files: SearchFile[] = [];
  const dates = new Map<string, string | undefined>();
  const index = io.readIndex();
  if (index !== undefined) files.push({ path: INDEX_PATH, text: index });
  for (const topic of io.listTopics()) {
    const text = io.readTopic(topic);
    if (text === undefined) continue;
    const path = topicPath(topic);
    files.push({ path, text });
    dates.set(path, extractRecordedDate(text));
  }
  return { files, dates };
}

/**
 * The `(<label> ...)` suffix search prints after a hit's path: `(recorded
 * 2026-01-15)` for a topic file, `(retrospective 2026-01-10)` for a report.
 * One function for both corpora, so the two labels cannot drift into two
 * different shapes; the retrospective wording is the one
 * `.claude/shared-memory/CLAUDE.md` documents, so it is the shape both follow.
 */
function dateSuffix(
  dates: ReadonlyMap<string, string | undefined>,
  path: string,
  label: string,
): string {
  if (!dates.has(path)) return "";
  const date = dates.get(path);
  return date === undefined
    ? ` (${label}, date unknown)`
    : ` (${label} ${date})`;
}

/**
 * The retrospective report files search runs over. Each report's date comes
 * from its own file name, which carries it in place of a topic file's
 * `Recorded:` line, since a retrospective report never has one.
 */
interface RetrospectiveSearchable extends DatedFiles {
  /**
   * Reports `since` excluded before their file was read. Known exactly
   * because the filter runs on the file name alone; whether an excluded
   * report's text would have matched the query is not, since it was never
   * read.
   */
  readonly excludedBySince: number;
}

/**
 * Every searchable retrospective report, keyed by path for the
 * `(retrospective ...)` suffix and for ranking pages newest-first.
 *
 * `retrospectiveDate` needs only a report's file name, so `since` is applied
 * to `io.listRetrospectives()` before any file is read: a report the filter
 * excludes is never read at all, rather than read and then discarded.
 */
function retrospectiveFiles(
  io: AgentMemoryIo,
  since: string | undefined,
): RetrospectiveSearchable {
  const files: SearchFile[] = [];
  const dates = new Map<string, string | undefined>();
  let excludedBySince = 0;
  for (const name of io.listRetrospectives()) {
    if (!matchesSince(retrospectiveDate(name), since)) {
      excludedBySince++;
      continue;
    }
    const text = io.readRetrospective(name);
    if (text === undefined) continue;
    const path = retrospectivePath(name);
    files.push({ path, text });
    dates.set(path, retrospectiveDate(name));
  }
  return { files, dates, excludedBySince };
}

/** How the retrospective block of `search` is paged. */
interface RetrospectivePaging {
  /** Reports given snippets on this page. */
  readonly filesPerPage: number;
  /** Snippet lines printed per shown report. */
  readonly linesPerReport: number;
  /** 1-based page over the ranked report list. */
  readonly page: number;
  /** Only reports dated on or after this date; undefined means no filter. */
  readonly since: string | undefined;
}

/**
 * Closes the retrospective block: how many reports were shown against how
 * many matched in total, which page this is, and, when there is one, the
 * exact flag and value that reaches the next page.
 *
 * A `page` beyond the last one is reported on its own: the page count and the
 * page asked for must never contradict each other (a prior version printed
 * "page 3 of 1"), and the caller is told the exact flag and value that reaches
 * a page that does exist.
 */
function retrospectiveFooter(
  shown: number,
  totalMatched: number,
  page: number,
  filesPerPage: number,
): string {
  const totalPages = Math.max(1, Math.ceil(totalMatched / filesPerPage));
  const reportWord = (count: number): string =>
    count === 1 ? "report" : "reports";
  if (page > totalPages) {
    return `Page ${page} does not exist: only ${totalPages} ${totalPages === 1 ? "page" : "pages"} of ${totalMatched} retrospective ${reportWord(totalMatched)}. Try --retrospective-page ${totalPages}.`;
  }
  const remaining = Math.max(
    0,
    totalMatched - (page - 1) * filesPerPage - shown,
  );
  const base = `Shown ${shown} of ${totalMatched} retrospective ${reportWord(totalMatched)} (page ${page} of ${totalPages}).`;
  return remaining > 0
    ? `${base} ${remaining} more ${reportWord(remaining)}: --retrospective-page ${page + 1}.`
    : base;
}

/**
 * Prints the matching lines: memory hits (the index and every topic file)
 * first, with their own how-many-more-were-dropped line, then the
 * retrospective block, one page of reports ranked by how many lines matched,
 * most first, ties broken by the newest report first. Memory ranks first no
 * matter how few hits it has, so a handful of curated entries is never buried
 * under raw retrospective prose; the retrospective block is paged for the
 * same reason, so one dense report cannot crowd out every other report that
 * matched.
 */
function runSearch(
  io: AgentMemoryIo,
  query: string,
  limit: number,
  retrospective: RetrospectivePaging,
): number {
  const { files, dates: recordedDates } = searchableFiles(io);
  const memory = search(files, query, limit);
  const {
    files: retroFiles,
    dates: retroDates,
    excludedBySince,
  } = retrospectiveFiles(io, retrospective.since);
  const retroReports = searchGroupedByFile(retroFiles, query, newestFirst(retroDates));

  if (memory.hits.length === 0 && retroReports.length === 0) {
    io.log(
      excludedBySince > 0
        ? `No match. --retrospective-since ${retrospective.since} excluded ${excludedBySince} retrospective ${excludedBySince === 1 ? "report" : "reports"} before ${excludedBySince === 1 ? "it was" : "they were"} read; rerun without it to check ${excludedBySince === 1 ? "it" : "them"}.`
        : "No match.",
    );
    return EXIT_OK;
  }

  for (const hit of memory.hits) {
    io.log(
      `${hit.path}:${hit.line}${dateSuffix(recordedDates, hit.path, "recorded")}\n  ${hit.snippet}`,
    );
  }
  if (memory.dropped > 0) {
    io.log(
      `${memory.dropped} more memory hits not shown; narrow the query or raise --limit.`,
    );
  }

  if (retroReports.length > 0) {
    const offset = (retrospective.page - 1) * retrospective.filesPerPage;
    const page = retroReports.slice(
      offset,
      offset + retrospective.filesPerPage,
    );

    for (const report of page) {
      const shown = report.hits.slice(0, retrospective.linesPerReport);
      for (const hit of shown) {
        io.log(
          `${hit.path}:${hit.line}${dateSuffix(retroDates, hit.path, "retrospective")}\n  ${hit.snippet}`,
        );
      }
      const extra = report.hits.length - shown.length;
      if (extra > 0) {
        io.log(`  ${extra} more hit${extra === 1 ? "" : "s"} in this report.`);
      }
    }

    io.log(
      retrospectiveFooter(
        page.length,
        retroReports.length,
        retrospective.page,
        retrospective.filesPerPage,
      ),
    );
  }

  return EXIT_OK;
}

/** Prints one topic file, or the topics that do exist. */
function runRead(io: AgentMemoryIo, topic: string): number {
  const text = io.readTopic(topic);
  if (text === undefined) {
    io.log(formatUnknownTopic(topic, io.listTopics()));
    return EXIT_USAGE;
  }
  io.log(text.trimEnd());
  return EXIT_OK;
}

/**
 * Writes the topic file and its index entry.
 *
 * Both size checks run before either file is touched, so a rejected write
 * leaves the memory exactly as it was rather than half applied.
 */
function runWrite(io: AgentMemoryIo, command: WriteCommand): number {
  const { topic, summary, content } = command;
  const badSummary = summaryProblem(summary);
  if (badSummary !== undefined) {
    io.log(badSummary);
    return EXIT_USAGE;
  }

  const current = parseIndex(io.readIndex() ?? INDEX_HEADER);
  const next = renderIndex(withEntry(current, { topic, summary }));
  const tooLarge = indexTooLargeProblem(next);
  if (tooLarge !== undefined) {
    io.log(tooLarge);
    return EXIT_USAGE;
  }

  io.writeTopic(topic, renderTopicFile(topic, content, io.today()));
  io.writeIndex(next);
  io.log(`Wrote ${topicPath(topic)} and updated ${INDEX_PATH}.`);
  return EXIT_OK;
}

/** Deletes a topic file and drops its index entry. */
function runRemove(io: AgentMemoryIo, topic: string): number {
  if (io.readTopic(topic) === undefined) {
    io.log(formatUnknownTopic(topic, io.listTopics()));
    return EXIT_USAGE;
  }
  io.deleteTopic(topic);
  const index = io.readIndex();
  if (index !== undefined) {
    io.writeIndex(renderIndex(withoutEntry(parseIndex(index), topic)));
  }
  io.log(`Removed ${topicPath(topic)} and its entry in ${INDEX_PATH}.`);
  return EXIT_OK;
}

/**
 * Prints the entry count, the index size against both caps, the last review
 * date, and whether a review is due and why. Always exits 0: this is a
 * report, not a gate.
 */
function runStatus(io: AgentMemoryIo): number {
  const text = io.readIndex() ?? "";
  const index = parseIndex(text);
  const entries = index.entries.length;
  const { lines, bytes } = indexSize(text);
  const reviewed = extractReviewedStamp(index);
  const decision = reviewDue({
    entries,
    indexLines: lines,
    indexBytes: bytes,
    reviewed,
    today: io.today(),
  });

  io.log(`Entries: ${entries}`);
  io.log(
    `Index: ${lines} lines, ${bytes} bytes (cap ${INDEX_MAX_LINES} lines, ${INDEX_MAX_BYTES} bytes)`,
  );
  io.log(
    reviewed === undefined
      ? "Last review: never"
      : `Last review: ${reviewed.date}, ${pluralizeEntries(reviewed.entries)} at the time`,
  );
  io.log(
    decision.due
      ? `Review due: yes, because ${decision.reason}`
      : "Review due: no.",
  );
  return EXIT_OK;
}

/**
 * Stamps the index with today's date and the current entry count as the last
 * review. Leaves the entries and the rest of the preamble untouched.
 */
function runReviewed(io: AgentMemoryIo): number {
  const current = parseIndex(io.readIndex() ?? INDEX_HEADER);
  const stamp = { date: io.today(), entries: current.entries.length };
  io.writeIndex(renderIndex(withReviewedStamp(current, stamp)));
  io.log(`Wrote ${renderReviewedLine(stamp)} to ${INDEX_PATH}.`);
  return EXIT_OK;
}

function dispatch(command: Command, io: AgentMemoryIo): number {
  switch (command.kind) {
    case "list":
      return runList(io);
    case "search":
      return runSearch(io, command.query, command.limit, {
        filesPerPage: command.retrospectiveFilesPerPage,
        linesPerReport: command.retrospectiveLinesPerReport,
        page: command.retrospectivePage,
        since: command.retrospectiveSince,
      });
    case "read":
      return runRead(io, command.topic);
    case "write":
      return runWrite(io, command);
    case "remove":
      return runRemove(io, command.topic);
    case "status":
      return runStatus(io);
    case "reviewed":
      return runReviewed(io);
  }
}

/**
 * Runs one command. Returns the process exit code.
 *
 * The catch is what makes exit code 2 real: an unreadable directory or a
 * read-only checkout is not a usage error and must not be reported as one.
 */
export function run(argv: readonly string[], io: AgentMemoryIo): number {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    io.log(HELP);
    return EXIT_OK;
  }
  if (parsed.kind === "error") {
    io.log(`${parsed.message}\n\nRun pnpm claude:memory --help for usage.`);
    return EXIT_USAGE;
  }

  try {
    return dispatch(parsed.command, io);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    io.log(`Unexpected failure: ${detail}`);
    return EXIT_INTERNAL;
  }
}
