import { describe, expect, it } from "vitest";
import { auditWorkspace } from "./audit.js";
import type { FetchLike } from "./linkcheck.js";
import { fakeNotion } from "./notion.test.js";

const NOW = new Date().toISOString();

function notionPage(config: {
  id: string;
  title: string;
  parent?: Record<string, unknown>;
}): unknown {
  return {
    object: "page",
    id: config.id,
    properties: {
      Name: { type: "title", title: [{ plain_text: config.title }] },
    },
    url: `https://notion.so/${config.id}`,
    parent: config.parent ?? { type: "workspace", workspace: true },
    last_edited_time: NOW,
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
