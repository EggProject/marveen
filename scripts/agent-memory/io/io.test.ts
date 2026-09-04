import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { MEMORY_DIRECTORY } from "../store/index";
import { RETROSPECTIVES_DIRECTORY } from "../store/retrospective";
import {
  createIo,
  listRetrospectiveNames,
  listTopics,
  REPO_ROOT,
  topicPath,
} from "./io";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A fake repository root with a shared memory directory holding `files`. */
function repositoryWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, MEMORY_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), contents);
  }
  return root;
}

/** A repository root with no shared memory directory at all. */
function emptyRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-"));
  temporaryDirectories.push(root);
  return root;
}

/** A fake repository root with a retrospectives directory holding `files`. */
function repositoryWithRetrospectives(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, RETROSPECTIVES_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), contents);
  }
  return root;
}

describe("topicPath", () => {
  it("puts a topic file beside the index", () => {
    expect(topicPath("porta")).toBe(".claude/shared-memory/porta.md");
  });
});

describe("REPO_ROOT", () => {
  it("is the checkout this file lives in", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "package.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(REPO_ROOT, "scripts", "agent-memory.ts")),
    ).toBe(true);
  });
});

describe("listTopics", () => {
  it("lists the topic files, ascending", () => {
    const root = repositoryWith({
      "vitest.md": "# vitest\n",
      "porta.md": "# porta\n",
    });

    expect(listTopics(path.join(root, MEMORY_DIRECTORY))).toEqual([
      "porta",
      "vitest",
    ]);
  });

  it("skips the index, the directory's own docs and non-markdown files", () => {
    const root = repositoryWith({
      "MEMORY.md": "# Shared memory index\n",
      "CLAUDE.md": "# Shared memory\n",
      "porta.md": "# porta\n",
      "notes.txt": "not a topic\n",
    });

    expect(listTopics(path.join(root, MEMORY_DIRECTORY))).toEqual(["porta"]);
  });

  it("finds nothing when the directory does not exist", () => {
    expect(listTopics(path.join(emptyRepository(), MEMORY_DIRECTORY))).toEqual(
      [],
    );
  });
});

describe("listRetrospectiveNames", () => {
  it("lists the report files, ascending", () => {
    const root = repositoryWithRetrospectives({
      "2026-01-10-bbbbbbbb.md": "# retro\n",
      "2026-01-05-aaaaaaaa.md": "# retro\n",
    });

    expect(
      listRetrospectiveNames(path.join(root, RETROSPECTIVES_DIRECTORY)),
    ).toEqual(["2026-01-05-aaaaaaaa.md", "2026-01-10-bbbbbbbb.md"]);
  });

  it("skips skip markers, the README and non-markdown files", () => {
    const root = repositoryWithRetrospectives({
      "2026-01-10-bbbbbbbb.md": "# retro\n",
      "2026-01-11-cccccccc.skipped.md": "Skipped by user.\n",
      "README.md": "# Retrospectives\n",
      "notes.txt": "not a report\n",
    });

    expect(
      listRetrospectiveNames(path.join(root, RETROSPECTIVES_DIRECTORY)),
    ).toEqual(["2026-01-10-bbbbbbbb.md"]);
  });

  it("finds nothing when the directory does not exist", () => {
    expect(
      listRetrospectiveNames(
        path.join(emptyRepository(), RETROSPECTIVES_DIRECTORY),
      ),
    ).toEqual([]);
  });

  it("sorts the names itself rather than trusting the directory's own order", () => {
    /**
     * `fs.readdirSync` is overloaded; typed here to the one shape this
     * module ever calls it with, so the mock's return type is `string[]`
     * rather than the `Dirent[]` TypeScript falls back to for an
     * overloaded function.
     */
    interface PlainReaddirSync {
      readonly readdirSync: (path: string) => string[];
    }
    const target: PlainReaddirSync = fs;
    const readdirSync = vi
      .spyOn(target, "readdirSync")
      .mockReturnValue(["2026-01-10-bbbbbbbb.md", "2026-01-05-aaaaaaaa.md"]);

    try {
      expect(listRetrospectiveNames("/unread")).toEqual([
        "2026-01-05-aaaaaaaa.md",
        "2026-01-10-bbbbbbbb.md",
      ]);
    } finally {
      readdirSync.mockRestore();
    }
  });
});

describe("createIo", () => {
  it("reads the index and a topic file", () => {
    const io = createIo(
      repositoryWith({ "MEMORY.md": "# index\n", "porta.md": "# porta\n" }),
    );

    expect(io.readIndex()).toBe("# index\n");
    expect(io.readTopic("porta")).toBe("# porta\n");
    expect(io.listTopics()).toEqual(["porta"]);
  });

  it("reports a missing index and a missing topic as undefined", () => {
    const io = createIo(emptyRepository());

    expect(io.readIndex()).toBeUndefined();
    expect(io.readTopic("porta")).toBeUndefined();
  });

  it("lists and reads retrospective reports, skipping skip markers", () => {
    const root = repositoryWithRetrospectives({
      "2026-01-10-bbbbbbbb.md": "# retro\nfound this\n",
      "2026-01-11-cccccccc.skipped.md": "Skipped by user.\n",
    });
    const io = createIo(root);

    expect(io.listRetrospectives()).toEqual(["2026-01-10-bbbbbbbb.md"]);
    expect(io.readRetrospective("2026-01-10-bbbbbbbb.md")).toBe(
      "# retro\nfound this\n",
    );
  });

  it("reports a missing retrospective and an absent directory as undefined and empty", () => {
    const io = createIo(emptyRepository());

    expect(io.listRetrospectives()).toEqual([]);
    expect(io.readRetrospective("2026-01-10-bbbbbbbb.md")).toBeUndefined();
  });

  it("creates the directory on the first write", () => {
    const root = emptyRepository();
    const io = createIo(root);

    io.writeIndex("# index\n");
    io.writeTopic("porta", "# porta\n");

    expect(
      fs.readFileSync(path.join(root, MEMORY_DIRECTORY, "MEMORY.md"), "utf8"),
    ).toBe("# index\n");
    expect(io.readTopic("porta")).toBe("# porta\n");
  });

  it("deletes a topic file", () => {
    const io = createIo(repositoryWith({ "porta.md": "# porta\n" }));

    io.deleteTopic("porta");

    expect(io.readTopic("porta")).toBeUndefined();
    expect(io.listTopics()).toEqual([]);
  });

  it("reports today as a zero-padded local YYYY-MM-DD", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5));

    try {
      expect(createIo(emptyRepository()).today()).toBe("2026-01-05");
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes its output to stdout", () => {
    const written: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown): boolean => {
        written.push(String(chunk));
        return true;
      });

    try {
      createIo(emptyRepository()).log("listed");
    } finally {
      write.mockRestore();
    }

    expect(written).toEqual(["listed\n"]);
  });
});
