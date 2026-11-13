import { describe, expect, it } from "vitest";
import { auditWorkspace } from "./audit.js";
import type { FetchLike } from "./linkcheck.js";
import { fakeNotion } from "./notion.test.js";

const NOW = new Date().toISOString();

function notionPage(config: {
  id: string;
  title: string;
  parent?: Record<string, unknown>;
  edited?: string;
}): unknown {
  return {
    object: "page",
    id: config.id,
    properties: {
      Name: { type: "title", title: [{ plain_text: config.title }] },
    },
    url: `https://notion.so/${config.id}`,
    parent: config.parent ?? { type: "workspace", workspace: true },
    last_edited_time: config.edited ?? NOW,
    created_time: NOW,
    archived: false,
  };
}

function paragraph(text: string, link?: string): unknown {
  return {
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: text, link: link ? { url: link } : null },
          href: link ?? null,
          plain_text: text,
        },
      ],
    },
  };
}

function buildWorkspace() {
  return fakeNotion({
    pages: [
      notionPage({ id: "p-untitled", title: "" }),
      notionPage({ id: "p-links", title: "Reading list" }),
      notionPage({
        id: "p-orphan",
        title: "Forgotten notes",
        parent: { type: "page_id", page_id: "p-untitled" },
      }),
      notionPage({
        id: "p-hollow",
        title: "Deleted spec",
        parent: { type: "page_id", page_id: "p-untitled" },
      }),
    ],
    blocks: {
      "p-untitled": [paragraph("hello")],
      "p-links": [
        { type: "bookmark", bookmark: { url: "https://dead.dev/page" } },
        paragraph("alive", "https://alive.dev/ok"),
      ],
      "p-orphan": [paragraph("some content")],
      "p-hollow": [],
    },
    databases: [{ id: "db1", title: "Empty roadmap", rows: 0 }],
    comments: { "p-hollow": 2 },
  });
}

const fakeHttp = (async (url: unknown) => {
  const u = String(url);
  if (u === "https://dead.dev/page") return { status: 404 } as Response;
  return { status: 200 } as Response;
}) as unknown as FetchLike;

describe("auditWorkspace", () => {
  it("runs every detector against the mocked workspace and scores it exactly", async () => {
    const audit = await auditWorkspace("fake-token", {
      notion: buildWorkspace(),
      fetchImpl: fakeHttp,
    });
    const kinds = audit.findings.map((f) => f.kind);

    expect(kinds).toContain("untitled"); // p-untitled
    expect(kinds).toContain("empty"); // p-hollow has no blocks
    expect(kinds).toContain("orphan"); // p-orphan and p-hollow, nothing links to them
    expect(kinds).toContain("hollow"); // p-hollow: no content, 2 comments
    expect(kinds).toContain("empty_database"); // db1
    expect(kinds).toContain("dead_link"); // p-links -> https://dead.dev/page

    const orphanIds = audit.findings.filter((f) => f.kind === "orphan").map((f) => f.page.id);
    expect(orphanIds.sort()).toEqual(["p-hollow", "p-orphan"]);
    // Workspace roots are exempt even when nothing links to them.
    expect(orphanIds).not.toContain("p-links");

    const deadLink = audit.findings.find((f) => f.kind === "dead_link");
    expect(deadLink?.page.id).toBe("p-links");
    expect(deadLink?.detail).toContain("https://dead.dev/page");
    expect(deadLink?.detail).not.toContain("alive.dev");

    expect(audit.warnings).toEqual([]);
    // untitled 5 + empty 3 + orphan 2*2 + hollow 1 + empty_database 2 + dead_link 1
    expect(audit.score).toBe(100 - 5 - 3 - 4 - 1 - 2 - 1);
    expect(audit.databases).toHaveLength(1);
    expect(audit.duplicateDiffs).toEqual([]);
  });

  it("diffs duplicate pages and suggests which copy to keep", async () => {
    const notion = fakeNotion({
      pages: [
        notionPage({ id: "dup-new", title: "Meeting notes" }),
        notionPage({ id: "dup-old", title: "meeting notes" }),
      ],
      blocks: {
        "dup-new": [paragraph("agenda budget hiring roadmap")],
        "dup-old": [paragraph("agenda budget hiring roadmap")],
      },
    });
    const audit = await auditWorkspace("fake-token", { notion, fetchImpl: fakeHttp });
    expect(audit.duplicateDiffs).toHaveLength(1);
    const diff = audit.duplicateDiffs[0];
    expect(diff.title).toBe("Meeting notes");
    expect(diff.suggestion).toBe("keep_newest");
    expect(diff.pages.map((p) => p.page.id)).toEqual(["dup-new", "dup-old"]);
    // identical contents: no copy has unique words
    expect(diff.pages.every((p) => p.uniqueWords.length === 0)).toBe(true);
    expect(diff.pages[0].digest?.charCount).toBeGreaterThan(0);
  });

  it("warns and skips the hollow check when comment access is missing", async () => {
    const notion = fakeNotion({
      pages: [notionPage({ id: "p-hollow", title: "Deleted spec" })],
      blocks: { "p-hollow": [] },
      comments: "error",
    });
    const audit = await auditWorkspace("fake-token", { notion, fetchImpl: fakeHttp });
    expect(audit.findings.some((f) => f.kind === "hollow")).toBe(false);
    expect(audit.warnings).toHaveLength(1);
    expect(audit.warnings[0]).toContain("comment");
  });

  it("caps the external links checked per run and says so", async () => {
    // 11 pages x 50 urls = 550 unique links, over the 500 per-scan cap.
    const pages = Array.from({ length: 11 }, (_, i) =>
      notionPage({ id: `p${i}`, title: `Links ${i}` })
    );
    const blocks: Record<string, unknown[]> = {};
    for (let i = 0; i < 11; i++) {
      blocks[`p${i}`] = Array.from({ length: 50 }, (_, j) => ({
        type: "bookmark",
        bookmark: { url: `https://site-${i}-${j}.example/page` },
      }));
    }
    const notion = fakeNotion({ pages, blocks });
    const audit = await auditWorkspace("fake-token", { notion, fetchImpl: fakeHttp });
    expect(audit.warnings.some((w) => w.includes("550") && w.includes("500"))).toBe(true);
    // every checked link returned 200, so nothing is flagged
    expect(audit.findings.some((f) => f.kind === "dead_link")).toBe(false);
  });

  it("skips the HTTP checks when checkExternalLinks is false", async () => {
    let fetched = 0;
    const countingFetch = (async (url: unknown) => {
      fetched++;
      return fakeHttp(url, {});
    }) as FetchLike;
    const audit = await auditWorkspace("fake-token", {
      notion: buildWorkspace(),
      fetchImpl: countingFetch,
      checkExternalLinks: false,
    });
    expect(fetched).toBe(0);
    expect(audit.findings.some((f) => f.kind === "dead_link")).toBe(false);
  });
});

describe("auditWorkspace with a config", () => {
  const cfg = (c: { staleDays?: number; protectedPages?: string[]; ignore?: string[] }) => ({
    protectedPages: [],
    ignore: [],
    ...c,
  });
  const run = (config: ReturnType<typeof cfg>, extra: Record<string, unknown> = {}) =>
    auditWorkspace("fake-token", {
      notion: buildWorkspace(),
      fetchImpl: fakeHttp,
      config,
      ...extra,
    });
  const kindsFor = (audit: Awaited<ReturnType<typeof run>>, id: string) =>
    audit.findings.filter((f) => f.page.id === id).map((f) => f.kind).sort();

  it("without a config nothing is suppressed", async () => {
    const audit = await auditWorkspace("fake-token", {
      notion: buildWorkspace(),
      fetchImpl: fakeHttp,
    });
    expect(audit.suppressed).toEqual({ protected: 0, ignored: 0 });
    expect(audit.staleDays).toBe(90);
  });

  it("a protected page gets no finding from any detector, and the score recovers", async () => {
    const baseline = await run(cfg({}));
    expect(kindsFor(baseline, "p-hollow")).toEqual(["empty", "hollow", "orphan"]);

    const audit = await run(cfg({ protectedPages: ["p-hollow"] }));
    expect(kindsFor(audit, "p-hollow")).toEqual([]);
    // everything else is untouched
    expect(kindsFor(audit, "p-untitled")).toEqual(["untitled"]);
    expect(kindsFor(audit, "p-orphan")).toEqual(["orphan"]);
    expect(kindsFor(audit, "p-links")).toEqual(["dead_link"]);
    expect(audit.suppressed).toEqual({ protected: 3, ignored: 0 });
    // empty 3 + orphan 2 + hollow 1 removed
    expect(audit.score).toBe(baseline.score + 6);
  });

  it("protects by title pattern, case-insensitively", async () => {
    const audit = await run(cfg({ protectedPages: ["FORGOTTEN *"] }));
    expect(kindsFor(audit, "p-orphan")).toEqual([]);
    expect(kindsFor(audit, "p-hollow")).toEqual(["empty", "hollow", "orphan"]);
    expect(audit.suppressed.protected).toBe(1);
  });

  it("protects an untitled page by id", async () => {
    const audit = await run(cfg({ protectedPages: ["p-untitled"] }));
    expect(audit.findings.some((f) => f.kind === "untitled")).toBe(false);
  });

  it("protects an empty database", async () => {
    const audit = await run(cfg({ protectedPages: ["Empty roadmap"] }));
    expect(audit.findings.some((f) => f.kind === "empty_database")).toBe(false);
    expect(audit.suppressed.protected).toBe(1);
  });

  it("a protected page still counts as a link source, so its targets are not orphans", async () => {
    const notion = fakeNotion({
      pages: [
        notionPage({ id: "index", title: "Index" }),
        notionPage({
          id: "target",
          title: "Target",
          parent: { type: "page_id", page_id: "index" },
        }),
      ],
      blocks: {
        index: [{ type: "link_to_page", link_to_page: { type: "page_id", page_id: "target" } }],
        target: [paragraph("content")],
      },
    });
    const audit = await auditWorkspace("fake-token", {
      notion,
      fetchImpl: fakeHttp,
      config: cfg({ protectedPages: ["Index"] }),
    });
    expect(audit.findings).toEqual([]);
  });

  it("protected pages do not take part in duplicate grouping", async () => {
    const notion = fakeNotion({
      pages: [
        notionPage({ id: "a", title: "Meeting notes" }),
        notionPage({ id: "b", title: "meeting notes" }),
      ],
      blocks: { a: [paragraph("budget")], b: [paragraph("budget")] },
    });
    const run2 = (config: ReturnType<typeof cfg>) =>
      auditWorkspace("fake-token", { notion, fetchImpl: fakeHttp, config });
    expect((await run2(cfg({}))).findings.filter((f) => f.kind === "duplicate")).toHaveLength(2);

    const audit = await run2(cfg({ protectedPages: ["a"] }));
    expect(audit.findings.filter((f) => f.kind === "duplicate")).toEqual([]);
    expect(audit.duplicateDiffs).toEqual([]);
  });

  it("ignored pages lose their findings but still count as duplicate twins", async () => {
    const notion = fakeNotion({
      pages: [
        notionPage({ id: "a", title: "Meeting notes" }),
        notionPage({ id: "b", title: "meeting notes" }),
      ],
      blocks: { a: [paragraph("budget")], b: [paragraph("budget")] },
    });
    const audit = await auditWorkspace("fake-token", {
      notion,
      fetchImpl: fakeHttp,
      config: cfg({ ignore: ["a"] }),
    });
    const dups = audit.findings.filter((f) => f.kind === "duplicate");
    expect(dups.map((f) => f.page.id)).toEqual(["b"]);
    expect(dups[0].detail).toContain("2 times");
    expect(audit.suppressed).toEqual({ protected: 0, ignored: 1 });
    // the diff survives because one copy is still reported
    expect(audit.duplicateDiffs).toHaveLength(1);
  });

  it("drops the duplicate diff when every copy is ignored", async () => {
    const notion = fakeNotion({
      pages: [
        notionPage({ id: "a", title: "Meeting notes" }),
        notionPage({ id: "b", title: "meeting notes" }),
      ],
      blocks: { a: [paragraph("budget")], b: [paragraph("budget")] },
    });
    const audit = await auditWorkspace("fake-token", {
      notion,
      fetchImpl: fakeHttp,
      config: cfg({ ignore: ["meeting notes"] }),
    });
    expect(audit.findings).toEqual([]);
    expect(audit.duplicateDiffs).toEqual([]);
    expect(audit.suppressed.ignored).toBe(2);
  });

  it("ignored findings leave the score; ignored dead links are dropped", async () => {
    const baseline = await run(cfg({}));
    const audit = await run(cfg({ ignore: ["Reading list"] }));
    expect(audit.findings.some((f) => f.kind === "dead_link")).toBe(false);
    expect(audit.score).toBe(baseline.score + 1);
    expect(audit.suppressed).toEqual({ protected: 0, ignored: 1 });
  });

  describe("stale window", () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const staleAudit = (extra: Record<string, unknown>) =>
      auditWorkspace("fake-token", {
        notion: fakeNotion({
          pages: [notionPage({ id: "old", title: "Old plan", edited: daysAgo(45) })],
          blocks: { old: [paragraph("x")] },
        }),
        fetchImpl: fakeHttp,
        ...extra,
      });
    const staleCount = (a: Awaited<ReturnType<typeof staleAudit>>) =>
      a.findings.filter((f) => f.kind === "stale").length;

    it("config.staleDays tightens the window", async () => {
      const a = await staleAudit({ config: cfg({ staleDays: 30 }) });
      expect(staleCount(a)).toBe(1);
      expect(a.staleDays).toBe(30);
    });

    it("without config the 90-day default applies", async () => {
      expect(staleCount(await staleAudit({}))).toBe(0);
    });

    it("an explicit staleDays option beats the config", async () => {
      const a = await staleAudit({ config: cfg({ staleDays: 30 }), staleDays: 60 });
      expect(staleCount(a)).toBe(0);
      expect(a.staleDays).toBe(60);
    });
  });
});
