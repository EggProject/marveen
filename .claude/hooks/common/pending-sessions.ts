/**
 * Scans a transcripts directory for finished sessions with work no
 * retrospective covers (used by the SessionStart hook). An existing
 * retrospective marker does not by itself disqualify a session;
 * {@link findUnprocessedSessions} states the exact conditions.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { scanTranscript, type TranscriptStats } from "./transcript.ts";

/** Options for {@link findUnprocessedSessions}. */
export interface UnprocessedSessionsOptions {
  readonly transcriptsDir: string;
  readonly retrospectivesDir: string;
  readonly currentSessionId: string;
  readonly now: number;
  readonly minToolUses: number;
  readonly idleMs: number;
  readonly maxAgeMs: number;
  readonly limit: number;
}

/** A finished session transcript with work no retrospective covers. */
export interface UnprocessedSession {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly toolUseTotal: number;
  readonly modifiedAt: number;
}

/** Suffix stripped from a transcript file name to recover its session id. */
const TRANSCRIPT_EXTENSION = ".jsonl";

/**
 * Suffix marking a retrospective marker file as a declined-offer record.
 *
 * Exported because the same suffix is spelled a second time in
 * `scripts/agent-memory/store/retrospective.ts`, where it decides that a
 * decline marker is not searchable session evidence. The two tools compile
 * and run separately and cannot share the constant itself (that direction of
 * import fails `pnpm claude:hooks:typecheck`), so the memory tool's suite
 * imports this one and asserts the two still agree: rename it here and that
 * test fails naming both files, rather than the two silently diverging.
 */
export const SKIPPED_MARKER_SUFFIX = ".skipped.md";

/** A retrospective marker file's name and modified time. */
interface MarkerFile {
  readonly name: string;
  readonly mtimeMs: number;
}

/**
 * A candidate session's retrospective-marker classification: no matching
 * marker file, an unconditional skip marker (`.skipped.md`), or an active
 * marker (a finished retrospective) with the newest mtime among its
 * matching marker files.
 */
type MarkerStatus =
  | { readonly kind: "none" }
  | { readonly kind: "skipped" }
  | { readonly kind: "active"; readonly markerMtime: number };

/** Classifies the marker files matching one candidate session's id prefix. */
function classifyMarkers(matching: readonly MarkerFile[]): MarkerStatus {
  if (matching.length === 0) {
    return { kind: "none" };
  }
  if (matching.some((marker) => marker.name.endsWith(SKIPPED_MARKER_SUFFIX))) {
    return { kind: "skipped" };
  }
  const markerMtime = Math.max(...matching.map((marker) => marker.mtimeMs));
  return { kind: "active", markerMtime };
}

/** Reads `retrospectivesDir`'s entries with their mtimes; missing dir yields `[]`. */
async function listMarkerFiles(
  retrospectivesDir: string,
): Promise<readonly MarkerFile[]> {
  let names: readonly string[];
  try {
    names = await readdir(retrospectivesDir);
  } catch {
    return [];
  }
  const markerFiles = await Promise.all(
    names.map(async (name): Promise<MarkerFile | undefined> => {
      try {
        const { mtimeMs } = await stat(join(retrospectivesDir, name));
        return { name, mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  return markerFiles.filter(
    (marker): marker is MarkerFile => marker !== undefined,
  );
}

/**
 * Finds finished session transcripts in `transcriptsDir` with work no
 * retrospective covers: not the current session, not still possibly live
 * (modified within `idleMs` of `now`), not older than `maxAgeMs`, at least
 * `minToolUses` tool uses, and:
 * - no matching marker file in `retrospectivesDir` and no retrospective run
 *   near the end of the transcript itself, or
 * - a matching marker that is not a `.skipped.md` decline, is older than the
 *   transcript's own mtime (the session kept working after the marker was
 *   written), and has at least `minToolUses` tool uses since the last
 *   retrospective run recorded in the transcript.
 * A `.skipped.md` marker always skips the session; a non-skip marker at or
 * after the transcript's mtime also always skips it (the retrospective was
 * produced after the session's last activity). Missing directories yield an
 * empty list, never throw. Candidates are sorted newest-modified first
 * before scanning, and scanning stops once `limit` results are found.
 */
export async function findUnprocessedSessions(
  opts: UnprocessedSessionsOptions,
): Promise<readonly UnprocessedSession[]> {
  const {
    transcriptsDir,
    retrospectivesDir,
    currentSessionId,
    now,
    minToolUses,
    idleMs,
    maxAgeMs,
    limit,
  } = opts;

  let transcriptEntries: readonly string[];
  try {
    const entries = await readdir(transcriptsDir, { withFileTypes: true });
    transcriptEntries = entries
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(TRANSCRIPT_EXTENSION),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const markerFiles = await listMarkerFiles(retrospectivesDir);

  const candidates: {
    readonly sessionId: string;
    readonly transcriptPath: string;
    readonly modifiedAt: number;
    readonly markerStatus: MarkerStatus;
  }[] = [];

  for (const fileName of transcriptEntries) {
    const sessionId = fileName.slice(0, -TRANSCRIPT_EXTENSION.length);
    if (sessionId === currentSessionId) {
      continue;
    }
    const transcriptPath = join(transcriptsDir, fileName);
    let modifiedAt: number;
    try {
      modifiedAt = (await stat(transcriptPath)).mtimeMs;
    } catch {
      continue;
    }
    if (modifiedAt > now - idleMs || modifiedAt < now - maxAgeMs) {
      continue;
    }
    const idPrefix = sessionId.slice(0, 8);
    const matchingMarkers = markerFiles.filter(
      (marker) =>
        marker.name.startsWith(`${idPrefix}.`) ||
        marker.name.includes(`-${idPrefix}.`) ||
        marker.name.endsWith(`-${idPrefix}`),
    );
    const markerStatus = classifyMarkers(matchingMarkers);
    candidates.push({ sessionId, transcriptPath, modifiedAt, markerStatus });
  }

  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);

  const results: UnprocessedSession[] = [];
  for (const candidate of candidates) {
    if (results.length === limit) {
      break;
    }
    if (candidate.markerStatus.kind === "skipped") {
      continue;
    }
    let stats: TranscriptStats;
    try {
      stats = await scanTranscript(candidate.transcriptPath);
    } catch {
      continue;
    }
    if (stats.toolUseTotal < minToolUses) {
      continue;
    }
    if (candidate.markerStatus.kind === "active") {
      if (candidate.markerStatus.markerMtime >= candidate.modifiedAt) {
        continue;
      }
      if (
        stats.toolUseTotal - stats.lastRetrospectiveAtToolCount <
        minToolUses
      ) {
        continue;
      }
    } else if (
      stats.lastRetrospectiveAtToolCount > 0 &&
      stats.toolUseTotal - stats.lastRetrospectiveAtToolCount < minToolUses
    ) {
      continue;
    }
    results.push({
      sessionId: candidate.sessionId,
      transcriptPath: candidate.transcriptPath,
      toolUseTotal: stats.toolUseTotal,
      modifiedAt: candidate.modifiedAt,
    });
  }

  return results;
}
