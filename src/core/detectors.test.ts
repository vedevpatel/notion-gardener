import { describe, expect, it } from "vitest";
import {
  affectedPages,
  deadLinkFindings,
  detectEmptyDatabases,
  detectFindings,
  detectHollowPages,
  detectOrphans,
  inboundLinkCounts,
  normalizeTitle,
  type DatabaseRecord,
  type PageRecord,
} from "./detectors.js";

const NOW = new Date("2026-11-12T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function page(overrides: Partial<PageRecord>): PageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    title: "A page",
    url: "https://notion.so/x",
    parentType: "workspace",
    lastEditedTime: new Date(NOW.getTime() - DAY),
    createdTime: new Date(NOW.getTime() - 30 * DAY),
    archived: false,
    hasChildren: true,
    ...overrides,
  };
}

describe("detectFindings", () => {
  it("flags exactly the untitled page, not its titled sibling", () => {
    const untitled = page({ title: "   " });
    const titled = page({ title: "Real title" });
    const findings = detectFindings([untitled, titled], { now: NOW });
    const untitledFindings = findings.filter((f) => f.kind === "untitled");
    expect(untitledFindings).toHaveLength(1);
    expect(untitledFindings[0].page.id).toBe(untitled.id);
  });

  it("flags exactly the empty page, not one with content", () => {
    const empty = page({ hasChildren: false });
    const full = page({ hasChildren: true });
    const findings = detectFindings([empty, full], { now: NOW });
    const emptyFindings = findings.filter((f) => f.kind === "empty");
    expect(emptyFindings).toHaveLength(1);
    expect(emptyFindings[0].page.id).toBe(empty.id);
  });

  it("flags pages older than the stale window", () => {
    const old = page({ lastEditedTime: new Date(NOW.getTime() - 120 * DAY) });
    const fresh = page({ lastEditedTime: new Date(NOW.getTime() - 10 * DAY) });
    const findings = detectFindings([old, fresh], { now: NOW, staleDays: 90 });
    const stale = findings.filter((f) => f.kind === "stale");
    expect(stale).toHaveLength(1);
    expect(stale[0].page.id).toBe(old.id);
    expect(stale[0].detail).toContain("120 days ago");
  });

  it("treats the stale window as an exclusive boundary", () => {
    const exact = page({ lastEditedTime: new Date(NOW.getTime() - 14 * DAY) });
    const over = page({ lastEditedTime: new Date(NOW.getTime() - 14 * DAY - 1) });
    const findings = detectFindings([exact, over], { now: NOW, staleDays: 14 });
    const stale = findings.filter((f) => f.kind === "stale");
    expect(stale.map((f) => f.page.id)).toEqual([over.id]);
  });

  it("groups duplicate titles case- and whitespace-insensitively", () => {
    const a = page({ title: "Meeting Notes" });
    const b = page({ title: "meeting   notes" });
    const c = page({ title: "Other" });
    const findings = detectFindings([a, b, c], { now: NOW });
    const dupes = findings.filter((f) => f.kind === "duplicate");
    expect(dupes).toHaveLength(2);
    expect(dupes[0].detail).toContain("2 times");
  });

  it("counts how many copies share a title", () => {
    const copies = [
      page({ title: "Roadmap" }),
      page({ title: "roadmap" }),
      page({ title: " ROADMAP " }),
    ];
    const dupes = detectFindings(copies, { now: NOW }).filter((f) => f.kind === "duplicate");
    expect(dupes).toHaveLength(3);
    expect(dupes[0].detail).toContain("3 times");
  });

  it("never groups untitled pages as duplicates", () => {
    const a = page({ title: "" });
    const b = page({ title: "   " });
    const findings = detectFindings([a, b], { now: NOW });
    expect(findings.filter((f) => f.kind === "duplicate")).toHaveLength(0);
  });

  it("ignores archived pages entirely", () => {
    const p = page({ title: "", archived: true, hasChildren: false });
    expect(detectFindings([p], { now: NOW })).toHaveLength(0);
  });

  it("returns nothing for a clean workspace", () => {
    expect(detectFindings([page({})], { now: NOW })).toHaveLength(0);
  });
});

describe("affectedPages", () => {
  it("deduplicates pages across findings", () => {
    const p = page({ title: "", hasChildren: false });
    const findings = detectFindings([p], { now: NOW });
    expect(findings.length).toBeGreaterThan(1);
    expect(affectedPages(findings)).toHaveLength(1);
  });
});

describe("normalizeTitle", () => {
  it("collapses whitespace and case", () => {
    expect(normalizeTitle("  Weekly   Sync ")).toBe("weekly sync");
  });
});

describe("inboundLinkCounts", () => {
  it("counts distinct linking pages, ignoring self-links and archived pages", () => {
    const a = page({ id: "a" });
    const b = page({ id: "b" });
    const c = page({ id: "c" });
    const archivedTarget = page({ id: "t", archived: true });
    const outbound = new Map<string, Set<string>>([
      ["a", new Set(["b", "b", "a", "t"])], // dup, self-link, archived target
      ["c", new Set(["b"])],
      ["t", new Set(["c"])], // archived source
    ]);
    const inbound = inboundLinkCounts([a, b, c, archivedTarget], outbound);
    expect(inbound.get("b")).toBe(2);
    expect(inbound.get("c") ?? 0).toBe(0);
    expect(inbound.has("t")).toBe(false);
  });
});

describe("detectOrphans", () => {
  it("flags a child page nothing links to", () => {
    const p = page({ id: "p1", parentType: "page_id", parentId: "root" });
    const findings = detectOrphans([p], new Map());
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("orphan");
    expect(findings[0].detail).toContain("Nothing links");
  });

  it("exempts workspace roots and database rows", () => {
    const root = page({ id: "r", parentType: "workspace" });
    const row = page({ id: "d", parentType: "database_id", parentId: "db1" });
    expect(detectOrphans([root, row], new Map())).toHaveLength(0);
  });

  it("does not flag a page with an inbound link", () => {
    const p = page({ id: "p1", parentType: "page_id", parentId: "root" });
    expect(detectOrphans([p], new Map([["p1", 1]]))).toHaveLength(0);
  });

  it("ignores archived pages", () => {
    const p = page({ id: "p1", parentType: "page_id", archived: true });
    expect(detectOrphans([p], new Map())).toHaveLength(0);
  });
});

describe("detectHollowPages", () => {
  it("flags an empty page with comments", () => {
    const p = page({ id: "p1", hasChildren: false });
    const findings = detectHollowPages([p], new Map([["p1", 3]]));
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("hollow");
    expect(findings[0].detail).toContain("3 comments");
  });

  it("ignores pages with content, with no comments, or archived", () => {
    const withContent = page({ id: "a", hasChildren: true });
    const noComments = page({ id: "b", hasChildren: false });
    const archived = page({ id: "c", hasChildren: false, archived: true });
    const counts = new Map([
      ["a", 5],
      ["c", 5],
    ]);
    expect(detectHollowPages([withContent, noComments, archived], counts)).toHaveLength(0);
  });
});

describe("detectEmptyDatabases", () => {
  const db = (overrides: Partial<DatabaseRecord> = {}): DatabaseRecord => ({
    id: "db1",
    title: "Tasks",
    url: "https://notion.so/db1",
    lastEditedTime: NOW,
    archived: false,
    empty: true,
    ...overrides,
  });

  it("flags empty databases and skips non-empty and archived ones", () => {
    const findings = detectEmptyDatabases([
      db({}),
      db({ id: "db2", empty: false }),
      db({ id: "db3", archived: true }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("empty_database");
    expect(findings[0].page.title).toBe("Tasks");
    expect(findings[0].detail).toContain("no rows");
  });
});

describe("deadLinkFindings", () => {
  it("flags pages with dead urls and names the dead ones", () => {
    const p = page({ id: "p1" });
    const urls = new Map([["p1", ["https://a.dev/x", "https://b.dev/y"]]]);
    const findings = deadLinkFindings([p], urls, new Set(["https://a.dev/x"]));
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("dead_link");
    expect(findings[0].detail).toContain("https://a.dev/x");
    expect(findings[0].detail).not.toContain("b.dev");
  });

  it("stays quiet when nothing is dead or the page is archived", () => {
    const p = page({ id: "p1" });
    const archived = page({ id: "p2", archived: true });
    const urls = new Map([
      ["p1", ["https://a.dev/x"]],
      ["p2", ["https://dead.dev/z"]],
    ]);
    expect(deadLinkFindings([p], urls, new Set())).toHaveLength(0);
    expect(deadLinkFindings([archived], urls, new Set(["https://dead.dev/z"]))).toHaveLength(0);
  });
});
