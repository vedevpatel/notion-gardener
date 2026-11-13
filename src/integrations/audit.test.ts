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
  it("runs every detector against the mocked workspace and scores it", async () => {
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
    expect(audit.score).toBeLessThan(100);
    expect(audit.databases).toHaveLength(1);
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
