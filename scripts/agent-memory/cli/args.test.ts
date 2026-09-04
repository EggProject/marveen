import { describe, expect, it } from "vitest";

import { DEFAULT_LIMIT } from "../search/search";
import {
  RETROSPECTIVE_FILES_DEFAULT,
  RETROSPECTIVE_LINES_DEFAULT,
} from "../store/retrospective";
import { applyCountFlag, HELP, parseArgs } from "./args";

const BASE_COUNTS = {
  limit: DEFAULT_LIMIT,
  retrospectiveFilesPerPage: RETROSPECTIVE_FILES_DEFAULT,
  retrospectiveLinesPerReport: RETROSPECTIVE_LINES_DEFAULT,
  retrospectivePage: 1,
};

describe("applyCountFlag", () => {
  it.each([
    ["--limit", "limit"],
    ["--retrospective-files", "retrospectiveFilesPerPage"],
    ["--retrospective-lines", "retrospectiveLinesPerReport"],
    ["--retrospective-page", "retrospectivePage"],
  ] as const)("gives %s its own branch, updating only %s", (flag, field) => {
    const updated = applyCountFlag(flag, 7, BASE_COUNTS);

    expect(updated[field]).toBe(7);
    for (const other of Object.keys(BASE_COUNTS) as (keyof typeof BASE_COUNTS)[]) {
      if (other !== field) expect(updated[other]).toBe(BASE_COUNTS[other]);
    }
  });

  it("fails loudly instead of assigning when the flag has no branch", () => {
    expect(() => applyCountFlag("--unheard-of", 7, BASE_COUNTS)).toThrow(
      "Unhandled count flag: --unheard-of",
    );
  });
});

describe("parseArgs", () => {
  it.each([[[]], [["-h"]], [["--help"]]])(
    "treats %j as a help request",
    (argv) => {
      expect(parseArgs(argv)).toEqual({ kind: "help" });
    },
  );

  it("rejects a command it does not know", () => {
    expect(parseArgs(["forget"])).toEqual({
      kind: "error",
      message: "Unknown command: forget",
    });
  });

  it("reads list", () => {
    expect(parseArgs(["list"])).toEqual({
      kind: "command",
      command: { kind: "list" },
    });
  });

  it("rejects arguments to list", () => {
    expect(parseArgs(["list", "porta"])).toEqual({
      kind: "error",
      message: "list takes no arguments; unexpected: porta",
    });
  });
});

describe("search arguments", () => {
  it("defaults limit, retrospective paging and since to the literal values the owner chose", () => {
    expect(parseArgs(["search", "porta workflow"])).toEqual({
      kind: "command",
      command: {
        kind: "search",
        query: "porta workflow",
        limit: 10,
        retrospectiveFilesPerPage: 5,
        retrospectiveLinesPerReport: 2,
        retrospectivePage: 1,
        retrospectiveSince: undefined,
      },
    });
    expect(DEFAULT_LIMIT).toBe(10);
    expect(RETROSPECTIVE_FILES_DEFAULT).toBe(5);
    expect(RETROSPECTIVE_LINES_DEFAULT).toBe(2);
  });

  it.each([["--limit", "3"], ["--limit=3"]])("reads %s", (...flag) => {
    expect(parseArgs(["search", "porta", ...flag])).toEqual({
      kind: "command",
      command: {
        kind: "search",
        query: "porta",
        limit: 3,
        retrospectiveFilesPerPage: RETROSPECTIVE_FILES_DEFAULT,
        retrospectiveLinesPerReport: RETROSPECTIVE_LINES_DEFAULT,
        retrospectivePage: 1,
        retrospectiveSince: undefined,
      },
    });
  });

  it.each([["--retrospective-files", "3"], ["--retrospective-files=3"]])(
    "reads %s",
    (...flag) => {
      expect(parseArgs(["search", "porta", ...flag])).toEqual({
        kind: "command",
        command: {
          kind: "search",
          query: "porta",
          limit: DEFAULT_LIMIT,
          retrospectiveFilesPerPage: 3,
          retrospectiveLinesPerReport: RETROSPECTIVE_LINES_DEFAULT,
          retrospectivePage: 1,
          retrospectiveSince: undefined,
        },
      });
    },
  );

  it.each([["--retrospective-lines", "4"], ["--retrospective-lines=4"]])(
    "reads %s",
    (...flag) => {
      expect(parseArgs(["search", "porta", ...flag])).toEqual({
        kind: "command",
        command: {
          kind: "search",
          query: "porta",
          limit: DEFAULT_LIMIT,
          retrospectiveFilesPerPage: RETROSPECTIVE_FILES_DEFAULT,
          retrospectiveLinesPerReport: 4,
          retrospectivePage: 1,
          retrospectiveSince: undefined,
        },
      });
    },
  );

  it.each([["--retrospective-page", "2"], ["--retrospective-page=2"]])(
    "reads %s",
    (...flag) => {
      expect(parseArgs(["search", "porta", ...flag])).toEqual({
        kind: "command",
        command: {
          kind: "search",
          query: "porta",
          limit: DEFAULT_LIMIT,
          retrospectiveFilesPerPage: RETROSPECTIVE_FILES_DEFAULT,
          retrospectiveLinesPerReport: RETROSPECTIVE_LINES_DEFAULT,
          retrospectivePage: 2,
          retrospectiveSince: undefined,
        },
      });
    },
  );

  it.each([
    ["--retrospective-since", "2026-06-01"],
    ["--retrospective-since=2026-06-01"],
  ])("reads %s", (...flag) => {
    expect(parseArgs(["search", "porta", ...flag])).toEqual({
      kind: "command",
      command: {
        kind: "search",
        query: "porta",
        limit: DEFAULT_LIMIT,
        retrospectiveFilesPerPage: RETROSPECTIVE_FILES_DEFAULT,
        retrospectiveLinesPerReport: RETROSPECTIVE_LINES_DEFAULT,
        retrospectivePage: 1,
        retrospectiveSince: "2026-06-01",
      },
    });
  });

  it.each([
    ["0", "--limit needs a positive integer, got: 0"],
    ["1.5", "--limit needs a positive integer, got: 1.5"],
    ["many", "--limit needs a positive integer, got: many"],
  ])("rejects --limit %s", (value, message) => {
    expect(parseArgs(["search", "porta", "--limit", value])).toEqual({
      kind: "error",
      message,
    });
  });

  it("rejects --limit with no value", () => {
    expect(parseArgs(["search", "porta", "--limit"])).toEqual({
      kind: "error",
      message: "--limit needs a positive integer, got: nothing",
    });
  });

  it("rejects --limit followed by another flag instead of swallowing it as the value", () => {
    expect(parseArgs(["search", "porta", "--limit", "--regex"])).toEqual({
      kind: "error",
      message: "--limit needs a positive integer, got: nothing",
    });
  });

  it.each([
    [
      "--retrospective-files",
      "0",
      "--retrospective-files needs a positive integer, got: 0",
    ],
    [
      "--retrospective-lines",
      "1.5",
      "--retrospective-lines needs a positive integer, got: 1.5",
    ],
    [
      "--retrospective-page",
      "many",
      "--retrospective-page needs a positive integer, got: many",
    ],
  ])("rejects %s %s", (flag, value, message) => {
    expect(parseArgs(["search", "porta", flag, value])).toEqual({
      kind: "error",
      message,
    });
  });

  it("rejects a retrospective count flag with no value", () => {
    expect(parseArgs(["search", "porta", "--retrospective-files"])).toEqual({
      kind: "error",
      message: "--retrospective-files needs a positive integer, got: nothing",
    });
  });

  it.each([
    [
      "2026-6-1",
      "--retrospective-since needs a YYYY-MM-DD date, got: 2026-6-1",
    ],
    [
      "not-a-date",
      "--retrospective-since needs a YYYY-MM-DD date, got: not-a-date",
    ],
  ])("rejects a malformed --retrospective-since %s", (value, message) => {
    expect(
      parseArgs(["search", "porta", "--retrospective-since", value]),
    ).toEqual({ kind: "error", message });
  });

  it("rejects --retrospective-since with no value, the same exit code path as a malformed count", () => {
    const withoutValue = parseArgs([
      "search",
      "porta",
      "--retrospective-since",
    ]);
    const withBadCount = parseArgs(["search", "porta", "--limit", "many"]);

    expect(withoutValue).toEqual({
      kind: "error",
      message: "--retrospective-since needs a YYYY-MM-DD date, got: nothing",
    });
    expect(withoutValue.kind).toBe(withBadCount.kind);
  });

  it("rejects an option it does not know", () => {
    expect(parseArgs(["search", "porta", "--regex"])).toEqual({
      kind: "error",
      message: "Unknown option for search: --regex",
    });
  });

  it("rejects a second unquoted word", () => {
    expect(parseArgs(["search", "porta", "workflow"])).toEqual({
      kind: "error",
      message: "search takes one query; quote it if it has spaces.",
    });
  });

  it.each([[[]], [[""]]])("rejects a missing query (%j)", (rest) => {
    expect(parseArgs(["search", ...rest])).toEqual({
      kind: "error",
      message: 'search needs a query, for example: search "porta workflow".',
    });
  });
});

describe("read and remove arguments", () => {
  it.each(["read", "remove"])("reads %s with a topic", (command) => {
    expect(parseArgs([command, "porta"])).toEqual({
      kind: "command",
      command: { kind: command, topic: "porta" },
    });
  });

  it("rejects a missing topic", () => {
    expect(parseArgs(["read"])).toEqual({
      kind: "error",
      message: "read needs a topic name.",
    });
  });

  it("rejects a second topic", () => {
    expect(parseArgs(["remove", "porta", "vitest"])).toEqual({
      kind: "error",
      message: "remove takes one topic; unexpected: vitest",
    });
  });

  it("rejects a topic name that is not a safe path segment", () => {
    const parsed = parseArgs(["read", "../../etc/passwd"]);

    expect(parsed.kind).toBe("error");
    expect(parsed).toMatchObject({
      message: expect.stringContaining(
        'Rejected topic name "../../etc/passwd"',
      ),
    });
  });
});

describe("write arguments", () => {
  it("reads the topic, the summary and the content", () => {
    expect(
      parseArgs(["write", "porta", "--summary", "one line", "--content=Body."]),
    ).toEqual({
      kind: "command",
      command: {
        kind: "write",
        topic: "porta",
        summary: "one line",
        content: "Body.",
      },
    });
  });

  it.each(["--summary", "--content"])("rejects %s with no value", (flag) => {
    expect(parseArgs(["write", "porta", flag])).toEqual({
      kind: "error",
      message: `Missing value for ${flag}.`,
    });
  });

  it.each(["--summary", "--content"])(
    "rejects %s followed by another flag instead of swallowing it as the value",
    (flag) => {
      expect(parseArgs(["write", "porta", flag, "--other"])).toEqual({
        kind: "error",
        message: `Missing value for ${flag}.`,
      });
    },
  );

  it("rejects an option it does not know", () => {
    expect(parseArgs(["write", "porta", "--append"])).toEqual({
      kind: "error",
      message: "Unknown option for write: --append",
    });
  });

  it("rejects a second topic", () => {
    expect(parseArgs(["write", "porta", "vitest"])).toEqual({
      kind: "error",
      message: "write takes one topic.",
    });
  });

  it("rejects a missing topic", () => {
    expect(parseArgs(["write", "--summary", "one line"])).toEqual({
      kind: "error",
      message: "write needs a topic name.",
    });
  });

  it("rejects an unsafe topic name", () => {
    expect(parseArgs(["write", "Porta"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining('Rejected topic name "Porta"'),
    });
  });

  it("rejects a missing summary", () => {
    expect(parseArgs(["write", "porta", "--content", "Body."])).toEqual({
      kind: "error",
      message: 'write needs --summary "<one line>".',
    });
  });

  it("rejects a missing content", () => {
    expect(parseArgs(["write", "porta", "--summary", "one line"])).toEqual({
      kind: "error",
      message: 'write needs --content "<body>".',
    });
  });
});

describe("status and reviewed arguments", () => {
  it.each(["status", "reviewed"])("reads %s with no arguments", (command) => {
    expect(parseArgs([command])).toEqual({
      kind: "command",
      command: { kind: command },
    });
  });

  it("rejects an argument to status", () => {
    expect(parseArgs(["status", "porta"])).toEqual({
      kind: "error",
      message: "status takes no arguments; unexpected: porta",
    });
  });

  it("rejects an argument to reviewed", () => {
    expect(parseArgs(["reviewed", "porta"])).toEqual({
      kind: "error",
      message: "reviewed takes no arguments; unexpected: porta",
    });
  });
});

describe("HELP", () => {
  it("documents every command and the approval rule for the writing ones", () => {
    for (const command of [
      "list",
      "search",
      "read",
      "write",
      "remove",
      "status",
      "reviewed",
    ]) {
      expect(HELP).toContain(command);
    }
    expect(HELP).toContain("retrospective skill has proposed");
    expect(HELP).toContain("the user has approved");
  });

  it("documents the retrospective search flags and their defaults", () => {
    expect(HELP).toContain("--retrospective-files");
    expect(HELP).toContain(
      `Retrospective reports given snippets on one page.\n                          Default ${RETROSPECTIVE_FILES_DEFAULT}.`,
    );
    expect(HELP).toContain("--retrospective-lines");
    expect(HELP).toContain(
      `Snippet lines printed per shown retrospective\n                          report. Default ${RETROSPECTIVE_LINES_DEFAULT}.`,
    );
    expect(HELP).toContain("--retrospective-page");
    expect(HELP).toContain("1-based page over the ranked retrospective report");
    expect(HELP).toContain("--retrospective-since");
    expect(HELP).toContain(
      "A report whose file name carries no date is\n                          never filtered out.",
    );
  });

  it("documents that reviewed belongs to the memory-review skill, not to hand use after an abandoned review", () => {
    expect(HELP).toContain("memory-review skill at the end of a completed");
    expect(HELP).toContain("not for running by hand after an abandoned");
  });

  it("documents the exit codes the CLI returns", () => {
    expect(HELP).toContain("0  success");
    expect(HELP).toContain("1  a usage error");
    expect(HELP).toContain("2  an unexpected internal failure");
  });
});
