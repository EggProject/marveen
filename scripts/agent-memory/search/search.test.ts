import { describe, expect, it } from "vitest";

import {
  search,
  searchGroupedByFile,
  type SearchFile,
  SNIPPET_MAX_LENGTH,
  toSnippet,
} from "./search";

const FILES: readonly SearchFile[] = [
  { path: "a.md", text: "# a\nporta twice\nand PORTA again\nnothing here\n" },
  { path: "b.md", text: "# b\nporta once\n" },
  { path: "c.md", text: "# c\nporta once here too\n" },
];

describe("toSnippet", () => {
  it("collapses whitespace", () => {
    expect(toSnippet("  - a\tlist   item  ")).toBe("- a list item");
  });

  it("leaves a line at the limit whole", () => {
    const line = "x".repeat(SNIPPET_MAX_LENGTH);

    expect(toSnippet(line)).toBe(line);
  });

  it("cuts a longer line to the limit, ellipsis included", () => {
    const snippet = toSnippet("x".repeat(SNIPPET_MAX_LENGTH + 1));

    expect(snippet).toHaveLength(SNIPPET_MAX_LENGTH);
    expect(snippet.endsWith("...")).toBe(true);
  });
});

describe("search", () => {
  it("matches case-insensitively and reports 1-based line numbers", () => {
    const one = { path: "a.md", text: "# a\nporta twice\nand PORTA again\n" };

    const { hits } = search([one], "PoRtA", 10);

    expect(hits).toEqual([
      { path: "a.md", line: 2, snippet: "porta twice" },
      { path: "a.md", line: 3, snippet: "and PORTA again" },
    ]);
  });

  it("ranks the file with more matching lines first, then by path", () => {
    const { hits, dropped } = search(FILES, "porta", 10);

    expect(hits.map((hit) => `${hit.path}:${hit.line}`)).toEqual([
      "a.md:2",
      "a.md:3",
      "b.md:2",
      "c.md:2",
    ]);
    expect(dropped).toBe(0);
  });

  it("breaks a tie by path ascending, whatever order the files arrive in", () => {
    const reversed = [
      FILES[2] ?? { path: "", text: "" },
      FILES[1] ?? { path: "", text: "" },
    ];

    expect(search(reversed, "porta", 10).hits.map((hit) => hit.path)).toEqual([
      "b.md",
      "c.md",
    ]);
  });

  it("cuts the hits at the limit and counts what it dropped", () => {
    const { hits, dropped } = search(FILES, "porta", 1);

    expect(hits).toEqual([{ path: "a.md", line: 2, snippet: "porta twice" }]);
    expect(dropped).toBe(3);
  });

  it("finds nothing rather than failing on a query with no match", () => {
    expect(search(FILES, "absent", 10)).toEqual({ hits: [], dropped: 0 });
  });

  it("treats the query as text, not as a pattern", () => {
    const files = [{ path: "a.md", text: "a (paren) line\nno match\n" }];

    expect(search(files, "(paren)", 10).hits).toHaveLength(1);
  });
});

const ascendingByPath = (leftPath: string, rightPath: string): number =>
  leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;

describe("searchGroupedByFile", () => {
  it("groups hits by file, ranked by hit count descending", () => {
    const grouped = searchGroupedByFile(FILES, "porta", ascendingByPath);

    expect(grouped.map((group) => group.path)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
    expect(grouped[0]?.hits.map((hit) => hit.line)).toEqual([2, 3]);
    expect(grouped[1]?.hits.map((hit) => hit.line)).toEqual([2]);
  });

  it("excludes a file with no hits", () => {
    const grouped = searchGroupedByFile(FILES, "absent", ascendingByPath);

    expect(grouped).toEqual([]);
  });

  it("breaks a tied hit count with the caller's tiebreak", () => {
    const ascending = searchGroupedByFile(
      [FILES[1] ?? { path: "", text: "" }, FILES[2] ?? { path: "", text: "" }],
      "porta",
      ascendingByPath,
    );
    const descending = searchGroupedByFile(
      [FILES[1] ?? { path: "", text: "" }, FILES[2] ?? { path: "", text: "" }],
      "porta",
      (leftPath, rightPath) => -ascendingByPath(leftPath, rightPath),
    );

    expect(ascending.map((group) => group.path)).toEqual(["b.md", "c.md"]);
    expect(descending.map((group) => group.path)).toEqual(["c.md", "b.md"]);
  });
});
