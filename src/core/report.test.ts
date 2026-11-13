import { describe, expect, it } from "vitest";
import type { Finding, PageRecord } from "./detectors.js";
import { diffDuplicates, makeDigest } from "./duplicates.js";
import { renderJson, renderMarkdown, scoreWorkspace } from "./report.js";

function pageFor(id: string, overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    id,
    title: `Page ${id}`,
    url: `https://notion.so/${id}`,
    parentType: "workspace",
    lastEditedTime: new Date("2026-11-01T00:00:00Z"),
    createdTime: new Date("2026-10-01T00:00:00Z"),
    archived: false,
    hasChildren: true,
    ...overrides,
  };
}

function finding(kind: Finding["kind"], id = "p1"): Finding {
  return { kind, page: pageFor(id), detail: "some detail" };
}

describe("scoreWorkspace", () => {
  it("weights dead links and hollow pages below stale and duplicate", () => {
    expect(scoreWorkspace([finding("dead_link")])).toBe(99);
    expect(scoreWorkspace([finding("hollow")])).toBe(99);
    expect(scoreWorkspace([finding("orphan")])).toBe(98);
    expect(scoreWorkspace([finding("empty_database")])).toBe(98);
    expect(scoreWorkspace([finding("duplicate")])).toBe(98);
    expect(scoreWorkspace([finding("stale")])).toBe(99);
  });

  it("combines penalties across kinds exactly", () => {
    const findings = [
      finding("untitled", "a"), // 5
      finding("untitled", "b"), // 5
      finding("empty", "c"), // 3
      finding("stale", "d"), // 1
      finding("duplicate", "e"), // 2
      finding("duplicate", "f"), // 2
    ];
    expect(scoreWorkspace(findings)).toBe(100 - 5 - 5 - 3 - 1 - 2 - 2);
  });

  it("caps every category so one messy corner can't tank the score", () => {
    const many = (kind: Finding["kind"]) =>
      Array.from({ length: 30 }, (_, i) => finding(kind, `p${i}`));
    expect(scoreWorkspace(many("untitled"))).toBe(75); // cap 25
    expect(scoreWorkspace(many("empty"))).toBe(80); // cap 20
    expect(scoreWorkspace(many("stale"))).toBe(70); // cap 30
    expect(scoreWorkspace(many("duplicate"))).toBe(75); // cap 25
    expect(scoreWorkspace(many("orphan"))).toBe(80); // cap 20
    expect(scoreWorkspace(many("dead_link"))).toBe(90); // cap 10
    expect(scoreWorkspace(many("empty_database"))).toBe(90); // cap 10
    expect(scoreWorkspace(many("hollow"))).toBe(95); // cap 5
  });

  it("never goes below zero", () => {
    const everything = Array.from({ length: 40 }, (_, i) =>
      finding(i % 2 === 0 ? "untitled" : "empty", `p${i}`)
    );
    expect(scoreWorkspace(everything)).toBe(55); // 25 + 20 penalties
    const maxed = [
      ...Array.from({ length: 30 }, (_, i) => finding("untitled", `u${i}`)),
      ...Array.from({ length: 30 }, (_, i) => finding("empty", `e${i}`)),
      ...Array.from({ length: 30 }, (_, i) => finding("stale", `s${i}`)),
      ...Array.from({ length: 30 }, (_, i) => finding("duplicate", `d${i}`)),
      ...Array.from({ length: 30 }, (_, i) => finding("orphan", `o${i}`)),
      ...Array.from({ length: 30 }, (_, i) => finding("dead_link", `l${i}`)),
      ...Array.from({ length: 30 }, (_, i) => finding("empty_database", `db${i}`)),
      ...Array.from({ length: 30 }, (_, i) => finding("hollow", `h${i}`)),
    ];
    // all caps hit: 25+20+30+25+20+10+10+5 = 145 penalty, floored at 0
    expect(scoreWorkspace(maxed)).toBe(0);
  });
});

describe("renderMarkdown", () => {
  it("renders the header with page counts, score, findings and trend", () => {
    const pages = [pageFor("a"), pageFor("b", { archived: true })];
    const md = renderMarkdown(pages, [finding("stale", "a")], 99, 90, "67 -> 99 (+32 since Nov 1)");
    expect(md).toContain("- Pages scanned: 1 active, 1 archived");
    expect(md).toContain("- Hygiene score: **99/100**");
    expect(md).toContain("- Trend: 67 -> 99 (+32 since Nov 1)");
    expect(md).toContain("- Findings: 1");
  });

  it("renders a section per finding kind with counts in the headings", () => {
    const findings = [
      finding("orphan", "o"),
      finding("dead_link", "l"),
      finding("empty_database", "db"),
      finding("hollow", "h"),
      finding("stale", "s1"),
      finding("stale", "s2"),
    ];
    const md = renderMarkdown(findings.map((f) => f.page), findings, 80, 90);
    expect(md).toContain("## Orphaned pages — 1");
    expect(md).toContain("## Dead links — 1");
    expect(md).toContain("## Empty databases — 1");
    expect(md).toContain("## Hollow pages — 1");
    expect(md).toContain("## Stale pages (>90 days) — 2");
  });

  it("shows the custom stale window in the heading", () => {
    const md = renderMarkdown([pageFor("s")], [finding("stale", "s")], 99, 30);
    expect(md).toContain("## Stale pages (>30 days) — 1");
  });

  it("labels untitled pages and links each finding", () => {
    const f: Finding = { kind: "untitled", page: pageFor("x", { title: "  " }), detail: "Page has no title" };
    const md = renderMarkdown([f.page], [f], 95, 90);
    expect(md).toContain("- [(untitled)](https://notion.so/x) — Page has no title");
  });

  it("truncates long sections and says how many more there are", () => {
    const findings = Array.from({ length: 28 }, (_, i) => finding("stale", `p${i}`));
    const md = renderMarkdown(findings.map((f) => f.page), findings, 60, 90);
    expect(md).toContain("## Stale pages (>90 days) — 28");
    expect(md.match(/^- \[/gm)).toHaveLength(25);
    expect(md).toContain("- …and 3 more");
  });

  it("says the workspace is clean when there are no findings", () => {
    const md = renderMarkdown([pageFor("a")], [], 100, 90);
    expect(md).toContain("No findings. This workspace is clean.");
    expect(md).not.toContain("##");
  });

  it("renders duplicates grouped by title with diffs and suggestions", () => {
    const a = pageFor("a", { title: "Meeting notes", lastEditedTime: new Date("2026-11-10T00:00:00Z") });
    const b = pageFor("b", { title: "meeting notes", lastEditedTime: new Date("2026-03-02T00:00:00Z") });
    const text = "agenda budget hiring roadmap launch retro";
    const diffs = diffDuplicates([a, b], new Map([["a", makeDigest(text)], ["b", makeDigest(text)]]));
    const findings: Finding[] = [
      { kind: "duplicate", page: a, detail: `"meeting notes" appears 2 times` },
      { kind: "duplicate", page: b, detail: `"meeting notes" appears 2 times` },
    ];
    const md = renderMarkdown([a, b], findings, 96, 90, null, diffs);
    expect(md).toContain("## Duplicate titles — 2");
    expect(md).toContain('### "Meeting notes" — 2 copies');
    expect(md).toContain("Suggestion: Contents are near-identical; keep the newest copy (edited 2026-11-10)");
    // the flat per-finding list is replaced by the grouped diff
    expect(md).not.toContain("appears 2 times in the workspace");
  });

  it("falls back to the flat list when no diffs are available", () => {
    const findings = [finding("duplicate", "d1"), finding("duplicate", "d2")];
    const md = renderMarkdown(findings.map((f) => f.page), findings, 96, 90);
    expect(md).toContain("## Duplicate titles — 2");
    expect(md).toContain("- [Page d1](https://notion.so/d1) — some detail");
  });
});

describe("renderJson", () => {
  it("emits score, page count and findings with ISO dates", () => {
    const f: Finding = {
      kind: "stale",
      page: pageFor("s", { lastEditedTime: new Date("2026-08-01T10:20:30Z") }),
      detail: "Last edited 92 days ago",
    };
    const report = JSON.parse(renderJson([f.page, pageFor("arch", { archived: true })], [f], 99));
    expect(report.pagesScanned).toBe(1);
    expect(report.score).toBe(99);
    expect(report.findings).toEqual([
      {
        kind: "stale",
        detail: "Last edited 92 days ago",
        page: {
          id: "s",
          title: "Page s",
          url: "https://notion.so/s",
          lastEditedTime: "2026-08-01T10:20:30.000Z",
        },
      },
    ]);
    expect(report.duplicates).toEqual([]);
  });

  it("includes duplicate comparisons when provided", () => {
    const a = pageFor("a", { title: "Dup", lastEditedTime: new Date("2026-11-10T00:00:00Z") });
    const b = pageFor("b", { title: "dup", lastEditedTime: new Date("2026-03-02T00:00:00Z") });
    const diffs = diffDuplicates([a, b], new Map([["a", makeDigest("same words")], ["b", makeDigest("same words")]]));
    const report = JSON.parse(renderJson([a, b], [], 98, diffs));
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0].title).toBe("Dup");
    expect(report.duplicates[0].suggestion).toBe("keep_newest");
    expect(report.duplicates[0].copies.map((c: { id: string }) => c.id)).toEqual(["a", "b"]);
  });
});
