/**
 * The only impure layer: the shared memory and retrospectives directories on
 * disk, and stdout.
 *
 * All of it is synchronous. The commands are single linear pipelines over a
 * handful of small files, so there is nothing to overlap, and staying
 * synchronous keeps the orchestration in cli/run.ts readable.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INDEX_FILE_NAME, MEMORY_DIRECTORY } from "../store/index";
import {
  isRetrospectiveReport,
  RETROSPECTIVES_DIRECTORY,
} from "../store/retrospective";
import { isTopicName } from "../store/topic";

/**
 * The repository root, derived from this file's own location: it sits at
 * scripts/agent-memory/io/, three directories below the root. Derived at
 * runtime so no machine-specific path is committed and so the tool works from
 * any working directory. `import.meta.url` rather than `import.meta.dirname`,
 * because vitest transforms this module and only guarantees the former.
 */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** Repo-relative path of one topic file, as the output prints it. */
export function topicPath(topic: string): string {
  return `${MEMORY_DIRECTORY}/${topic}.md`;
}

/** The side of the tool that touches the outside world. */
export interface AgentMemoryIo {
  /** The index file's text, or undefined when there is no index yet. */
  readonly readIndex: () => string | undefined;
  /** Replaces the index, creating the directory when it is missing. */
  readonly writeIndex: (text: string) => void;
  /** One topic file's text, or undefined when the topic has no file. */
  readonly readTopic: (topic: string) => string | undefined;
  /** Replaces a topic file, creating the directory when it is missing. */
  readonly writeTopic: (topic: string, text: string) => void;
  /** Deletes a topic file the caller has already found. */
  readonly deleteTopic: (topic: string) => void;
  /** Every topic that has a file, ascending. */
  readonly listTopics: () => readonly string[];
  /** Every searchable retrospective report's file name, ascending. */
  readonly listRetrospectives: () => readonly string[];
  /** One retrospective report's text, or undefined if it vanished mid-scan. */
  readonly readRetrospective: (fileName: string) => string | undefined;
  /** Today's date, local time, as YYYY-MM-DD. */
  readonly today: () => string;
  /** Where the command's own output goes. */
  readonly log: (line: string) => void;
}

/**
 * Today's date as a plain local YYYY-MM-DD, no timezone handling: this is a
 * last-recorded date for a human to read, not a value compared across zones.
 */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The topics a directory holds.
 *
 * Anything whose stem is not a valid topic name is skipped, which is what
 * keeps MEMORY.md and the directory's own CLAUDE.md from being listed as
 * topics or searched as memory.
 */
export function listTopics(directory: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .filter(isTopicName)
    .sort();
}

/**
 * The retrospective report file names a directory holds, ascending. A
 * missing directory, which is not an error here, yields no names: the
 * retrospectives directory may not exist yet in a fresh checkout.
 */
export function listRetrospectiveNames(directory: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return names.filter(isRetrospectiveReport).sort();
}

/** Wires the real filesystem and stdout together. */
export function createIo(repoRoot: string): AgentMemoryIo {
  const directory = path.join(repoRoot, MEMORY_DIRECTORY);
  const retrospectivesDirectory = path.join(repoRoot, RETROSPECTIVES_DIRECTORY);

  const read = (fileName: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(directory, fileName), "utf8");
    } catch {
      return undefined;
    }
  };

  const write = (fileName: string, text: string): void => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, fileName), text);
  };

  return {
    readIndex: () => read(INDEX_FILE_NAME),
    writeIndex: (text) => write(INDEX_FILE_NAME, text),
    readTopic: (topic) => read(`${topic}.md`),
    writeTopic: (topic, text) => write(`${topic}.md`, text),
    deleteTopic: (topic) => {
      fs.rmSync(path.join(directory, `${topic}.md`));
    },
    listTopics: () => listTopics(directory),
    listRetrospectives: () => listRetrospectiveNames(retrospectivesDirectory),
    readRetrospective: (fileName) => {
      try {
        return fs.readFileSync(
          path.join(retrospectivesDirectory, fileName),
          "utf8",
        );
      } catch {
        return undefined;
      }
    },
    today,
    log: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}
