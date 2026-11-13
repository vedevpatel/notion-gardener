import { describe, expect, it } from "vitest";
import type { PageRecord } from "../core/detectors.js";
import {
  extractBlockSignals,
  fetchCommentCounts,
  fetchDatabases,
  gatherSignals,
  type NotionLike,
} from "./notion.js";

function page(id: string, overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    id,
    title: `Page ${id}`,
    url: `https://notion.so/${id}`,
    parentType: "workspace",
    lastEditedTime: new Date(),
    createdTime: new Date(),
    archived: false,
    hasChildren: true,
    ...overrides,
  };
}

interface FakeDatabase {
  id: string;
  title: string;
  archived?: boolean;
  rows: number;
}

/** A NotionLike fake serving canned API-shaped data. No network. */
export function fakeNotion(config: {
  pages?: unknown[];
  databases?: FakeDatabase[];
  blocks?: Record<string, unknown[]>;
  comments?: Record<string, number> | "error";
}): NotionLike {
  return {
    async search(args) {
      const value = (args.filter as { value?: string } | undefined)?.value;
      if (value === "database") {
        return {
          results: (config.databases ?? []).map((d) => ({
            object: "database",
            id: d.id,
            title: [{ plain_text: d.title }],
            url: `https://notion.so/${d.id}`,
            last_edited_time: "2026-11-01T00:00:00.000Z",
            archived: d.archived ?? false,
          })),
          has_more: false,
          next_cursor: null,
        };
      }
      return { results: config.pages ?? [], has_more: false, next_cursor: null };
    },
    blocks: {
      children: {
        async list(args) {
          return {
            results: config.blocks?.[String(args.block_id)] ?? [],
            has_more: false,
            next_cursor: null,
          };
        },
      },
    },
    databases: {
      async query(args) {
        const db = (config.databases ?? []).find((d) => d.id === args.database_id);
        const rows = db?.rows ?? 0;
        return {
          results: Array.from({ length: Math.min(rows, 1) }, () => ({})),
          has_more: rows > 1,
          next_cursor: rows > 1 ? "more" : null,
        };
      },
    },
    comments: {
      async list(args) {
        if (config.comments === "error") throw new Error("missing comment capability");
        const n = config.comments?.[String(args.block_id)] ?? 0;
        return {
          results: Array.from({ length: n }, () => ({})),
          has_more: false,
          next_cursor: null,
        };
      },
    },
  };
}

describe("extractBlockSignals", () => {
  it("collects page refs from mentions and link_to_page, never child_page", () => {
    const blocks = [
      {
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "mention",
              mention: { type: "page", page: { id: "page-a" } },
              href: "https://www.notion.so/page-a",
              plain_text: "A",
            },
          ],
        },
      },
      { type: "link_to_page", link_to_page: { type: "page_id", page_id: "page-b" } },
      { type: "child_page", child_page: { title: "Subpage" } },
    ];
    const signals = extractBlockSignals(blocks);
    expect([...signals.pageRefs].sort()).toEqual(["page-a", "page-b"]);
  });

  it("collects external urls from hrefs, bookmarks, embeds and link previews, deduplicated", () => {
    const blocks = [
      {
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: { content: "docs", link: { url: "https://a.dev/1" } },
              href: "https://a.dev/1",
              plain_text: "docs",
            },
            {
              type: "mention",
              mention: { type: "link_preview", link_preview: { url: "https://c.dev/3" } },
              plain_text: "c",
            },
          ],
        },
      },
      { type: "bookmark", bookmark: { url: "https://a.dev/1" } },
      { type: "embed", embed: { url: "https://b.dev/2" } },
      { type: "link_preview", link_preview: { url: "https://c.dev/3" } },
    ];
    const signals = extractBlockSignals(blocks);
    expect(signals.urls).toEqual(["https://a.dev/1", "https://c.dev/3", "https://b.dev/2"]);
  });

  it("skips Notion-internal and non-http urls", () => {
    const blocks = [
      {
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: { content: "internal", link: { url: "https://www.notion.so/abc123" } },
              href: "https://www.notion.so/abc123",
              plain_text: "internal",
            },
            {
              type: "text",
              text: { content: "rel", link: { url: "/relative/path" } },
              plain_text: "rel",
            },
          ],
        },
      },
      { type: "bookmark", bookmark: { url: "https://mysite.notion.site/page" } },
    ];
    expect(extractBlockSignals(blocks).urls).toEqual([]);
  });
});

describe("gatherSignals", () => {
  it("builds the link graph, collects urls, and derives hasChildren", async () => {
    const a = page("a");
    const b = page("b", { hasChildren: true });
    const c = page("c");
    const notion = fakeNotion({
      blocks: {
        a: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "mention",
                  mention: { type: "page", page: { id: "b" } },
                  plain_text: "b",
                },
                {
                  type: "text",
                  text: { content: "x", link: { url: "https://x.dev" } },
                  href: "https://x.dev",
                  plain_text: "x",
                },
              ],
            },
          },
        ],
        b: [],
        c: [{ type: "bookmark", bookmark: { url: "https://y.dev" } }],
      },
    });
    const signals = await gatherSignals(notion, [a, b, c]);
    expect(signals.inbound.get("b")).toBe(1);
    expect(signals.inbound.get("a") ?? 0).toBe(0);
    expect(signals.urlsByPage.get("a")).toEqual(["https://x.dev"]);
    expect(signals.urlsByPage.get("c")).toEqual(["https://y.dev"]);
    expect(signals.urlsByPage.has("b")).toBe(false);
    expect(a.hasChildren).toBe(true);
    expect(b.hasChildren).toBe(false);
    expect(c.hasChildren).toBe(true);
  });

  it("skips archived pages entirely", async () => {
    const archived = page("old", { archived: true });
    const notion = fakeNotion({ blocks: { old: [{ type: "paragraph", paragraph: {} }] } });
    const signals = await gatherSignals(notion, [archived]);
    expect(signals.inbound.size).toBe(0);
    expect(signals.urlsByPage.size).toBe(0);
    expect(archived.hasChildren).toBe(true); // untouched: detectors ignore archived pages
  });
});

describe("fetchDatabases", () => {
  it("flags which databases are empty", async () => {
    const notion = fakeNotion({
      databases: [
        { id: "db1", title: "Tasks", rows: 0 },
        { id: "db2", title: "CRM", rows: 3 },
        { id: "db3", title: "Old", rows: 0, archived: true },
      ],
    });
    const dbs = await fetchDatabases(notion);
    expect(dbs.map((d) => [d.title, d.empty, d.archived])).toEqual([
      ["Tasks", true, false],
      ["CRM", false, false],
      ["Old", false, true],
    ]);
  });
});

describe("fetchCommentCounts", () => {
  it("counts comments only on childless active pages", async () => {
    const empty = page("e", { hasChildren: false });
    const full = page("f", { hasChildren: true });
    const notion = fakeNotion({ comments: { e: 4, f: 9 } });
    const scan = await fetchCommentCounts(notion, [empty, full]);
    expect(scan.available).toBe(true);
    expect(scan.counts.get("e")).toBe(4);
    expect(scan.counts.has("f")).toBe(false);
  });

  it("reports unavailable when comment access fails, instead of guessing", async () => {
    const empty = page("e", { hasChildren: false });
    const notion = fakeNotion({ comments: "error" });
    const scan = await fetchCommentCounts(notion, [empty]);
    expect(scan.available).toBe(false);
    expect(scan.counts.size).toBe(0);
  });
});
