/**
 * Matching and ranking over supplied file contents. Pure: the caller reads
 * the files and hands over their text.
 *
 * Substring matching rather than regex, because the caller is an agent
 * pasting a phrase it read in the index, not a user writing a pattern, and a
 * stray `(` in a phrase should find nothing rather than fail.
 */

/** One file to search, with the path the hits are reported under. */
export interface SearchFile {
  readonly path: string;
  readonly text: string;
}

/** One matching line. */
export interface SearchHit {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly snippet: string;
}

/** The hits that fit under the limit, and how many did not. */
export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly dropped: number;
}

/** Hits printed when the caller does not pass --limit. */
export const DEFAULT_LIMIT = 10;

/** Longest snippet printed, ellipsis included. */
export const SNIPPET_MAX_LENGTH = 120;

/**
 * One matching line as it is printed: whitespace collapsed so an indented
 * list item lines up with a paragraph, and cut to a length that survives a
 * narrow terminal. The ellipsis is inside the budget, so a snippet is never
 * wider than SNIPPET_MAX_LENGTH.
 */
export function toSnippet(line: string): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length <= SNIPPET_MAX_LENGTH
    ? collapsed
    : `${collapsed.slice(0, SNIPPET_MAX_LENGTH - 3)}...`;
}

/** Every line of one file that contains the needle, in line order. */
function hitsIn(file: SearchFile, needle: string): SearchHit[] {
  const hits: SearchHit[] = [];
  file.text.split("\n").forEach((line, index) => {
    if (line.toLowerCase().includes(needle)) {
      hits.push({ path: file.path, line: index + 1, snippet: toSnippet(line) });
    }
  });
  return hits;
}

/** The tie-break `search` uses: equally matching files in path order. */
function ascendingByPath(leftPath: string, rightPath: string): number {
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

/**
 * Searches every supplied file, case-insensitively.
 *
 * Files are ranked by how many of their lines matched, so the topic that is
 * mostly about the query comes first and a file that mentions it once comes
 * last. Ties fall back to the path, and hits stay in line order within a
 * file, so the same query always prints the same thing.
 *
 * The grouping and the ranking are `searchGroupedByFile`'s, so a change to
 * either is made once; this flattens the ranked groups back into one list and
 * cuts it at the limit.
 */
export function search(
  files: readonly SearchFile[],
  query: string,
  limit: number,
): SearchResult {
  const all = searchGroupedByFile(files, query, ascendingByPath).flatMap(
    (group) => group.hits,
  );
  return {
    hits: all.slice(0, limit),
    dropped: Math.max(0, all.length - limit),
  };
}

/** One file's hits, kept together rather than flattened into one list. */
export interface FileHits {
  readonly path: string;
  readonly hits: readonly SearchHit[];
}

/**
 * Searches every supplied file and groups the hits by file, the file with the
 * most matching lines first. Ties are broken by `tieBreak`, called with the
 * two tied files' paths, so this module stays corpus-agnostic: it does not
 * know whether "newest report first" or "path ascending" is the right
 * tiebreaker for a given corpus, only that the caller does.
 */
export function searchGroupedByFile(
  files: readonly SearchFile[],
  query: string,
  tieBreak: (leftPath: string, rightPath: string) => number,
): readonly FileHits[] {
  const needle = query.toLowerCase();
  return files
    .map((file) => ({ path: file.path, hits: hitsIn(file, needle) }))
    .filter((group) => group.hits.length > 0)
    .sort((left, right) =>
      left.hits.length !== right.hits.length
        ? right.hits.length - left.hits.length
        : tieBreak(left.path, right.path),
    );
}
