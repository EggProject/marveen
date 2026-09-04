import { describe, expect, it } from "vitest";

import type { AgentMemoryIo } from "../io/io";
import { EXIT_INTERNAL, EXIT_OK, EXIT_USAGE, run } from "./run";

const INDEX = `# Shared memory index

<!-- entries below, one line each: - [<topic>](<topic>.md): summary -->

- [porta](porta.md): why delegation goes through a named workflow
`;

interface FakeIo extends AgentMemoryIo {
  /** Everything the command printed, one entry per log call. */
  readonly lines: string[];
  /** The files as they stand, keyed by topic, plus the index under MEMORY. */
  readonly files: Map<string, string>;
  /** Retrospective report files as they stand, keyed by file name. */
  readonly retrospectiveFiles: Map<string, string>;
}

interface FakeIoOptions {
  /** undefined means there is no index file yet. */
  readonly index?: string;
  readonly topics?: Record<string, string>;
  /** Keyed by report file name, e.g. "2026-01-15-abcd1234.md". */
  readonly retrospectives?: Record<string, string>;
  /** Thrown by every read, to drive the unexpected-failure path. */
  readonly failure?: Error;
  /** What `today()` reports; a fixed date so writes are deterministic. */
  readonly today?: string;
}

const FAKE_TODAY = "2026-01-15";

function fakeIo(options: FakeIoOptions = {}): FakeIo {
  const lines: string[] = [];
  const files = new Map<string, string>();
  if (options.index !== undefined) files.set("MEMORY", options.index);
  for (const [topic, text] of Object.entries(options.topics ?? {})) {
    files.set(topic, text);
  }
  const retrospectiveFiles = new Map(
    Object.entries(options.retrospectives ?? {}),
  );
  const read = (key: string): string | undefined => {
    if (options.failure) throw options.failure;
    return files.get(key);
  };

  return {
    readIndex: () => read("MEMORY"),
    writeIndex: (text) => {
      files.set("MEMORY", text);
    },
    readTopic: (topic) => read(topic),
    writeTopic: (topic, text) => {
      files.set(topic, text);
    },
    deleteTopic: (topic) => {
      files.delete(topic);
    },
    listTopics: () =>
      [...files.keys()].filter((key) => key !== "MEMORY").sort(),
    listRetrospectives: () => [...retrospectiveFiles.keys()].sort(),
    readRetrospective: (fileName) => {
      if (options.failure) throw options.failure;
      return retrospectiveFiles.get(fileName);
    },
    today: () => options.today ?? FAKE_TODAY,
    log: (line) => lines.push(line),
    lines,
    files,
    retrospectiveFiles,
  };
}

describe("run", () => {
  it("prints the help and succeeds", () => {
    const io = fakeIo();

    expect(run(["--help"], io)).toBe(EXIT_OK);
    expect(io.lines.join("\n")).toContain("Usage:");
  });

  it("points at the help after a usage error", () => {
    const io = fakeIo();

    expect(run(["forget"], io)).toBe(EXIT_USAGE);
    expect(io.lines.join("\n")).toContain("Unknown command: forget");
    expect(io.lines.join("\n")).toContain("--help for usage");
  });

  it("reports an unexpected failure separately from a usage error", () => {
    const io = fakeIo({ failure: new Error("EACCES: permission denied") });

    expect(run(["list"], io)).toBe(EXIT_INTERNAL);
    expect(io.lines.join("\n")).toBe(
      "Unexpected failure: EACCES: permission denied",
    );
  });

  it("reports a thrown non-error too", () => {
    const io = fakeIo();
    const throwing: AgentMemoryIo = {
      ...io,
      readIndex: () => {
        throw "disk gone";
      },
    };

    expect(run(["list"], throwing)).toBe(EXIT_INTERNAL);
    expect(io.lines.join("\n")).toContain("Unexpected failure: disk gone");
  });
});

describe("list", () => {
  it("prints the index verbatim", () => {
    const io = fakeIo({ index: INDEX });

    expect(run(["list"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([INDEX.trimEnd()]);
  });

  it("says so when there is no index yet, and still succeeds", () => {
    const io = fakeIo();

    expect(run(["list"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      "No shared memory yet: .claude/shared-memory/MEMORY.md does not exist.",
    ]);
  });
});

describe("search", () => {
  it("prints path, line, the recorded date and the matching line, index included", () => {
    const io = fakeIo({
      index: INDEX,
      topics: {
        porta: "# porta\nRecorded: 2026-01-15\n\nporta is a workflow\n",
      },
    });

    expect(run(["search", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/shared-memory/porta.md:1 (recorded 2026-01-15)\n  # porta",
      ".claude/shared-memory/porta.md:4 (recorded 2026-01-15)\n  porta is a workflow",
      ".claude/shared-memory/MEMORY.md:5\n  - [porta](porta.md): why delegation goes through a named workflow",
    ]);
  });

  it("marks the recorded date unknown for a topic file with no Recorded line", () => {
    const io = fakeIo({ topics: { porta: "# porta\nporta is a workflow\n" } });

    expect(run(["search", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/shared-memory/porta.md:1 (recorded, date unknown)\n  # porta",
      ".claude/shared-memory/porta.md:2 (recorded, date unknown)\n  porta is a workflow",
    ]);
  });

  it("names how many memory hits it dropped at the limit", () => {
    const io = fakeIo({ index: INDEX, topics: { porta: "porta\nporta\n" } });

    expect(run(["search", "porta", "--limit", "1"], io)).toBe(EXIT_OK);
    expect(io.lines.at(-1)).toBe(
      "2 more memory hits not shown; narrow the query or raise --limit.",
    );
  });

  it("searches the topics even with no index file", () => {
    const io = fakeIo({ topics: { porta: "# porta\n" } });

    expect(run(["search", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/shared-memory/porta.md:1 (recorded, date unknown)\n  # porta",
    ]);
  });

  it("skips a topic file that vanished between listing and reading", () => {
    const io = fakeIo({ topics: { porta: "# porta\n" } });
    const racing: AgentMemoryIo = { ...io, readTopic: () => undefined };

    expect(run(["search", "porta"], racing)).toBe(EXIT_OK);
    expect(io.lines).toEqual(["No match."]);
  });

  it("succeeds with a note when nothing matched", () => {
    const io = fakeIo({ index: INDEX });

    expect(run(["search", "absent"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual(["No match."]);
  });

  it("prints memory hits before the retrospective block, dated from the file name", () => {
    const io = fakeIo({
      topics: { porta: "# porta\nporta is a workflow\n" },
      retrospectives: {
        "2026-01-10-abcd1234.md": "porta came up in this session\n",
      },
    });

    expect(run(["search", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/shared-memory/porta.md:1 (recorded, date unknown)\n  # porta",
      ".claude/shared-memory/porta.md:2 (recorded, date unknown)\n  porta is a workflow",
      ".claude/retrospectives/2026-01-10-abcd1234.md:1 (retrospective 2026-01-10)\n  porta came up in this session",
      "Shown 1 of 1 retrospective report (page 1 of 1).",
    ]);
  });

  it("still labels a retrospective hit when memory has none", () => {
    const io = fakeIo({
      retrospectives: { "2026-01-10-abcd1234.md": "porta\n" },
    });

    expect(run(["search", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/retrospectives/2026-01-10-abcd1234.md:1 (retrospective 2026-01-10)\n  porta",
      "Shown 1 of 1 retrospective report (page 1 of 1).",
    ]);
  });

  it("marks the retrospective date unknown for a file name with no date prefix", () => {
    const io = fakeIo({ retrospectives: { "notes.md": "porta\n" } });

    expect(run(["search", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/retrospectives/notes.md:1 (retrospective, date unknown)\n  porta",
      "Shown 1 of 1 retrospective report (page 1 of 1).",
    ]);
  });

  it("ranks retrospective reports by hit count, most matching lines first", () => {
    const io = fakeIo({
      retrospectives: {
        "2026-01-01-aaaaaaaa.md": "porta\nporta\n",
        "2026-01-02-bbbbbbbb.md": "porta\n",
      },
    });

    expect(run(["search", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/retrospectives/2026-01-01-aaaaaaaa.md:1 (retrospective 2026-01-01)\n  porta",
      ".claude/retrospectives/2026-01-01-aaaaaaaa.md:2 (retrospective 2026-01-01)\n  porta",
      ".claude/retrospectives/2026-01-02-bbbbbbbb.md:1 (retrospective 2026-01-02)\n  porta",
      "Shown 2 of 2 retrospective reports (page 1 of 1).",
    ]);
  });

  it("breaks a tied hit count by the newest report first", () => {
    const io = fakeIo({
      retrospectives: {
        "2026-01-01-aaaaaaaa.md": "porta\n",
        "2026-02-01-bbbbbbbb.md": "porta\n",
      },
    });

    expect(run(["search", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/retrospectives/2026-02-01-bbbbbbbb.md:1 (retrospective 2026-02-01)\n  porta",
      ".claude/retrospectives/2026-01-01-aaaaaaaa.md:1 (retrospective 2026-01-01)\n  porta",
      "Shown 2 of 2 retrospective reports (page 1 of 1).",
    ]);
  });

  it("caps snippet lines per report at --retrospective-lines, and names how many more are in that report", () => {
    const io = fakeIo({
      retrospectives: { "2026-01-01-aaaaaaaa.md": "porta\nporta\nporta\n" },
    });

    expect(run(["search", "porta", "--retrospective-lines", "2"], io)).toBe(
      EXIT_OK,
    );
    expect(io.lines).toEqual([
      ".claude/retrospectives/2026-01-01-aaaaaaaa.md:1 (retrospective 2026-01-01)\n  porta",
      ".claude/retrospectives/2026-01-01-aaaaaaaa.md:2 (retrospective 2026-01-01)\n  porta",
      "  1 more hit in this report.",
      "Shown 1 of 1 retrospective report (page 1 of 1).",
    ]);
  });

  it("pages the ranked reports at --retrospective-files, and says how to reach the next page", () => {
    const io = fakeIo({
      retrospectives: Object.fromEntries(
        ["a", "b", "c"].map((id) => [`2026-01-01-${id}.md`, "porta\n"]),
      ),
    });

    expect(run(["search", "porta", "--retrospective-files", "2"], io)).toBe(
      EXIT_OK,
    );
    expect(io.lines.at(-1)).toBe(
      "Shown 2 of 3 retrospective reports (page 1 of 2). 1 more report: --retrospective-page 2.",
    );
  });

  it("reaches the second page with --retrospective-page", () => {
    const io = fakeIo({
      retrospectives: Object.fromEntries(
        ["a", "b", "c"].map((id) => [`2026-01-01-${id}.md`, "porta\n"]),
      ),
    });

    expect(
      run(
        [
          "search",
          "porta",
          "--retrospective-files",
          "2",
          "--retrospective-page",
          "2",
        ],
        io,
      ),
    ).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/retrospectives/2026-01-01-a.md:1 (retrospective 2026-01-01)\n  porta",
      "Shown 1 of 3 retrospective reports (page 2 of 2).",
    ]);
  });

  it("filters retrospective reports by --retrospective-since, never dropping an undated one", () => {
    const io = fakeIo({
      retrospectives: {
        "2026-01-01-aaaaaaaa.md": "porta\n",
        "2026-06-01-bbbbbbbb.md": "porta\n",
        "notes.md": "porta\n",
      },
    });

    expect(
      run(["search", "porta", "--retrospective-since", "2026-06-01"], io),
    ).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/retrospectives/2026-06-01-bbbbbbbb.md:1 (retrospective 2026-06-01)\n  porta",
      ".claude/retrospectives/notes.md:1 (retrospective, date unknown)\n  porta",
      "Shown 2 of 2 retrospective reports (page 1 of 1).",
    ]);
  });

  it("finds nothing in an absent or empty retrospectives directory, and still returns memory hits", () => {
    const io = fakeIo({ topics: { porta: "porta\n" } });

    expect(run(["search", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      ".claude/shared-memory/porta.md:1 (recorded, date unknown)\n  porta",
    ]);
  });

  it("skips a retrospective file that vanished between listing and reading", () => {
    const io = fakeIo({
      retrospectives: { "2026-01-10-abcd1234.md": "porta\n" },
    });
    const racing: AgentMemoryIo = { ...io, readRetrospective: () => undefined };

    expect(run(["search", "porta"], racing)).toBe(EXIT_OK);
    expect(io.lines).toEqual(["No match."]);
  });

  it("rejects a malformed --retrospective-since the same way it rejects a malformed count", () => {
    const io = fakeIo();

    expect(
      run(["search", "porta", "--retrospective-since", "not-a-date"], io),
    ).toBe(EXIT_USAGE);
    expect(io.lines.join("\n")).toContain(
      "--retrospective-since needs a YYYY-MM-DD date",
    );
  });

  it("reports an out-of-range page rather than contradicting the page count", () => {
    const io = fakeIo({
      retrospectives: {
        "2026-01-01-aaaaaaaa.md": "porta\n",
        "2026-01-02-bbbbbbbb.md": "porta\n",
      },
    });

    expect(run(["search", "porta", "--retrospective-page", "3"], io)).toBe(
      EXIT_OK,
    );
    expect(io.lines.at(-1)).toBe(
      "Page 3 does not exist: only 1 page of 2 retrospective reports. Try --retrospective-page 1.",
    );
  });

  it("names how many pages exist when there is more than one", () => {
    const io = fakeIo({
      retrospectives: Object.fromEntries(
        ["a", "b", "c", "d", "e", "f", "g"].map((id) => [
          `2026-01-01-${id}.md`,
          "porta\n",
        ]),
      ),
    });

    expect(
      run(
        [
          "search",
          "porta",
          "--retrospective-files",
          "3",
          "--retrospective-page",
          "5",
        ],
        io,
      ),
    ).toBe(EXIT_OK);
    expect(io.lines.at(-1)).toBe(
      "Page 5 does not exist: only 3 pages of 7 retrospective reports. Try --retrospective-page 3.",
    );
  });

  it("distinguishes a date-filtered empty result from a genuinely empty search, naming the flag", () => {
    const io = fakeIo({
      retrospectives: { "2026-01-01-aaaaaaaa.md": "porta\n" },
    });

    expect(
      run(["search", "porta", "--retrospective-since", "2026-06-01"], io),
    ).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      "No match. --retrospective-since 2026-06-01 excluded 1 retrospective report before it was read; rerun without it to check it.",
    ]);
  });

  it("pluralizes the date-filtered-empty message for more than one excluded report", () => {
    const io = fakeIo({
      retrospectives: {
        "2026-01-01-aaaaaaaa.md": "porta\n",
        "2026-01-02-bbbbbbbb.md": "porta\n",
      },
    });

    expect(
      run(["search", "porta", "--retrospective-since", "2026-06-01"], io),
    ).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      "No match. --retrospective-since 2026-06-01 excluded 2 retrospective reports before they were read; rerun without it to check them.",
    ]);
  });

  it("still reports a plain no-match when the filter excluded nothing", () => {
    const io = fakeIo({
      retrospectives: { "2026-06-01-bbbbbbbb.md": "no hit here\n" },
    });

    expect(
      run(["search", "porta", "--retrospective-since", "2026-06-01"], io),
    ).toBe(EXIT_OK);
    expect(io.lines).toEqual(["No match."]);
  });

  it("skips reading a report the --retrospective-since filter excludes by name alone", () => {
    const io = fakeIo({
      retrospectives: {
        "2026-01-01-aaaaaaaa.md": "porta\n",
        "2026-06-01-bbbbbbbb.md": "porta\n",
      },
    });
    const reads: string[] = [];
    const tracked: AgentMemoryIo = {
      ...io,
      readRetrospective: (fileName) => {
        reads.push(fileName);
        return io.readRetrospective(fileName);
      },
    };

    expect(
      run(["search", "porta", "--retrospective-since", "2026-06-01"], tracked),
    ).toBe(EXIT_OK);
    expect(reads).toEqual(["2026-06-01-bbbbbbbb.md"]);
  });
});

describe("read", () => {
  it("prints the topic file", () => {
    const io = fakeIo({ topics: { porta: "# porta\n\nBody.\n" } });

    expect(run(["read", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual(["# porta\n\nBody."]);
  });

  it("prints the recorded date line when the topic file carries one", () => {
    const io = fakeIo({
      topics: { porta: "# porta\nRecorded: 2026-01-15\n\nBody.\n" },
    });

    expect(run(["read", "porta"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual(["# porta\nRecorded: 2026-01-15\n\nBody."]);
  });

  it("lists the known topics for a topic that does not exist", () => {
    const io = fakeIo({ index: INDEX, topics: { porta: "# porta\n" } });

    expect(run(["read", "prota"], io)).toBe(EXIT_USAGE);
    expect(io.lines).toEqual(["No such topic: prota.\nKnown topics:\n  porta"]);
  });
});

describe("write", () => {
  it("writes the topic file and inserts a sorted index entry", () => {
    const io = fakeIo({ index: INDEX });

    expect(
      run(
        ["write", "actions", "--summary", "GET reads", "--content", "Body."],
        io,
      ),
    ).toBe(EXIT_OK);
    expect(io.files.get("actions")).toBe(
      `# actions\nRecorded: ${FAKE_TODAY}\n\nBody.\n`,
    );
    expect(io.files.get("MEMORY")).toBe(
      `# Shared memory index

<!-- entries below, one line each: - [<topic>](<topic>.md): summary -->

- [actions](actions.md): GET reads
- [porta](porta.md): why delegation goes through a named workflow
`,
    );
    expect(io.lines).toEqual([
      "Wrote .claude/shared-memory/actions.md and updated .claude/shared-memory/MEMORY.md.",
    ]);
  });

  it("replaces the entry a topic already had, stamping the new recorded date", () => {
    const io = fakeIo({
      index: INDEX,
      topics: { porta: "# porta\nold\n" },
      today: "2026-02-01",
    });

    expect(
      run(["write", "porta", "--summary", "rewritten", "--content", "new"], io),
    ).toBe(EXIT_OK);
    expect(io.files.get("porta")).toBe(
      "# porta\nRecorded: 2026-02-01\n\nnew\n",
    );
    expect(io.files.get("MEMORY")).toContain("- [porta](porta.md): rewritten");
    expect(io.files.get("MEMORY")).not.toContain("why delegation");
  });

  it("starts an index from scratch when there is none", () => {
    const io = fakeIo();

    expect(
      run(["write", "porta", "--summary", "why", "--content", "Body."], io),
    ).toBe(EXIT_OK);
    expect(io.files.get("MEMORY")).toContain("# Shared memory index");
    expect(io.files.get("MEMORY")).toContain("- [porta](porta.md): why");
  });

  it("rejects a summary over the limit and writes nothing", () => {
    const io = fakeIo({ index: INDEX });

    expect(
      run(
        ["write", "porta", "--summary", "s".repeat(121), "--content", "Body."],
        io,
      ),
    ).toBe(EXIT_USAGE);
    expect(io.lines.join("\n")).toContain("at most 120 characters");
    expect(io.files.has("porta")).toBe(false);
    expect(io.files.get("MEMORY")).toBe(INDEX);
  });

  it("refuses to write an index the hook would truncate", () => {
    const io = fakeIo({
      index: `${Array.from({ length: 200 }, () => "x").join("\n")}\n`,
    });

    expect(
      run(["write", "porta", "--summary", "why", "--content", "Body."], io),
    ).toBe(EXIT_USAGE);
    expect(io.lines.join("\n")).toContain("over the 200 line cap");
    expect(io.files.has("porta")).toBe(false);
  });
});

describe("remove", () => {
  it("deletes the topic file and its index entry", () => {
    const io = fakeIo({ index: INDEX, topics: { porta: "# porta\n" } });

    expect(run(["remove", "porta"], io)).toBe(EXIT_OK);
    expect(io.files.has("porta")).toBe(false);
    expect(io.files.get("MEMORY")).toBe(
      `# Shared memory index

<!-- entries below, one line each: - [<topic>](<topic>.md): summary -->
`,
    );
    expect(io.lines).toEqual([
      "Removed .claude/shared-memory/porta.md and its entry in .claude/shared-memory/MEMORY.md.",
    ]);
  });

  it("deletes a topic file that has no index at all", () => {
    const io = fakeIo({ topics: { porta: "# porta\n" } });

    expect(run(["remove", "porta"], io)).toBe(EXIT_OK);
    expect(io.files.has("porta")).toBe(false);
  });

  it("lists the known topics for a topic that does not exist", () => {
    const io = fakeIo({ index: INDEX });

    expect(run(["remove", "porta"], io)).toBe(EXIT_USAGE);
    expect(io.lines).toEqual([
      "No such topic: porta.\nKnown topics:\n  (none yet)",
    ]);
  });
});

describe("status", () => {
  it("reports zero entries and no review when there is no index yet", () => {
    const io = fakeIo();

    expect(run(["status"], io)).toBe(EXIT_OK);
    expect(io.lines).toEqual([
      "Entries: 0",
      "Index: 0 lines, 0 bytes (cap 200 lines, 25600 bytes)",
      "Last review: never",
      "Review due: no.",
    ]);
  });

  it("reports the entry count and that no review has ever run", () => {
    const io = fakeIo({ index: INDEX });

    expect(run(["status"], io)).toBe(EXIT_OK);
    expect(io.lines[0]).toBe("Entries: 1");
    expect(io.lines[2]).toBe("Last review: never");
    expect(io.lines[3]).toBe("Review due: no.");
  });

  it("reports the last review date and entry count from the Reviewed stamp", () => {
    const reviewedIndex = `# Shared memory index
Reviewed: 2026-01-01 (1 entries)

<!-- entries below, one line each: - [<topic>](<topic>.md): summary -->

- [porta](porta.md): why delegation goes through a named workflow
`;
    const io = fakeIo({ index: reviewedIndex, today: "2026-01-15" });

    expect(run(["status"], io)).toBe(EXIT_OK);
    expect(io.lines[2]).toBe("Last review: 2026-01-01, 1 entry at the time");
    expect(io.lines[3]).toBe("Review due: no.");
  });

  it("reports a due review with the ladder's reason", () => {
    const topics = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
    const reviewedIndex = `# Shared memory index
Reviewed: 2026-01-01 (1 entries)

<!-- entries below, one line each: - [<topic>](<topic>.md): summary -->

${topics.map((topic) => `- [${topic}](${topic}.md): entry`).join("\n")}
`;
    const io = fakeIo({ index: reviewedIndex, today: "2026-01-15" });

    expect(run(["status"], io)).toBe(EXIT_OK);
    expect(io.lines[0]).toBe("Entries: 11");
    expect(io.lines[3]).toBe(
      "Review due: yes, because 10 or more entries have been added since the last review.",
    );
  });
});

describe("reviewed", () => {
  it("stamps the index with today's date and the current entry count", () => {
    const io = fakeIo({ index: INDEX, today: "2026-02-01" });

    expect(run(["reviewed"], io)).toBe(EXIT_OK);
    expect(io.files.get("MEMORY")).toBe(
      `# Shared memory index
Reviewed: 2026-02-01 (1 entry)

<!-- entries below, one line each: - [<topic>](<topic>.md): summary -->

- [porta](porta.md): why delegation goes through a named workflow
`,
    );
    expect(io.lines).toEqual([
      "Wrote Reviewed: 2026-02-01 (1 entry) to .claude/shared-memory/MEMORY.md.",
    ]);
  });

  it("replaces an existing stamp without disturbing the entries", () => {
    const reviewedIndex = `# Shared memory index
Reviewed: 2026-01-01 (1 entries)

<!-- entries below, one line each: - [<topic>](<topic>.md): summary -->

- [porta](porta.md): why delegation goes through a named workflow
`;
    const io = fakeIo({ index: reviewedIndex, today: "2026-03-01" });

    expect(run(["reviewed"], io)).toBe(EXIT_OK);
    expect(io.files.get("MEMORY")).toContain("Reviewed: 2026-03-01 (1 entry)");
    expect(io.files.get("MEMORY")).not.toContain("2026-01-01");
    expect(io.files.get("MEMORY")).toContain(
      "- [porta](porta.md): why delegation goes through a named workflow",
    );
  });

  it("starts an index from scratch when there is none", () => {
    const io = fakeIo({ today: "2026-02-01" });

    expect(run(["reviewed"], io)).toBe(EXIT_OK);
    expect(io.files.get("MEMORY")).toContain(
      "Reviewed: 2026-02-01 (0 entries)",
    );
  });
});

describe("exit codes", () => {
  it("are the values the help text documents", () => {
    expect([EXIT_OK, EXIT_USAGE, EXIT_INTERNAL]).toEqual([0, 1, 2]);
  });
});

describe("the CLI shim", () => {
  it("runs end to end and prints the help", async () => {
    const { execFileSync } = await import("node:child_process");
    const url = await import("node:url");
    const nodePath = await import("node:path");
    const here = nodePath.dirname(url.fileURLToPath(import.meta.url));
    const repoRoot = nodePath.resolve(here, "..", "..", "..");

    const output = execFileSync(
      nodePath.join(repoRoot, "node_modules", ".bin", "tsx"),
      [nodePath.join(repoRoot, "scripts", "agent-memory.ts"), "--help"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(output).toContain("Usage:");
    expect(output).toContain("pnpm claude:memory");
  });
});
